use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use argon2::{
    Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString,
};
use rusqlite::{Connection, OpenFlags};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::database::connection::open_existing_database;
use crate::domain::security::{AccessError, AccessSnapshot, ConfigurePasswordRequest};
use crate::repositories::security::SecurityRepository;
use crate::services::backup::BackupService;

#[derive(Default)]
struct AccessSession {
    failed_attempts: u8,
    retry_at: Option<Instant>,
    backup_password: Option<Zeroizing<String>>,
}

#[derive(Default)]
struct AccessInner {
    unlocked: AtomicBool,
    session: Mutex<AccessSession>,
}

#[derive(Clone, Default)]
pub struct AccessState(Arc<AccessInner>);

impl AccessState {
    pub fn is_unlocked(&self) -> bool {
        self.0.unlocked.load(Ordering::Acquire)
    }

    pub fn clear_backup_password(&self) {
        if let Ok(mut session) = self.0.session.lock() {
            session.backup_password = None;
        }
    }

    pub fn authorize_command(&self, command: &str) -> Result<(), AccessError> {
        if matches!(
            command,
            "get_access_status" | "unlock_app" | "show_main_window" | "exit_application"
        ) || self.is_unlocked()
        {
            Ok(())
        } else {
            Err(AccessError::Locked)
        }
    }
}

pub struct SecurityService {
    data_directory: PathBuf,
    database_path: PathBuf,
}

impl SecurityService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            data_directory: data_directory.to_path_buf(),
            database_path: data_directory.join("database").join("notex.db"),
        }
    }

    pub fn status(&self, state: &AccessState) -> Result<AccessSnapshot, AccessError> {
        let mut session = state
            .0
            .session
            .lock()
            .map_err(|_| AccessError::ReadFailed)?;
        let hash = self.read_hash()?;
        if let Some(hash) = &hash {
            validate_hash(hash)?;
        } else {
            session.backup_password = None;
            state.0.unlocked.store(true, Ordering::Release);
        }
        Ok(AccessSnapshot {
            password_enabled: hash.is_some(),
            locked: !state.is_unlocked(),
        })
    }

    pub fn unlock(
        &self,
        state: &AccessState,
        password: &str,
    ) -> Result<AccessSnapshot, AccessError> {
        let mut session = state
            .0
            .session
            .lock()
            .map_err(|_| AccessError::ReadFailed)?;
        let hash = self.read_hash()?.ok_or(AccessError::ReadFailed)?;
        verify_password(&mut session, password, &hash)?;
        let mut connection =
            open_existing_database(&self.database_path).map_err(|_| AccessError::ReadFailed)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| AccessError::ReadFailed)?;
        if SecurityRepository::password_hash(&transaction)?.as_deref() != Some(&hash) {
            return Err(AccessError::IncorrectPassword);
        }
        BackupService::new(&self.data_directory)
            .ensure_encrypted(password)
            .map_err(|_| AccessError::BackupSyncFailed)?;
        transaction.commit().map_err(|_| AccessError::ReadFailed)?;
        session.backup_password = Some(Zeroizing::new(password.to_owned()));
        state.0.unlocked.store(true, Ordering::Release);
        Ok(AccessSnapshot {
            password_enabled: true,
            locked: false,
        })
    }

    pub fn configure(
        &self,
        state: &AccessState,
        request: &ConfigurePasswordRequest,
    ) -> Result<AccessSnapshot, AccessError> {
        let mut session = state
            .0
            .session
            .lock()
            .map_err(|_| AccessError::ReadFailed)?;
        if !state.is_unlocked() {
            return Err(AccessError::Locked);
        }
        let mut connection =
            open_existing_database(&self.database_path).map_err(|_| AccessError::SaveFailed)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| AccessError::SaveFailed)?;
        let current_hash = SecurityRepository::password_hash(&transaction)?;
        if let Some(hash) = &current_hash {
            verify_password(
                &mut session,
                request.current_password.as_deref().unwrap_or(""),
                hash,
            )?;
        }
        let hash = request
            .new_password
            .as_deref()
            .map(hash_password)
            .transpose()?;
        let backup = BackupService::new(&self.data_directory);
        let old_password = if current_hash.is_some() {
            request.current_password.as_deref()
        } else {
            None
        };
        backup
            .recover_pending_update(old_password)
            .map_err(|_| AccessError::BackupSyncFailed)?;
        let now = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|_| AccessError::SaveFailed)?;
        SecurityRepository::stage_password_hash(&transaction, hash.as_deref(), &now)?;
        let mut backup_update = backup
            .prepare_password_change(old_password, request.new_password.as_deref())
            .map_err(|_| AccessError::BackupSyncFailed)?;
        if let Some(update) = &mut backup_update {
            update.apply().map_err(|_| AccessError::BackupSyncFailed)?;
        }
        if transaction.commit().is_err() {
            if let Some(update) = &mut backup_update {
                update
                    .rollback()
                    .map_err(|_| AccessError::BackupSyncFailed)?;
            }
            return Err(AccessError::SaveFailed);
        }
        if let Some(update) = &mut backup_update {
            if update.finish().is_err() {
                let rollback = update.rollback();
                let restore = SecurityRepository::save_password_hash(
                    &mut connection,
                    current_hash.as_deref(),
                    &now,
                );
                rollback.map_err(|_| AccessError::BackupSyncFailed)?;
                restore?;
                return Err(AccessError::BackupSyncFailed);
            }
        }
        session.backup_password = request
            .new_password
            .as_ref()
            .map(|password| Zeroizing::new(password.clone()));
        Ok(AccessSnapshot {
            password_enabled: hash.is_some(),
            locked: false,
        })
    }

    pub fn create_exit_backup(&self, state: &AccessState) -> Result<(), AccessError> {
        let session = state
            .0
            .session
            .lock()
            .map_err(|_| AccessError::ReadFailed)?;
        if !state.is_unlocked() {
            return Err(AccessError::Locked);
        }
        let mut connection =
            open_existing_database(&self.database_path).map_err(|_| AccessError::ReadFailed)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| AccessError::ReadFailed)?;
        let hash = SecurityRepository::password_hash(&transaction)?;
        let password = match &hash {
            Some(hash) => {
                let password = session
                    .backup_password
                    .as_ref()
                    .ok_or(AccessError::Locked)?;
                let parsed = validate_hash(hash)?;
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .map_err(|_| AccessError::BackupSyncFailed)?;
                Some(password.as_str())
            }
            None => None,
        };
        BackupService::new(&self.data_directory)
            .create_latest(password)
            .map_err(|_| AccessError::BackupSyncFailed)?;
        transaction.commit().map_err(|_| AccessError::ReadFailed)
    }

    fn read_hash(&self) -> Result<Option<String>, AccessError> {
        if !self
            .database_path
            .try_exists()
            .map_err(|_| AccessError::ReadFailed)?
        {
            return Ok(None);
        }
        // 解锁前只读密码配置；不创建数据库、不恢复草稿、不访问笔记内容。
        let connection =
            Connection::open_with_flags(&self.database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| AccessError::ReadFailed)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| AccessError::ReadFailed)?;
        SecurityRepository::password_hash(&connection)
    }
}

fn hash_password(password: &str) -> Result<String, AccessError> {
    let length = password.chars().count();
    if !(4..=20).contains(&length) || password.trim().is_empty() {
        return Err(AccessError::InvalidPassword);
    }
    let salt =
        SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|_| AccessError::SaveFailed)?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| AccessError::SaveFailed)
}

fn validate_hash(hash: &str) -> Result<PasswordHash<'_>, AccessError> {
    let parsed = PasswordHash::new(hash).map_err(|_| AccessError::ReadFailed)?;
    let params = Params::try_from(&parsed).map_err(|_| AccessError::ReadFailed)?;
    // 仅接受本应用写入的参数，损坏或异常参数不得关闭保护或触发超量计算。
    if parsed.algorithm.as_str() != "argon2id"
        || parsed.version != Some(19)
        || params.m_cost() != Params::DEFAULT_M_COST
        || params.t_cost() != Params::DEFAULT_T_COST
        || params.p_cost() != Params::DEFAULT_P_COST
        || parsed.salt.is_none()
        || parsed
            .hash
            .is_none_or(|output| output.len() != Params::DEFAULT_OUTPUT_LEN)
    {
        return Err(AccessError::ReadFailed);
    }
    Ok(parsed)
}

fn verify_password(
    session: &mut AccessSession,
    password: &str,
    hash: &str,
) -> Result<(), AccessError> {
    let now = Instant::now();
    if let Some(retry_at) = session.retry_at {
        if now < retry_at {
            return Err(AccessError::TooManyAttempts);
        }
        session.retry_at = None;
        session.failed_attempts = 0;
    }
    let parsed = validate_hash(hash)?;
    // 已保存的旧密码仍可验证，避免收紧新密码长度后无法解锁或修改密码。
    if password.chars().count() > 128 {
        return Err(AccessError::InvalidPassword);
    }
    match Argon2::default().verify_password(password.as_bytes(), &parsed) {
        Ok(()) => {
            session.failed_attempts = 0;
            session.retry_at = None;
            Ok(())
        }
        Err(argon2::password_hash::Error::Password) => {
            session.failed_attempts += 1;
            if session.failed_attempts >= 5 {
                session.retry_at = Some(Instant::now() + Duration::from_secs(30));
                return Err(AccessError::TooManyAttempts);
            }
            Err(AccessError::IncorrectPassword)
        }
        Err(_) => Err(AccessError::ReadFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::connection::open_database;
    use crate::repositories::bootstrap::BootstrapRepository;

    fn fixture() -> Result<(SecurityService, PathBuf), Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!("notex-security-{}", Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("database"))?;
        BootstrapRepository::initialize(&directory.join("database/notex.db"))?;
        Ok((SecurityService::new(&directory), directory))
    }

    fn request(current: Option<&str>, new: Option<&str>) -> ConfigurePasswordRequest {
        ConfigurePasswordRequest {
            current_password: current.map(str::to_owned),
            new_password: new.map(str::to_owned),
        }
    }

    #[test]
    fn denies_business_commands_until_password_status_has_been_checked()
    -> Result<(), Box<dyn std::error::Error>> {
        let state = AccessState::default();
        for command in [
            "bootstrap_app",
            "list_notes",
            "search_notes",
            "read_note_image",
            "get_settings",
            "export_notes",
            "open_data_directory",
            "configure_startup_password",
            "future_data_command",
        ] {
            assert!(matches!(
                state.authorize_command(command),
                Err(AccessError::Locked)
            ));
        }
        for command in [
            "get_access_status",
            "unlock_app",
            "show_main_window",
            "exit_application",
        ] {
            state.authorize_command(command)?;
        }
        let directory = std::env::temp_dir().join(format!("notex-first-access-{}", Uuid::new_v4()));
        let snapshot = SecurityService::new(&directory).status(&state)?;
        assert!(!snapshot.password_enabled);
        assert!(!snapshot.locked);
        state.authorize_command("bootstrap_app")?;
        assert!(!directory.exists());
        Ok(())
    }

    #[test]
    fn password_lifecycle_requires_verification_and_locks_each_new_session()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, directory) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        assert!(
            service
                .configure(&state, &request(None, Some("  开启密码🔒  ")))?
                .password_enabled
        );
        assert!(state.is_unlocked());
        let database = Connection::open(&service.database_path)?;
        let first_hash = SecurityRepository::password_hash(&database)?.ok_or("missing hash")?;
        assert!(first_hash.starts_with("$argon2id$"));
        assert!(!first_hash.contains("开启密码"));

        let restarted = AccessState::default();
        assert!(SecurityService::new(&directory).status(&restarted)?.locked);
        assert!(matches!(
            service.configure(&restarted, &request(None, None)),
            Err(AccessError::Locked)
        ));
        assert!(matches!(
            service.unlock(&restarted, "开启密码🔒"),
            Err(AccessError::IncorrectPassword)
        ));
        assert!(!restarted.is_unlocked());
        service.unlock(&restarted, "  开启密码🔒  ")?;
        restarted.authorize_command("list_notes")?;
        assert!(matches!(
            service.configure(&restarted, &request(Some("wrong"), None)),
            Err(AccessError::IncorrectPassword)
        ));
        assert_eq!(
            SecurityRepository::password_hash(&database)?,
            Some(first_hash)
        );
        service.configure(
            &restarted,
            &request(Some("  开启密码🔒  "), Some("新的密码123")),
        )?;

        let changed = AccessState::default();
        assert!(service.status(&changed)?.locked);
        assert!(matches!(
            service.unlock(&changed, "  开启密码🔒  "),
            Err(AccessError::IncorrectPassword)
        ));
        service.unlock(&changed, "新的密码123")?;
        assert!(
            !service
                .configure(&changed, &request(Some("新的密码123"), None))?
                .password_enabled
        );
        let disabled = service.status(&AccessState::default())?;
        assert!(!disabled.locked);
        assert!(!disabled.password_enabled);
        assert!(SecurityRepository::password_hash(&database)?.is_none());
        Ok(())
    }

    #[test]
    fn validates_passwords_and_uses_a_new_random_salt() -> Result<(), Box<dyn std::error::Error>> {
        for password in ["", "123", "    ", &"密".repeat(21)] {
            assert!(matches!(
                hash_password(password),
                Err(AccessError::InvalidPassword)
            ));
        }
        let first = hash_password("相同密码123")?;
        let second = hash_password("相同密码123")?;
        assert_ne!(first, second);
        validate_hash(&first)?;
        for password in ["1234", &"🔒".repeat(20)] {
            verify_password(
                &mut AccessSession::default(),
                password,
                &hash_password(password)?,
            )?;
        }
        Ok(())
    }

    #[test]
    fn existing_long_password_can_unlock_and_be_changed_to_four_characters()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, _) = fixture()?;
        let old_password = "密".repeat(128);
        let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes())
            .map_err(|_| AccessError::SaveFailed)?;
        let old_hash = Argon2::default()
            .hash_password(old_password.as_bytes(), &salt)
            .map_err(|_| AccessError::SaveFailed)?
            .to_string();
        let mut database = Connection::open(&service.database_path)?;
        SecurityRepository::save_password_hash(&mut database, Some(&old_hash), "now")?;
        let state = AccessState::default();
        assert!(service.status(&state)?.locked);
        service.unlock(&state, &old_password)?;
        service.configure(&state, &request(Some(&old_password), Some("1234")))?;
        let restarted = AccessState::default();
        assert!(service.status(&restarted)?.locked);
        assert!(!service.unlock(&restarted, "1234")?.locked);
        Ok(())
    }

    #[test]
    fn corrupted_password_config_fails_closed_without_returning_sensitive_details()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, _) = fixture()?;
        let mut database = Connection::open(&service.database_path)?;
        for hash in [
            "",
            "corrupt-private-value",
            "$argon2id$v=19$m=4294967295,t=2,p=1$c29tZXNhbHQ$YWJj",
        ] {
            SecurityRepository::save_password_hash(&mut database, Some(hash), "now")?;
            let state = AccessState::default();
            assert!(matches!(
                service.status(&state),
                Err(AccessError::ReadFailed)
            ));
            assert!(!state.is_unlocked());
            assert!(matches!(
                service.unlock(&state, "123456"),
                Err(AccessError::ReadFailed)
            ));
        }
        Ok(())
    }

    #[test]
    fn repeated_failures_apply_a_cooldown_that_status_checks_cannot_reset()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, _) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        service.configure(&state, &request(None, Some("123456")))?;
        let restarted = AccessState::default();
        for _ in 0..4 {
            assert!(matches!(
                service.unlock(&restarted, "wrong"),
                Err(AccessError::IncorrectPassword)
            ));
        }
        assert!(matches!(
            service.unlock(&restarted, "wrong"),
            Err(AccessError::TooManyAttempts)
        ));
        assert!(service.status(&restarted)?.locked);
        assert!(matches!(
            service.unlock(&restarted, "123456"),
            Err(AccessError::TooManyAttempts)
        ));
        {
            let mut session = restarted
                .0
                .session
                .lock()
                .map_err(|_| "session lock failed")?;
            session.retry_at = Some(Instant::now() - Duration::from_secs(1));
        }
        assert!(!service.unlock(&restarted, "123456")?.locked);
        Ok(())
    }

    #[test]
    fn failed_validation_preserves_the_existing_password() -> Result<(), Box<dyn std::error::Error>>
    {
        let (service, _) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        service.configure(&state, &request(None, Some("123456")))?;
        assert!(matches!(
            service.configure(&state, &request(Some("123456"), Some("123"))),
            Err(AccessError::InvalidPassword)
        ));
        let restarted = AccessState::default();
        assert!(service.status(&restarted)?.locked);
        service.unlock(&restarted, "123456")?;
        Ok(())
    }

    #[test]
    fn automatically_synchronizes_existing_and_future_backups_with_password_changes()
    -> Result<(), Box<dyn std::error::Error>> {
        use zip::ZipArchive;
        let (service, directory) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        service.create_exit_backup(&state)?;
        let path = directory.join("backups/NoteX-latest.zip");
        service.configure(&state, &request(None, Some("1234")))?;
        let mut archive = ZipArchive::new(std::fs::File::open(&path)?)?;
        assert!(archive.by_index(0).is_err());
        assert!(archive.by_index_decrypt(0, b"1234").is_ok());
        drop(archive);
        let restarted = AccessState::default();
        assert!(service.status(&restarted)?.locked);
        assert!(service.create_exit_backup(&restarted).is_err());
        service.unlock(&restarted, "1234")?;
        service.create_exit_backup(&restarted)?;
        service.configure(&restarted, &request(Some("1234"), Some("5678")))?;
        service.create_exit_backup(&restarted)?;
        let mut archive = ZipArchive::new(std::fs::File::open(&path)?)?;
        assert!(
            archive
                .by_index_decrypt(0, b"1234")
                .and_then(|mut entry| std::io::copy(&mut entry, &mut std::io::sink())
                    .map_err(zip::result::ZipError::Io))
                .is_err()
        );
        assert!(archive.by_index_decrypt(0, b"5678").is_ok());
        drop(archive);
        service.configure(&restarted, &request(Some("5678"), None))?;
        assert!(
            ZipArchive::new(std::fs::File::open(&path)?)?
                .by_index(0)
                .is_ok()
        );
        service.create_exit_backup(&restarted)?;
        assert!(ZipArchive::new(std::fs::File::open(&path)?)?.is_empty());
        assert!(
            restarted
                .0
                .session
                .lock()
                .map_err(|_| "session lock failed")?
                .backup_password
                .is_none()
        );
        assert_eq!(std::fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[test]
    fn database_commit_failure_restores_both_password_and_backup()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, directory) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        service.create_exit_backup(&state)?;
        let path = directory.join("backups/NoteX-latest.zip");
        let previous = std::fs::read(&path)?;
        let database = open_database(&service.database_path)?;
        database.execute_batch(
            "CREATE TABLE deferred_backup_failure (
              note_id TEXT REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED
            );
            CREATE TRIGGER fail_password_commit AFTER INSERT ON app_settings
            WHEN NEW.key = 'startup_password_hash'
            BEGIN
              INSERT INTO deferred_backup_failure (note_id) VALUES ('missing-note');
            END;",
        )?;
        assert!(matches!(
            service.configure(&state, &request(None, Some("1234"))),
            Err(AccessError::SaveFailed)
        ));
        assert!(SecurityRepository::password_hash(&database)?.is_none());
        assert_eq!(std::fs::read(path)?, previous);
        assert!(
            state
                .0
                .session
                .lock()
                .map_err(|_| "session lock failed")?
                .backup_password
                .is_none()
        );
        assert_eq!(std::fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[test]
    fn backup_failure_preserves_the_existing_password_and_archive()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, directory) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        service.configure(&state, &request(None, Some("1234")))?;
        service.create_exit_backup(&state)?;
        let database = open_database(&service.database_path)?;
        let hash = SecurityRepository::password_hash(&database)?;
        let path = directory.join("backups/NoteX-latest.zip");
        let previous = std::fs::read(&path)?;
        std::fs::create_dir(directory.join("backups/NoteX-latest.zip.part"))?;
        assert!(matches!(
            service.configure(&state, &request(Some("1234"), None)),
            Err(AccessError::BackupSyncFailed)
        ));
        assert_eq!(SecurityRepository::password_hash(&database)?, hash);
        assert_eq!(std::fs::read(path)?, previous);
        assert_eq!(
            state
                .0
                .session
                .lock()
                .map_err(|_| "session lock failed")?
                .backup_password
                .as_deref()
                .map(String::as_str),
            Some("1234")
        );
        Ok(())
    }

    #[test]
    fn stale_or_missing_session_password_never_creates_an_unencrypted_backup()
    -> Result<(), Box<dyn std::error::Error>> {
        let (service, directory) = fixture()?;
        let state = AccessState::default();
        service.status(&state)?;
        service.configure(&state, &request(None, Some("1234")))?;
        service.create_exit_backup(&state)?;
        let path = directory.join("backups/NoteX-latest.zip");
        let previous = std::fs::read(&path)?;
        state.clear_backup_password();
        assert!(matches!(
            service.create_exit_backup(&state),
            Err(AccessError::Locked)
        ));
        service.unlock(&state, "1234")?;
        let mut database = open_database(&service.database_path)?;
        SecurityRepository::save_password_hash(
            &mut database,
            Some(&hash_password("5678")?),
            "now",
        )?;
        assert!(matches!(
            service.create_exit_backup(&state),
            Err(AccessError::BackupSyncFailed)
        ));
        assert_eq!(std::fs::read(path)?, previous);
        Ok(())
    }

    #[test]
    fn exit_before_database_initialization_does_not_create_an_empty_database()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory =
            std::env::temp_dir().join(format!("notex-security-early-exit-{}", Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("database"))?;
        let service = SecurityService::new(&directory);
        let state = AccessState::default();
        assert!(!service.status(&state)?.locked);
        assert!(service.create_exit_backup(&state).is_err());
        assert!(!service.database_path.exists());
        assert!(!directory.join("backups").exists());
        Ok(())
    }
}

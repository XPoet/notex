use std::fs;
use std::path::{Path, PathBuf};

use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::domain::bootstrap::{BootstrapError, BootstrapSnapshot};
use crate::repositories::bootstrap::BootstrapRepository;
use crate::services::assets::AssetsService;
use crate::services::search::SearchService;

pub struct BootstrapService {
    data_directory: PathBuf,
}

impl BootstrapService {
    pub fn new(data_directory: PathBuf) -> Self {
        Self { data_directory }
    }

    pub fn bootstrap(&self) -> Result<BootstrapSnapshot, BootstrapError> {
        self.create_required_directories()?;
        let database_path = self.data_directory.join("database").join("notex.db");
        let schema_version = BootstrapRepository::initialize(&database_path)?;
        BootstrapRepository::restore_recovery_drafts(&database_path, &current_time()?)?;
        SearchService::new(&self.data_directory)
            .rebuild()
            .map_err(|_| BootstrapError::MigrationFailed)?;
        let _ = AssetsService::new(&self.data_directory).cleanup_pending();

        Ok(BootstrapSnapshot {
            status: "ready",
            schema_version,
        })
    }

    fn create_required_directories(&self) -> Result<(), BootstrapError> {
        for directory_name in ["database", "assets", "temp", "logs", "config"] {
            fs::create_dir_all(self.data_directory.join(directory_name))
                .map_err(map_directory_error)?;
        }
        verify_directory_writable(&self.data_directory)
    }
}

fn current_time() -> Result<String, BootstrapError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| BootstrapError::BootstrapFailed)
}

fn verify_directory_writable(directory: &Path) -> Result<(), BootstrapError> {
    let metadata = fs::metadata(directory).map_err(map_directory_error)?;
    if metadata.permissions().readonly() {
        return Err(BootstrapError::DataDirectoryNotWritable);
    }
    Ok(())
}

fn map_directory_error(error: std::io::Error) -> BootstrapError {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => BootstrapError::DataDirectoryNotWritable,
        _ => BootstrapError::DataDirectoryUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use rusqlite::{Connection, params};

    use crate::services::notes::NotesService;

    use super::BootstrapService;

    fn test_data_directory() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        std::env::temp_dir().join(format!("notex-bootstrap-{timestamp}"))
    }

    #[test]
    fn initializes_required_directories_and_applies_migration_idempotently()
    -> Result<(), Box<dyn std::error::Error>> {
        let data_directory = test_data_directory();
        let service = BootstrapService::new(data_directory.clone());

        let first_snapshot = service.bootstrap()?;
        let second_snapshot = service.bootstrap()?;

        assert_eq!(first_snapshot.status, "ready");
        assert_eq!(first_snapshot.schema_version, 3);
        assert_eq!(second_snapshot.schema_version, 3);
        for directory_name in ["database", "assets", "temp", "logs", "config"] {
            assert!(data_directory.join(directory_name).is_dir());
        }

        let database = Connection::open(data_directory.join("database").join("notex.db"))?;
        let migration_count: u32 =
            database.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })?;
        let table_count: u32 = database.query_row(
      "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('notes', 'categories', 'tags', 'assets', 'app_settings', 'recovery_drafts', 'asset_cleanup_queue', 'notes_fts')",
      [],
      |row| row.get(0),
    )?;
        assert_eq!(migration_count, 3);
        assert_eq!(table_count, 8);

        Ok(())
    }

    #[test]
    fn restores_newer_recovery_drafts_before_rebuilding_the_search_index()
    -> Result<(), Box<dyn std::error::Error>> {
        let data_directory = test_data_directory();
        let service = BootstrapService::new(data_directory.clone());
        service.bootstrap()?;
        let notes = NotesService::new(&data_directory);
        let note = notes.create()?;
        notes.save(&note.id, "已保存标题", "已保存正文")?;
        notes.save_recovery_draft(&note.id, "恢复标题", "异常退出前的草稿", "NOTE_SAVE_FAILED")?;

        service.bootstrap()?;

        let restored = notes.get(&note.id)?;
        assert_eq!(restored.title, "恢复标题");
        assert_eq!(restored.content, "异常退出前的草稿");
        let database = Connection::open(data_directory.join("database").join("notex.db"))?;
        let recovery_count: u32 = database.query_row(
            "SELECT COUNT(*) FROM recovery_drafts WHERE note_id = ?1",
            [&note.id],
            |row| row.get(0),
        )?;
        assert_eq!(recovery_count, 0);
        assert_eq!(
            crate::services::search::SearchService::new(&data_directory)
                .search("异常退出", None, None)?
                .total,
            1
        );
        Ok(())
    }

    #[test]
    fn performance_cold_start_rebuilds_a_ten_thousand_note_index_within_target_duration()
    -> Result<(), Box<dyn std::error::Error>> {
        let data_directory = test_data_directory();
        let service = BootstrapService::new(data_directory.clone());
        service.bootstrap()?;
        let database_path = data_directory.join("database").join("notex.db");
        let mut database = Connection::open(&database_path)?;
        let transaction = database.transaction()?;
        for index in 0..10_000 {
            transaction.execute(
                "INSERT INTO notes (id, title, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![
                    format!("note-{index}"),
                    format!("性能笔记 {index}"),
                    "离线笔记性能夹具正文。",
                    "2026-07-26T00:00:00Z"
                ],
            )?;
        }
        transaction.commit()?;

        let start = Instant::now();
        service.bootstrap()?;

        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(2));
        eprintln!("10,000 条性能夹具：冷启动 {} ms。", elapsed.as_millis());
        Ok(())
    }
}

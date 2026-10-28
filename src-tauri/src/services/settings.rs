use std::path::{Path, PathBuf};

use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::database::connection::open_database;
use crate::domain::settings::{SaveSettingsRequest, SettingsError, SettingsSnapshot};
use crate::repositories::settings::SettingsRepository;

pub struct SettingsService {
    data_directory: PathBuf,
    database_path: PathBuf,
    desktop_directory: PathBuf,
}

impl SettingsService {
    pub fn new(data_directory: &Path, desktop_directory: &Path) -> Self {
        Self {
            data_directory: data_directory.to_path_buf(),
            database_path: data_directory.join("database").join("notex.db"),
            desktop_directory: desktop_directory.to_path_buf(),
        }
    }

    pub fn get(&self, app_version: &str) -> Result<SettingsSnapshot, SettingsError> {
        let connection =
            open_database(&self.database_path).map_err(|_| SettingsError::ReadFailed)?;
        snapshot(
            &connection,
            app_version,
            &self.data_directory,
            &self.desktop_directory,
        )
    }

    pub fn save(
        &self,
        request: &SaveSettingsRequest,
        app_version: &str,
    ) -> Result<SettingsSnapshot, SettingsError> {
        validate_request(request)?;
        let default_directory = match request.default_export_directory.as_ref() {
            None => None,
            Some(None) => Some(None),
            Some(Some(directory)) => Some(Some(validate_export_directory(directory)?)),
        };
        let mut connection =
            open_database(&self.database_path).map_err(|_| SettingsError::SaveFailed)?;
        SettingsRepository::save(
            &mut connection,
            request,
            default_directory
                .as_ref()
                .map(|directory| directory.as_deref()),
            &current_time()?,
        )?;
        snapshot(
            &connection,
            app_version,
            &self.data_directory,
            &self.desktop_directory,
        )
    }
}

fn snapshot(
    connection: &rusqlite::Connection,
    app_version: &str,
    data_directory: &Path,
    desktop_directory: &Path,
) -> Result<SettingsSnapshot, SettingsError> {
    let values = SettingsRepository::read_values(connection)?;
    let configured_directory = values
        .get("default_export_directory")
        .and_then(|path| valid_export_directory_path(Path::new(path)));
    let (default_export_directory, has_custom_default_export_directory) = match configured_directory
    {
        Some(directory) => (directory, true),
        None => (
            validate_export_directory(&desktop_directory.to_string_lossy())?,
            false,
        ),
    };
    Ok(SettingsSnapshot {
        language: SettingsRepository::language(&values),
        theme: SettingsRepository::theme(&values),
        note_sort: SettingsRepository::note_sort(connection)?,
        editor_font_size: SettingsRepository::editor_font_size(&values),
        show_category_counts: SettingsRepository::show_category_counts(&values),
        data_directory: data_directory.to_string_lossy().into_owned(),
        default_export_directory,
        has_custom_default_export_directory,
        app_version: app_version.to_owned(),
        schema_version: SettingsRepository::schema_version(connection)?,
    })
}

fn validate_request(request: &SaveSettingsRequest) -> Result<(), SettingsError> {
    if !(14..=18).contains(&request.editor_font_size) {
        return Err(SettingsError::ValidationFailed);
    }
    Ok(())
}

fn validate_export_directory(value: &str) -> Result<String, SettingsError> {
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_dir() {
        return Err(SettingsError::DirectoryUnavailable);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| SettingsError::DirectoryUnavailable)?;
    let metadata = canonical
        .metadata()
        .map_err(|_| SettingsError::DirectoryUnavailable)?;
    if metadata.permissions().readonly() {
        return Err(SettingsError::DirectoryNotWritable);
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn valid_export_directory_path(path: &Path) -> Option<String> {
    validate_export_directory(&path.to_string_lossy()).ok()
}

fn current_time() -> Result<String, SettingsError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| SettingsError::SaveFailed)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::repositories::bootstrap::BootstrapRepository;
    use crate::{
        domain::settings::{AppLanguage, NoteSort, ThemePreference},
        services::settings::SettingsService,
    };

    use super::SaveSettingsRequest;

    fn data_directory() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-settings-{stamp}"));
        let _ = std::fs::create_dir_all(directory.join("database"));
        directory
    }

    #[test]
    fn saves_and_reads_allowed_preferences() -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let service = SettingsService::new(&directory, &directory);
        let snapshot = service.save(
            &SaveSettingsRequest {
                language: AppLanguage::English,
                theme: ThemePreference::Dark,
                note_sort: NoteSort::Title,
                editor_font_size: 17,
                show_category_counts: false,
                default_export_directory: Some(Some(directory.to_string_lossy().into_owned())),
            },
            "0.1.0",
        )?;
        assert_eq!(snapshot.theme, ThemePreference::Dark);
        assert_eq!(snapshot.language, Some(AppLanguage::English));
        assert_eq!(snapshot.note_sort, NoteSort::Title);
        assert_eq!(snapshot.editor_font_size, 17);
        assert!(!snapshot.show_category_counts);
        assert_eq!(snapshot.data_directory, directory.to_string_lossy());
        assert_eq!(
            snapshot.default_export_directory,
            directory.canonicalize()?.to_string_lossy()
        );
        assert!(snapshot.has_custom_default_export_directory);
        assert_eq!(service.get("0.1.0")?.editor_font_size, 17);
        Ok(())
    }

    #[test]
    fn uses_desktop_directory_when_no_custom_export_directory_is_saved()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        let desktop_directory = directory.join("Desktop");
        std::fs::create_dir_all(&desktop_directory)?;
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let snapshot = SettingsService::new(&directory, &desktop_directory).get("0.1.0")?;

        assert_eq!(
            snapshot.default_export_directory,
            desktop_directory.canonicalize()?.to_string_lossy()
        );
        assert!(!snapshot.has_custom_default_export_directory);
        assert_eq!(snapshot.language, None);
        Ok(())
    }

    #[test]
    fn persists_each_language_without_changing_the_schema() -> Result<(), Box<dyn std::error::Error>>
    {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let service = SettingsService::new(&directory, &directory);
        for language in [
            AppLanguage::SimplifiedChinese,
            AppLanguage::TraditionalChinese,
            AppLanguage::English,
        ] {
            service.save(
                &SaveSettingsRequest {
                    language,
                    theme: ThemePreference::System,
                    note_sort: NoteSort::UpdatedAt,
                    editor_font_size: 15,
                    show_category_counts: true,
                    default_export_directory: None,
                },
                "0.1.0",
            )?;
            let restored = SettingsService::new(&directory, &directory).get("0.1.0")?;
            assert_eq!(restored.language, Some(language));
            assert_eq!(restored.schema_version, 3);
        }
        Ok(())
    }
}

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::settings::{
    AppLanguage, NoteSort, SaveSettingsRequest, SettingsError, ThemePreference,
};

pub struct SettingsRepository;

impl SettingsRepository {
    pub fn read_values(connection: &Connection) -> Result<HashMap<String, String>, SettingsError> {
        let mut statement = connection
            .prepare("SELECT key, value FROM app_settings")
            .map_err(|_| SettingsError::ReadFailed)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| SettingsError::ReadFailed)?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(|_| SettingsError::ReadFailed)
    }

    pub fn note_sort(connection: &Connection) -> Result<NoteSort, SettingsError> {
        let value = connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'note_sort'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| SettingsError::ReadFailed)?;
        Ok(value
            .as_deref()
            .map_or(NoteSort::UpdatedAt, NoteSort::from_stored))
    }

    pub fn save(
        connection: &mut Connection,
        request: &SaveSettingsRequest,
        default_export_directory: Option<Option<&str>>,
        now: &str,
    ) -> Result<(), SettingsError> {
        let transaction = connection
            .transaction()
            .map_err(|_| SettingsError::SaveFailed)?;
        for (key, value) in [
            ("language", request.language.as_str()),
            ("theme", request.theme.as_str()),
            ("note_sort", request.note_sort.as_str()),
            ("editor_font_size", &request.editor_font_size.to_string()),
            (
                "show_category_counts",
                if request.show_category_counts {
                    "true"
                } else {
                    "false"
                },
            ),
        ] {
            transaction
                .execute(
                    "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    params![key, value, now],
                )
                .map_err(|_| SettingsError::SaveFailed)?;
        }
        if let Some(directory) = default_export_directory {
            match directory {
                Some(path) => transaction
                    .execute(
                        "INSERT INTO app_settings (key, value, updated_at) VALUES ('default_export_directory', ?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        params![path, now],
                    )
                    .map_err(|_| SettingsError::SaveFailed)?,
                None => transaction
                    .execute("DELETE FROM app_settings WHERE key = 'default_export_directory'", [])
                    .map_err(|_| SettingsError::SaveFailed)?,
            };
        }
        transaction.commit().map_err(|_| SettingsError::SaveFailed)
    }

    pub fn schema_version(connection: &Connection) -> Result<u32, SettingsError> {
        connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .map_err(|_| SettingsError::ReadFailed)
    }

    pub fn theme(values: &HashMap<String, String>) -> ThemePreference {
        values
            .get("theme")
            .map_or(ThemePreference::System, |value| {
                ThemePreference::from_stored(value)
            })
    }

    pub fn language(values: &HashMap<String, String>) -> Option<AppLanguage> {
        values
            .get("language")
            .and_then(|value| AppLanguage::from_stored(value))
    }

    pub fn editor_font_size(values: &HashMap<String, String>) -> u8 {
        values
            .get("editor_font_size")
            .and_then(|value| value.parse::<u8>().ok())
            .filter(|value| (14..=18).contains(value))
            .unwrap_or(15)
    }

    pub fn show_category_counts(values: &HashMap<String, String>) -> bool {
        values
            .get("show_category_counts")
            .map(|value| value == "true")
            .unwrap_or(true)
    }
}

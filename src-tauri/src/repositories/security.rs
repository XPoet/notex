use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::security::AccessError;

pub struct SecurityRepository;

impl SecurityRepository {
    pub fn password_hash(connection: &Connection) -> Result<Option<String>, AccessError> {
        connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'startup_password_hash'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| AccessError::ReadFailed)
    }

    pub fn save_password_hash(
        connection: &mut Connection,
        hash: Option<&str>,
        now: &str,
    ) -> Result<(), AccessError> {
        let transaction = connection
            .transaction()
            .map_err(|_| AccessError::SaveFailed)?;
        match hash {
            Some(value) => {
                transaction.execute(
          "INSERT INTO app_settings (key, value, updated_at) VALUES ('startup_password_hash', ?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          params![value, now],
        ).map_err(|_| AccessError::SaveFailed)?;
            }
            None => {
                transaction
                    .execute(
                        "DELETE FROM app_settings WHERE key = 'startup_password_hash'",
                        [],
                    )
                    .map_err(|_| AccessError::SaveFailed)?;
            }
        }
        transaction.commit().map_err(|_| AccessError::SaveFailed)
    }
}

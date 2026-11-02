use std::path::Path;

use rusqlite::{Connection, params};

use crate::database::connection::open_database;
use crate::database::migrations::apply_migrations;
use crate::domain::bootstrap::BootstrapError;

pub struct BootstrapRepository;

impl BootstrapRepository {
    pub fn initialize(database_path: &Path) -> Result<u32, BootstrapError> {
        let mut connection: Connection = open_database(database_path)?;
        apply_migrations(&mut connection)
    }

    pub fn restore_recovery_drafts(database_path: &Path, now: &str) -> Result<u32, BootstrapError> {
        let mut connection = open_database(database_path)?;
        let transaction = connection
            .transaction()
            .map_err(BootstrapError::migration_failed)?;
        let mut statement = transaction
            .prepare(
                "SELECT recovery_drafts.note_id
                 FROM recovery_drafts
                 INNER JOIN notes ON notes.id = recovery_drafts.note_id
                 WHERE notes.is_deleted = 0 AND recovery_drafts.updated_at >= notes.updated_at",
            )
            .map_err(BootstrapError::migration_failed)?;
        let note_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(BootstrapError::migration_failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(BootstrapError::migration_failed)?;
        drop(statement);

        for note_id in &note_ids {
            let content: String = transaction
                .query_row(
                    "SELECT content FROM recovery_drafts WHERE note_id = ?1",
                    params![note_id],
                    |row| row.get(0),
                )
                .map_err(BootstrapError::migration_failed)?;
            transaction
                .execute(
                    "UPDATE notes
                     SET title = (SELECT title FROM recovery_drafts WHERE note_id = ?1),
                         content = (SELECT content FROM recovery_drafts WHERE note_id = ?1),
                         content_preview = ?3,
                         updated_at = ?2
                     WHERE id = ?1 AND is_deleted = 0",
                    params![
                        note_id,
                        now,
                        crate::repositories::notes::content_preview(&content)
                    ],
                )
                .map_err(BootstrapError::migration_failed)?;
            crate::repositories::search::SearchRepository::refresh_note_in_transaction(
                &transaction,
                note_id,
            )
            .map_err(|_| BootstrapError::BootstrapFailed)?;
            transaction
                .execute(
                    "DELETE FROM recovery_drafts WHERE note_id = ?1",
                    params![note_id],
                )
                .map_err(BootstrapError::migration_failed)?;
        }
        transaction
            .execute(
                "DELETE FROM recovery_drafts
                 WHERE EXISTS (
                   SELECT 1 FROM notes
                   WHERE notes.id = recovery_drafts.note_id
                     AND notes.updated_at > recovery_drafts.updated_at
                 )",
                [],
            )
            .map_err(BootstrapError::migration_failed)?;
        transaction
            .commit()
            .map_err(BootstrapError::migration_failed)?;
        u32::try_from(note_ids.len()).map_err(|_| BootstrapError::BootstrapFailed)
    }
}

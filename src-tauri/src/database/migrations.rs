use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::bootstrap::BootstrapError;

struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: [Migration; 4] = [
    Migration {
        version: 1,
        name: "V001__initial_schema",
        sql: include_str!("../../migrations/V001__initial_schema.sql"),
    },
    Migration {
        version: 2,
        name: "V002__asset_cleanup_queue",
        sql: include_str!("../../migrations/V002__asset_cleanup_queue.sql"),
    },
    Migration {
        version: 3,
        name: "V003__add_note_search",
        sql: include_str!("../../migrations/V003__add_note_search.sql"),
    },
    Migration {
        version: 4,
        name: "V004__note_summaries_and_search_documents",
        sql: include_str!("../../migrations/V004__note_summaries_and_search_documents.sql"),
    },
];
const LATEST_SCHEMA_VERSION: u32 = 4;

pub fn apply_migrations(connection: &mut Connection) -> Result<u32, BootstrapError> {
    let applied_migrations = read_applied_migrations(connection)?;

    for migration in &MIGRATIONS {
        validate_applied_migration(migration, &applied_migrations)?;
        if applied_migrations
            .iter()
            .any(|(version, _)| *version == migration.version)
        {
            continue;
        }

        let transaction = connection
            .transaction()
            .map_err(BootstrapError::migration_failed)?;
        transaction
            .execute_batch(migration.sql)
            .map_err(BootstrapError::migration_failed)?;
        if migration.version == 4 {
            crate::repositories::notes::NotesRepository::backfill_previews(&transaction)
                .map_err(|_| BootstrapError::BootstrapFailed)?;
            crate::repositories::search::SearchRepository::rebuild_index_in_transaction(
                &transaction,
            )
            .map_err(|_| BootstrapError::BootstrapFailed)?;
        }
        transaction
            .execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![migration.version, migration.name, current_timestamp()],
            )
            .map_err(BootstrapError::migration_failed)?;
        transaction
            .commit()
            .map_err(BootstrapError::migration_failed)?;
    }

    Ok(LATEST_SCHEMA_VERSION)
}

fn read_applied_migrations(connection: &Connection) -> Result<Vec<(u32, String)>, BootstrapError> {
    let table_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(BootstrapError::migration_failed)?;

    if table_exists.is_none() {
        return Ok(Vec::new());
    }

    let mut statement = connection
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .map_err(BootstrapError::migration_failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(BootstrapError::migration_failed)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(BootstrapError::migration_failed)
}

fn validate_applied_migration(
    migration: &Migration,
    applied_migrations: &[(u32, String)],
) -> Result<(), BootstrapError> {
    for (version, name) in applied_migrations {
        if *version > LATEST_SCHEMA_VERSION {
            return Err(BootstrapError::migration_failed_message(
                "发现当前应用不支持的数据结构版本。",
            ));
        }
        if *version == migration.version && name != migration.name {
            return Err(BootstrapError::migration_failed_message(
                "数据结构版本记录不一致。",
            ));
        }
    }
    Ok(())
}

fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    format!("{seconds}")
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use super::{MIGRATIONS, apply_migrations};

    fn old_database() -> Result<Connection, Box<dyn std::error::Error>> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        for migration in MIGRATIONS.iter().take(3) {
            connection.execute_batch(migration.sql)?;
            connection.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, '0')",
                params![migration.version, migration.name],
            )?;
        }
        connection.execute_batch(
            "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES ('active', '旧笔记', '<b>历史</b>  正文', 'before', 'before');
             INSERT INTO notes (id, content, is_deleted, created_at, updated_at) VALUES ('trash', '回收内容', 1, 'before', 'before');
             INSERT INTO notes_fts (note_id, search_text) VALUES ('active', 'old index');",
        )?;
        Ok(connection)
    }

    #[test]
    fn upgrades_v3_without_changing_original_notes_and_builds_stable_documents()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut connection = old_database()?;
        assert_eq!(apply_migrations(&mut connection)?, 4);
        let original: (String, String, String, String) = connection.query_row(
            "SELECT title, content, content_preview, updated_at FROM notes WHERE id = 'active'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            original,
            (
                "旧笔记".to_owned(),
                "<b>历史</b>  正文".to_owned(),
                "历史 正文".to_owned(),
                "before".to_owned()
            )
        );
        assert_eq!(
            connection.query_row(
                "SELECT content_preview FROM notes WHERE id = 'trash'",
                [],
                |row| row.get::<_, String>(0)
            )?,
            "回收内容"
        );
        let document: (i64, i64) = connection.query_row(
            "SELECT document_id, notes_fts.rowid FROM note_search_documents JOIN notes_fts ON notes_fts.rowid = note_search_documents.document_id WHERE note_search_documents.note_id = 'active'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(document.0, document.1);
        assert_eq!(
            connection.query_row("SELECT COUNT(*) FROM notes_fts", [], |row| row
                .get::<_, u32>(0))?,
            1
        );
        assert_eq!(
            connection.query_row("SELECT version FROM search_index_state", [], |row| row
                .get::<_, u32>(0))?,
            1
        );
        assert_eq!(apply_migrations(&mut connection)?, 4);
        assert_eq!(
            connection.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row
                .get::<_, u32>(0))?,
            4
        );
        Ok(())
    }

    #[test]
    fn rolls_back_v4_schema_previews_and_index_when_backfill_fails()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut connection = old_database()?;
        connection.execute_batch("CREATE TRIGGER reject_preview BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'injected failure'); END;")?;
        assert!(apply_migrations(&mut connection).is_err());
        assert_eq!(
            connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                .get::<_, u32>(
                0
            ))?,
            3
        );
        assert_eq!(
            connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'content_preview'",
                [],
                |row| row.get::<_, u32>(0)
            )?,
            0
        );
        assert_eq!(
            connection.query_row(
                "SELECT search_text FROM notes_fts WHERE note_id = 'active'",
                [],
                |row| row.get::<_, String>(0)
            )?,
            "old index"
        );
        assert_eq!(
            connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'note_search_documents'",
                [],
                |row| row.get::<_, u32>(0)
            )?,
            0
        );
        Ok(())
    }
}

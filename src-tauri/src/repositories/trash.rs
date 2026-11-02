use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::trash::{TrashCleanupResult, TrashError, TrashedNoteSummary};

pub struct TrashRepository;

impl TrashRepository {
    pub fn trash(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        now: &str,
    ) -> Result<(), TrashError> {
        let category_id = transaction
            .query_row(
                "SELECT category_id FROM notes WHERE id = ?1 AND is_deleted = 0",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|_| TrashError::OperationFailed)?
            .ok_or(TrashError::NotFound)?;
        let category_path = category_id
            .as_deref()
            .map(|category_id| category_path(transaction, category_id))
            .transpose()?;
        transaction
            .execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?2,
             trashed_from_category_id = category_id, trashed_from_category_path = ?3
             WHERE id = ?1 AND is_deleted = 0",
                params![id, now, category_path],
            )
            .map_err(|_| TrashError::OperationFailed)?;
        Ok(())
    }

    pub fn list(connection: &Connection) -> Result<Vec<TrashedNoteSummary>, TrashError> {
        let mut statement = connection
            .prepare(
                "SELECT id, title, content_preview, deleted_at, trashed_from_category_path
             FROM notes WHERE is_deleted = 1 ORDER BY deleted_at DESC, id DESC",
            )
            .map_err(|_| TrashError::OperationFailed)?;
        let rows = statement
            .query_map([], |row| {
                let content: String = row.get(2)?;
                Ok(TrashedNoteSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content_preview: content,
                    deleted_at: row.get(3)?,
                    trashed_from_category_path: row.get(4)?,
                })
            })
            .map_err(|_| TrashError::OperationFailed)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| TrashError::OperationFailed)
    }

    pub fn restore(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        now: &str,
    ) -> Result<bool, TrashError> {
        let original_category_id = transaction
            .query_row(
                "SELECT trashed_from_category_id FROM notes WHERE id = ?1 AND is_deleted = 1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|_| TrashError::OperationFailed)?
            .ok_or(TrashError::NotFound)?;
        let category_exists = match original_category_id.as_deref() {
            Some(category_id) => transaction
                .query_row(
                    "SELECT 1 FROM categories WHERE id = ?1",
                    params![category_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|_| TrashError::OperationFailed)?
                .is_some(),
            None => false,
        };
        transaction
            .execute(
                "UPDATE notes SET is_deleted = 0, deleted_at = NULL,
             category_id = CASE WHEN ?2 = 1 THEN trashed_from_category_id ELSE NULL END,
             trashed_from_category_id = NULL, trashed_from_category_path = NULL, updated_at = ?3
             WHERE id = ?1 AND is_deleted = 1",
                params![id, if category_exists { 1 } else { 0 }, now],
            )
            .map_err(|_| TrashError::OperationFailed)?;
        Ok(original_category_id.is_some() && !category_exists)
    }

    pub fn permanently_delete(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        now: &str,
    ) -> Result<TrashCleanupResult, TrashError> {
        let exists = transaction
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1 AND is_deleted = 1",
                params![id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| TrashError::OperationFailed)?
            .is_some();
        if !exists {
            return Err(TrashError::NotFound);
        }
        transaction
            .execute(
                "DELETE FROM notes WHERE id = ?1 AND is_deleted = 1",
                params![id],
            )
            .map_err(|_| TrashError::OperationFailed)?;
        let queued = queue_unreferenced_assets(transaction, now)?;
        Ok(TrashCleanupResult {
            deleted_note_count: 1,
            pending_file_cleanup_count: queued,
        })
    }

    pub fn empty(
        transaction: &rusqlite::Transaction<'_>,
        now: &str,
    ) -> Result<TrashCleanupResult, TrashError> {
        let deleted = transaction
            .execute("DELETE FROM notes WHERE is_deleted = 1", [])
            .map_err(|_| TrashError::OperationFailed)?;
        let queued = queue_unreferenced_assets(transaction, now)?;
        Ok(TrashCleanupResult {
            deleted_note_count: u32::try_from(deleted).map_err(|_| TrashError::OperationFailed)?,
            pending_file_cleanup_count: queued,
        })
    }
    pub fn trashed_note_ids(connection: &Connection) -> Result<Vec<String>, TrashError> {
        let mut statement = connection
            .prepare("SELECT id FROM notes WHERE is_deleted = 1")
            .map_err(|_| TrashError::OperationFailed)?;
        statement
            .query_map([], |row| row.get(0))
            .map_err(|_| TrashError::OperationFailed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| TrashError::OperationFailed)
    }
}

fn queue_unreferenced_assets(
    transaction: &rusqlite::Transaction<'_>,
    now: &str,
) -> Result<u32, TrashError> {
    let mut statement = transaction
        .prepare(
            "SELECT relative_path FROM assets WHERE NOT EXISTS (
           SELECT 1 FROM note_assets WHERE note_assets.asset_id = assets.id
         )",
        )
        .map_err(|_| TrashError::OperationFailed)?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| TrashError::OperationFailed)?;
    let collected = paths
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| TrashError::OperationFailed)?;
    for path in &collected {
        transaction.execute(
            "INSERT OR IGNORE INTO asset_cleanup_queue (relative_path, queued_at, attempts, last_error)
             VALUES (?1, ?2, 0, NULL)",
            params![path, now],
        ).map_err(|_| TrashError::OperationFailed)?;
    }
    transaction.execute(
        "DELETE FROM assets WHERE NOT EXISTS (SELECT 1 FROM note_assets WHERE note_assets.asset_id = assets.id)",
        [],
    ).map_err(|_| TrashError::OperationFailed)?;
    u32::try_from(collected.len()).map_err(|_| TrashError::OperationFailed)
}

fn category_path(
    connection: &rusqlite::Transaction<'_>,
    category_id: &str,
) -> Result<Option<String>, TrashError> {
    connection
        .query_row(
            "WITH RECURSIVE ancestors(id, name, parent_id, depth) AS (
           SELECT id, name, parent_id, 0 FROM categories WHERE id = ?1
           UNION ALL
           SELECT categories.id, categories.name, categories.parent_id, ancestors.depth + 1
           FROM categories JOIN ancestors ON ancestors.parent_id = categories.id
         ) SELECT group_concat(name, ' / ') FROM (SELECT name FROM ancestors ORDER BY depth DESC)",
            params![category_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| TrashError::OperationFailed)
}

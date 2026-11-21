use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::assets::{AssetError, SavedAsset};

pub struct AssetsRepository;

impl AssetsRepository {
    pub fn original_name(
        connection: &Connection,
        relative_path: &str,
    ) -> Result<Option<String>, AssetError> {
        connection
            .query_row(
                "SELECT COALESCE(original_name, file_name) FROM assets WHERE relative_path = ?1",
                [relative_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| AssetError::ReadFailed)
    }

    pub fn is_linked(
        connection: &Connection,
        note_id: &str,
        relative_path: &str,
    ) -> Result<bool, AssetError> {
        connection
            .query_row(
                "SELECT 1 FROM assets
                 INNER JOIN note_assets ON note_assets.asset_id = assets.id
                 INNER JOIN notes ON notes.id = note_assets.note_id
                 WHERE notes.id = ?1 AND notes.is_deleted = 0 AND assets.relative_path = ?2",
                params![note_id, relative_path],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(|_| AssetError::ReadFailed)
    }

    pub fn pending_cleanup_paths(connection: &Connection) -> Result<Vec<String>, AssetError> {
        let mut statement = connection
            .prepare(
                "SELECT relative_path FROM asset_cleanup_queue ORDER BY queued_at, relative_path",
            )
            .map_err(|_| AssetError::SaveFailed)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| AssetError::SaveFailed)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetError::SaveFailed)
    }

    pub fn mark_cleanup_succeeded(
        connection: &mut Connection,
        relative_path: &str,
    ) -> Result<(), AssetError> {
        connection
            .execute(
                "DELETE FROM asset_cleanup_queue WHERE relative_path = ?1",
                params![relative_path],
            )
            .map_err(|_| AssetError::SaveFailed)?;
        Ok(())
    }

    pub fn mark_cleanup_failed(
        connection: &mut Connection,
        relative_path: &str,
        error_code: &str,
    ) -> Result<(), AssetError> {
        connection
            .execute(
                "UPDATE asset_cleanup_queue SET attempts = attempts + 1, last_error = ?2 WHERE relative_path = ?1",
                params![relative_path, error_code],
            )
            .map_err(|_| AssetError::SaveFailed)?;
        Ok(())
    }

    pub fn note_exists(connection: &Connection, note_id: &str) -> Result<bool, AssetError> {
        connection
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1 AND is_deleted = 0",
                params![note_id],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(|_| AssetError::SaveFailed)
    }

    pub fn list(connection: &Connection, note_id: &str) -> Result<Vec<SavedAsset>, AssetError> {
        let mut statement = connection.prepare(
            "SELECT assets.id, relative_path, COALESCE(original_name, file_name), mime_type, width, height, size, modified_at
             FROM assets JOIN note_assets ON asset_id = assets.id WHERE note_id = ?1 ORDER BY assets.id"
        ).map_err(|_| AssetError::ReadFailed)?;
        statement
            .query_map([note_id], asset_from_row)
            .map_err(|_| AssetError::ReadFailed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetError::ReadFailed)
    }

    pub fn refresh_metadata(
        connection: &mut Connection,
        asset: &SavedAsset,
        hash: &str,
    ) -> Result<(), AssetError> {
        let transaction = connection
            .transaction()
            .map_err(|_| AssetError::SaveFailed)?;
        transaction.execute(
            "UPDATE assets SET size = ?2, width = ?3, height = ?4, hash = ?5, modified_at = ?6 WHERE id = ?1",
            params![asset.id, asset.size, asset.width, asset.height, hash, asset.modified_at],
        ).map_err(|_| AssetError::SaveFailed)?;
        transaction.commit().map_err(|_| AssetError::SaveFailed)
    }

    pub fn legacy_links(connection: &Connection) -> Result<Vec<(String, SavedAsset)>, AssetError> {
        let mut statement = connection.prepare(
            "SELECT note_id, assets.id, relative_path, COALESCE(original_name, file_name), mime_type, width, height, size, modified_at
             FROM assets JOIN note_assets ON asset_id = assets.id WHERE relative_path NOT GLOB 'assets/*/*' ORDER BY note_id"
        ).map_err(|_| AssetError::ReadFailed)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    SavedAsset {
                        id: row.get(1)?,
                        relative_path: row.get(2)?,
                        original_name: row.get(3)?,
                        mime_type: row.get(4)?,
                        width: row.get(5)?,
                        height: row.get(6)?,
                        size: row.get(7)?,
                        modified_at: row.get(8)?,
                    },
                ))
            })
            .map_err(|_| AssetError::ReadFailed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetError::ReadFailed)
    }

    pub fn migrate_link(
        connection: &mut Connection,
        note_id: &str,
        old_id: &str,
        asset: &SavedAsset,
        hash: &str,
        now: &str,
    ) -> Result<(), AssetError> {
        let transaction = connection
            .transaction()
            .map_err(|_| AssetError::SaveFailed)?;
        let old_path: String = transaction
            .query_row(
                "SELECT relative_path FROM assets WHERE id = ?1",
                [old_id],
                |row| row.get(0),
            )
            .map_err(|_| AssetError::SaveFailed)?;
        insert_asset(&transaction, note_id, asset, hash, now)?;
        // Rewrite only managed Markdown targets, including recovery drafts; preserve timestamps.
        for (table, key) in [("notes", "id"), ("recovery_drafts", "note_id")] {
            let sql = format!("SELECT content FROM {table} WHERE {key} = ?1");
            let content: Option<String> = transaction
                .query_row(&sql, [note_id], |row| row.get(0))
                .optional()
                .map_err(|_| AssetError::SaveFailed)?;
            if let Some(content) = content {
                let updated = crate::domain::asset_references::replace(
                    &content,
                    &old_path,
                    &format!("./{}", asset.relative_path),
                );
                transaction
                    .execute(
                        &format!("UPDATE {table} SET content = ?2 WHERE {key} = ?1"),
                        params![note_id, updated],
                    )
                    .map_err(|_| AssetError::SaveFailed)?;
            }
        }
        transaction
            .execute(
                "DELETE FROM note_assets WHERE note_id = ?1 AND asset_id = ?2",
                params![note_id, old_id],
            )
            .map_err(|_| AssetError::SaveFailed)?;
        // Original files remain on disk for recovery, outside the cleanup queue.
        transaction.execute("DELETE FROM assets WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM note_assets WHERE asset_id = ?1)", [old_id])
            .map_err(|_| AssetError::SaveFailed)?;
        let content: String = transaction
            .query_row(
                "SELECT content FROM notes WHERE id = ?1",
                [note_id],
                |row| row.get(0),
            )
            .map_err(|_| AssetError::SaveFailed)?;
        transaction
            .execute(
                "UPDATE notes SET content_preview = ?2 WHERE id = ?1",
                params![
                    note_id,
                    crate::repositories::notes::content_preview(&content)
                ],
            )
            .map_err(|_| AssetError::SaveFailed)?;
        crate::repositories::search::SearchRepository::refresh_note_in_transaction(
            &transaction,
            note_id,
        )
        .map_err(|_| AssetError::SaveFailed)?;
        transaction.commit().map_err(|_| AssetError::SaveFailed)
    }

    pub fn create_and_link(
        connection: &mut Connection,
        note_id: &str,
        asset: &SavedAsset,
        hash: &str,
        now: &str,
    ) -> Result<(), AssetError> {
        let transaction = connection
            .transaction()
            .map_err(|_| AssetError::SaveFailed)?;
        insert_asset(&transaction, note_id, asset, hash, now)?;
        transaction.commit().map_err(|_| AssetError::SaveFailed)
    }
}

fn file_name(relative_path: &str) -> Result<String, AssetError> {
    std::path::Path::new(relative_path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_owned)
        .ok_or(AssetError::SaveFailed)
}

fn extension(relative_path: &str) -> Result<String, AssetError> {
    std::path::Path::new(relative_path)
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_owned)
        .ok_or(AssetError::SaveFailed)
}

fn insert_asset(
    connection: &Connection,
    note_id: &str,
    asset: &SavedAsset,
    hash: &str,
    now: &str,
) -> Result<(), AssetError> {
    connection.execute(
        "INSERT INTO assets (id, file_name, original_name, extension, relative_path, mime_type, size, width, height, hash, created_at, modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![asset.id, file_name(&asset.relative_path)?, asset.original_name, extension(&asset.relative_path)?,
            asset.relative_path, asset.mime_type, asset.size, asset.width, asset.height, hash, now, asset.modified_at],
    ).map_err(|_| AssetError::SaveFailed)?;
    connection
        .execute(
            "INSERT INTO note_assets (note_id, asset_id, created_at) VALUES (?1, ?2, ?3)",
            params![note_id, asset.id, now],
        )
        .map_err(|_| AssetError::SaveFailed)?;
    Ok(())
}

fn asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedAsset> {
    Ok(SavedAsset {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        original_name: row.get(2)?,
        mime_type: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
        size: row.get(6)?,
        modified_at: row.get(7)?,
    })
}

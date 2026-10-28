use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::notes::{NoteDetail, NoteError, NoteSummary};
use crate::domain::settings::NoteSort;
use crate::repositories::search::SearchRepository;

pub struct NotesRepository;

impl NotesRepository {
    pub fn import(
        connection: &mut Connection,
        id: &str,
        title: &str,
        content: &str,
        now: &str,
    ) -> Result<NoteDetail, NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        transaction
            .execute(
                "INSERT INTO notes (id, title, content, category_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
                params![id, title, content, now],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        SearchRepository::refresh_note_in_transaction(&transaction, id)
            .map_err(|_| NoteError::SaveFailed)?;
        let note = Self::find_detail(&transaction, id)?;
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Ok(note)
    }

    pub fn create(
        connection: &mut Connection,
        id: &str,
        category_id: Option<&str>,
        now: &str,
    ) -> Result<NoteDetail, NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        transaction
            .execute(
                "INSERT INTO notes (id, category_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![id, category_id, now],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        SearchRepository::refresh_note_in_transaction(&transaction, id)
            .map_err(|_| NoteError::SaveFailed)?;
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Self::find_detail(connection, id)
    }

    pub fn list(
        connection: &Connection,
        note_sort: NoteSort,
    ) -> Result<Vec<NoteSummary>, NoteError> {
        let sql = format!(
            "SELECT id, title, content,
                    COALESCE((SELECT group_concat(name, char(31)) FROM (
                        SELECT tags.name FROM note_tags
                        JOIN tags ON tags.id = note_tags.tag_id
                        WHERE note_tags.note_id = notes.id
                        ORDER BY tags.name COLLATE NOCASE ASC
                    )), ''),
                    is_pinned, created_at, updated_at
             FROM notes WHERE is_deleted = 0
             ORDER BY is_pinned DESC, {}",
            note_sort.order_by_sql()
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|_| NoteError::ListFailed)?;
        let rows = statement
            .query_map([], |row| {
                let content: String = row.get(2)?;
                Ok(NoteSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content_preview: content_preview(&content),
                    tag_names: tag_names_from_row(row.get(3)?),
                    is_pinned: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|_| NoteError::ListFailed)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| NoteError::ListFailed)
    }

    pub fn find_detail(connection: &Connection, id: &str) -> Result<NoteDetail, NoteError> {
        connection
            .query_row(
                "SELECT id, title, content, category_id, is_pinned, created_at, updated_at
                 FROM notes WHERE id = ?1 AND is_deleted = 0",
                params![id],
                |row| {
                    Ok(NoteDetail {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content: row.get(2)?,
                        category_id: row.get(3)?,
                        is_pinned: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|_| NoteError::SaveFailed)?
            .ok_or(NoteError::NotFound)
    }

    pub fn save(
        connection: &mut Connection,
        id: &str,
        title: &str,
        content: &str,
        now: &str,
    ) -> Result<NoteDetail, NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        let changed = transaction
            .execute(
                "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4
                 WHERE id = ?1 AND is_deleted = 0",
                params![id, title, content, now],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        if changed == 0 {
            return Err(NoteError::NotFound);
        }
        transaction
            .execute(
                "DELETE FROM recovery_drafts WHERE note_id = ?1",
                params![id],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        SearchRepository::refresh_note_in_transaction(&transaction, id)
            .map_err(|_| NoteError::SaveFailed)?;
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Self::find_detail(connection, id)
    }

    pub fn set_pinned(
        connection: &mut Connection,
        id: &str,
        pinned: bool,
        now: &str,
    ) -> Result<NoteDetail, NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        let changed = transaction
            .execute(
                "UPDATE notes SET is_pinned = ?2, updated_at = ?3 WHERE id = ?1 AND is_deleted = 0",
                params![id, i64::from(pinned), now],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        if changed == 0 {
            return Err(NoteError::NotFound);
        }
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Self::find_detail(connection, id)
    }

    pub fn cleanup_empty(connection: &mut Connection, id: &str) -> Result<(), NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        let deleted = transaction
            .execute(
                "DELETE FROM notes
                 WHERE id = ?1 AND is_deleted = 0
                   AND trim(title) = '' AND trim(content) = ''
                   AND NOT EXISTS (SELECT 1 FROM note_assets WHERE note_id = notes.id)",
                params![id],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        if deleted > 0 {
            SearchRepository::refresh_note_in_transaction(&transaction, id)
                .map_err(|_| NoteError::SaveFailed)?;
        }
        transaction.commit().map_err(|_| NoteError::SaveFailed)
    }

    pub fn save_recovery_draft(
        connection: &mut Connection,
        id: &str,
        title: &str,
        content: &str,
        failure_code: &str,
        now: &str,
    ) -> Result<(), NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::RecoveryDraftSaveFailed)?;
        transaction
            .execute(
                "INSERT INTO recovery_drafts
                    (note_id, title, content, failure_code, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(note_id) DO UPDATE SET
                    title = excluded.title,
                    content = excluded.content,
                    failure_code = excluded.failure_code,
                    updated_at = excluded.updated_at",
                params![id, title, content, failure_code, now],
            )
            .map_err(|_| NoteError::RecoveryDraftSaveFailed)?;
        transaction
            .commit()
            .map_err(|_| NoteError::RecoveryDraftSaveFailed)
    }
}

pub fn content_preview(content: &str) -> String {
    let mut preview = String::new();
    let mut inside_tag = false;
    for character in content.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => preview.push(character),
            _ => {}
        }
        if preview.chars().count() >= 160 {
            break;
        }
    }
    preview.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn tag_names_from_row(tag_names: String) -> Vec<String> {
    tag_names
        .split('\u{1f}')
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::domain::notes::{
    NoteDetail, NoteError, NoteListRequest, NotePage, NoteSaveResult, NoteSummary,
};
use crate::domain::settings::NoteSort;
use crate::repositories::search::SearchRepository;

const SUMMARY_COLUMNS: &str = "notes.id, notes.title, notes.content_preview,
  COALESCE((SELECT group_concat(name, char(31)) FROM (
    SELECT tags.name FROM note_tags JOIN tags ON tags.id = note_tags.tag_id
    WHERE note_tags.note_id = notes.id ORDER BY tags.name COLLATE NOCASE ASC
  )), ''), notes.is_pinned, notes.created_at, notes.updated_at";

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
        transaction.execute("INSERT INTO notes (id, title, content, content_preview, category_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)", params![id, title, content, content_preview(content), now]).map_err(|_| NoteError::SaveFailed)?;
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
        transaction.execute("INSERT INTO notes (id, category_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)", params![id, category_id, now]).map_err(|_| NoteError::SaveFailed)?;
        SearchRepository::refresh_note_in_transaction(&transaction, id)
            .map_err(|_| NoteError::SaveFailed)?;
        let note = Self::find_detail(&transaction, id)?;
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Ok(note)
    }

    pub fn list(
        connection: &Connection,
        note_sort: NoteSort,
    ) -> Result<Vec<NoteSummary>, NoteError> {
        Self::list_matching(connection, &NoteListRequest::default(), note_sort)
    }

    pub fn list_matching(
        connection: &Connection,
        request: &NoteListRequest,
        note_sort: NoteSort,
    ) -> Result<Vec<NoteSummary>, NoteError> {
        let (filter, values) = list_filter(request);
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM notes WHERE {filter} ORDER BY notes.is_pinned DESC, {}",
            note_sort.order_by_sql()
        );
        read_summaries(connection, &sql, &values)
    }

    pub fn page(
        connection: &Connection,
        request: &NoteListRequest,
        note_sort: NoteSort,
    ) -> Result<NotePage, NoteError> {
        let (filter, mut values) = list_filter(request);
        let total = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM notes WHERE {filter}"),
                rusqlite::params_from_iter(values.iter()),
                |row| row.get::<_, u32>(0),
            )
            .map_err(|_| NoteError::ListFailed)?;
        let offset = request.offset.unwrap_or(0);
        let limit = request.limit.unwrap_or(50);
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM notes WHERE {filter} ORDER BY notes.is_pinned DESC, {} LIMIT ? OFFSET ?",
            note_sort.order_by_sql()
        );
        values.push(Value::Integer(i64::from(limit)));
        values.push(Value::Integer(i64::from(offset)));
        let items = read_summaries(connection, &sql, &values)?;
        let loaded = u32::try_from(items.len()).map_err(|_| NoteError::ListFailed)?;
        let next_offset = offset
            .checked_add(loaded)
            .filter(|next| loaded > 0 && *next < total);
        Ok(NotePage {
            items,
            total,
            next_offset,
        })
    }

    pub fn find_summary(connection: &Connection, id: &str) -> Result<NoteSummary, NoteError> {
        connection.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM notes WHERE notes.id = ?1 AND notes.is_deleted = 0"), params![id], summary_from_row).optional().map_err(|_| NoteError::SaveFailed)?.ok_or(NoteError::NotFound)
    }

    pub fn find_detail(connection: &Connection, id: &str) -> Result<NoteDetail, NoteError> {
        connection.query_row("SELECT id, title, content, category_id, is_pinned, created_at, updated_at FROM notes WHERE id = ?1 AND is_deleted = 0", params![id], |row| Ok(NoteDetail { id: row.get(0)?, title: row.get(1)?, content: row.get(2)?, category_id: row.get(3)?, is_pinned: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)? })).optional().map_err(|_| NoteError::SaveFailed)?.ok_or(NoteError::NotFound)
    }

    pub fn save(
        connection: &mut Connection,
        id: &str,
        title: &str,
        content: &str,
        now: &str,
    ) -> Result<NoteSaveResult, NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        let changed = transaction.execute("UPDATE notes SET title = ?2, content = ?3, content_preview = ?4, updated_at = ?5 WHERE id = ?1 AND is_deleted = 0 AND (title != ?2 OR content != ?3)", params![id, title, content, content_preview(content), now]).map_err(|_| NoteError::SaveFailed)?;
        let summary = Self::find_summary(&transaction, id)?;
        transaction
            .execute(
                "DELETE FROM recovery_drafts WHERE note_id = ?1",
                params![id],
            )
            .map_err(|_| NoteError::SaveFailed)?;
        if changed > 0 {
            SearchRepository::refresh_note_in_transaction(&transaction, id)
                .map_err(|_| NoteError::SaveFailed)?;
        }
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Ok(NoteSaveResult {
            id: id.to_owned(),
            updated_at: summary.updated_at.clone(),
            summary,
        })
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
        let note = Self::find_detail(&transaction, id)?;
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Ok(note)
    }

    pub fn cleanup_empty(connection: &mut Connection, id: &str) -> Result<bool, NoteError> {
        let transaction = connection
            .transaction()
            .map_err(|_| NoteError::SaveFailed)?;
        let empty: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1 AND is_deleted = 0 AND trim(title) = '' AND trim(content) = '' AND NOT EXISTS (SELECT 1 FROM note_assets WHERE note_id = notes.id))", params![id], |row| row.get(0)).map_err(|_| NoteError::SaveFailed)?;
        if empty {
            SearchRepository::remove_note_in_transaction(&transaction, id)
                .map_err(|_| NoteError::SaveFailed)?;
            transaction
                .execute("DELETE FROM notes WHERE id = ?1", params![id])
                .map_err(|_| NoteError::SaveFailed)?;
        }
        transaction.commit().map_err(|_| NoteError::SaveFailed)?;
        Ok(empty)
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
        transaction.execute("INSERT INTO recovery_drafts (note_id, title, content, failure_code, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(note_id) DO UPDATE SET title = excluded.title, content = excluded.content, failure_code = excluded.failure_code, updated_at = excluded.updated_at", params![id, title, content, failure_code, now]).map_err(|_| NoteError::RecoveryDraftSaveFailed)?;
        transaction
            .commit()
            .map_err(|_| NoteError::RecoveryDraftSaveFailed)
    }

    pub fn backfill_previews(transaction: &Transaction<'_>) -> Result<(), NoteError> {
        let mut statement = transaction
            .prepare("SELECT id, content FROM notes ORDER BY id")
            .map_err(|_| NoteError::SaveFailed)?;
        let mut rows = statement.query([]).map_err(|_| NoteError::SaveFailed)?;
        while let Some(row) = rows.next().map_err(|_| NoteError::SaveFailed)? {
            let id: String = row.get(0).map_err(|_| NoteError::SaveFailed)?;
            let content: String = row.get(1).map_err(|_| NoteError::SaveFailed)?;
            transaction
                .execute(
                    "UPDATE notes SET content_preview = ?2 WHERE id = ?1",
                    params![id, content_preview(&content)],
                )
                .map_err(|_| NoteError::SaveFailed)?;
        }
        Ok(())
    }
}

fn list_filter(request: &NoteListRequest) -> (String, Vec<Value>) {
    let mut filters = vec!["notes.is_deleted = 0".to_owned()];
    let mut values = Vec::new();
    if let Some(category_id) = &request.category_id {
        filters.push("notes.category_id IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM categories WHERE id = ? UNION ALL SELECT categories.id FROM categories JOIN descendants ON categories.parent_id = descendants.id) SELECT id FROM descendants)".to_owned());
        values.push(Value::Text(category_id.clone()));
    } else if request.uncategorized.unwrap_or(false) {
        filters.push("notes.category_id IS NULL".to_owned());
    }
    if let Some(tag_ids) = &request.tag_ids {
        for tag_id in tag_ids.iter().collect::<std::collections::BTreeSet<_>>() {
            filters.push("EXISTS (SELECT 1 FROM note_tags WHERE note_tags.note_id = notes.id AND note_tags.tag_id = ?)".to_owned());
            values.push(Value::Text(tag_id.clone()));
        }
    }
    if let Some(query) = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
    {
        filters.push("(instr(lower(notes.title), lower(?)) > 0 OR instr(lower(notes.content_preview), lower(?)) > 0)".to_owned());
        values.push(Value::Text(query.to_owned()));
        values.push(Value::Text(query.to_owned()));
    }
    (filters.join(" AND "), values)
}

fn read_summaries(
    connection: &Connection,
    sql: &str,
    values: &[Value],
) -> Result<Vec<NoteSummary>, NoteError> {
    let mut statement = connection.prepare(sql).map_err(|_| NoteError::ListFailed)?;
    statement
        .query_map(rusqlite::params_from_iter(values.iter()), summary_from_row)
        .map_err(|_| NoteError::ListFailed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| NoteError::ListFailed)
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        content_preview: row.get(2)?,
        tag_names: tag_names_from_row(row.get(3)?),
        is_pinned: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn content_preview(content: &str) -> String {
    let mut preview = String::new();
    let mut inside_tag = false;
    let mut pending_space = false;
    let mut count = 0;
    for character in content.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if inside_tag => {}
            _ if character.is_whitespace() => pending_space = !preview.is_empty(),
            _ => {
                if pending_space && count < 160 {
                    preview.push(' ');
                    count += 1;
                }
                if count >= 160 {
                    break;
                }
                preview.push(character);
                count += 1;
                pending_space = false;
            }
        }
        if count >= 160 {
            break;
        }
    }
    preview
}

pub fn tag_names_from_row(tag_names: String) -> Vec<String> {
    tag_names
        .split('\u{1f}')
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::domain::search::{SearchError, SearchPage, SearchResult};

pub struct SearchRepository;

struct SearchDocument {
    note_id: String,
    title: String,
    content: String,
    category_path: String,
    tag_names: String,
}

impl SearchRepository {
    pub fn rebuild_index(connection: &mut Connection) -> Result<(), SearchError> {
        let transaction = connection
            .transaction()
            .map_err(|_| SearchError::IndexRebuild)?;
        Self::rebuild_index_in_transaction(&transaction)?;
        transaction.commit().map_err(|_| SearchError::IndexRebuild)
    }

    pub fn ensure_index(connection: &mut Connection) -> Result<(), SearchError> {
        let version: u32 = connection
            .query_row(
                "SELECT version FROM search_index_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| SearchError::IndexRebuild)?;
        if version != 1 {
            Self::rebuild_index(connection)?;
        }
        Ok(())
    }

    pub fn rebuild_index_in_transaction(transaction: &Transaction<'_>) -> Result<(), SearchError> {
        transaction
            .execute("DELETE FROM notes_fts", [])
            .map_err(|_| SearchError::IndexRebuild)?;
        // Keep stable document IDs across repairs, and stream one note at a time.
        let mut statement = transaction
            .prepare("SELECT id FROM notes WHERE is_deleted = 0 ORDER BY id")
            .map_err(|_| SearchError::IndexRebuild)?;
        let note_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| SearchError::IndexRebuild)?;
        for note_id in note_ids {
            Self::refresh_note_in_transaction(
                transaction,
                &note_id.map_err(|_| SearchError::IndexRebuild)?,
            )?;
        }
        transaction
            .execute("UPDATE search_index_state SET version = 1 WHERE id = 1", [])
            .map_err(|_| SearchError::IndexRebuild)?;
        Ok(())
    }

    pub fn refresh_notes_in_transaction(
        transaction: &Transaction<'_>,
        note_ids: &[String],
    ) -> Result<(), SearchError> {
        for note_id in note_ids {
            Self::refresh_note_in_transaction(transaction, note_id)?;
        }
        Ok(())
    }

    pub fn remove_note_in_transaction(
        transaction: &Transaction<'_>,
        note_id: &str,
    ) -> Result<(), SearchError> {
        let document_id = transaction
            .query_row(
                "SELECT document_id FROM note_search_documents WHERE note_id = ?1",
                params![note_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| SearchError::IndexRebuild)?;
        if let Some(document_id) = document_id {
            transaction
                .execute(
                    "DELETE FROM notes_fts WHERE rowid = ?1",
                    params![document_id],
                )
                .map_err(|_| SearchError::IndexRebuild)?;
        }
        Ok(())
    }

    pub fn refresh_note_in_transaction(
        transaction: &Transaction<'_>,
        note_id: &str,
    ) -> Result<(), SearchError> {
        Self::remove_note_in_transaction(transaction, note_id)?;
        let Some(document) = read_search_document(transaction, note_id)? else {
            return Ok(());
        };
        transaction
            .execute(
                "INSERT OR IGNORE INTO note_search_documents (note_id) VALUES (?1)",
                params![note_id],
            )
            .map_err(|_| SearchError::IndexRebuild)?;
        let document_id: i64 = transaction
            .query_row(
                "SELECT document_id FROM note_search_documents WHERE note_id = ?1",
                params![note_id],
                |row| row.get(0),
            )
            .map_err(|_| SearchError::IndexRebuild)?;
        let searchable_text = tokenize_for_index(&[
            &document.title,
            &document.content,
            &document.category_path,
            &document.tag_names,
        ]);
        transaction
            .execute(
                "INSERT INTO notes_fts (rowid, note_id, search_text) VALUES (?1, ?2, ?3)",
                params![document_id, document.note_id, searchable_text],
            )
            .map_err(|_| SearchError::IndexRebuild)?;
        Ok(())
    }

    pub fn search(
        connection: &Connection,
        expression: &str,
        offset: u32,
        limit: u32,
    ) -> Result<SearchPage, SearchError> {
        let total = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM notes_fts
                 INNER JOIN notes ON notes.id = notes_fts.note_id
                 WHERE notes_fts MATCH ?1 AND notes.is_deleted = 0",
                params![expression],
                |row| row.get::<_, u32>(0),
            )
            .map_err(|_| SearchError::Query)?;
        let mut statement = connection
            .prepare(
                "WITH RECURSIVE category_paths(id, path) AS (
                   SELECT id, name FROM categories WHERE parent_id IS NULL
                   UNION ALL
                   SELECT categories.id, category_paths.path || ' / ' || categories.name
                   FROM categories INNER JOIN category_paths ON categories.parent_id = category_paths.id
                 )
                 SELECT notes.id, notes.title, notes.content_preview, category_paths.path, notes.updated_at
                 FROM notes_fts
                 INNER JOIN notes ON notes.id = notes_fts.note_id
                 LEFT JOIN category_paths ON category_paths.id = notes.category_id
                 WHERE notes_fts MATCH ?1 AND notes.is_deleted = 0
                 ORDER BY bm25(notes_fts), notes.updated_at DESC, notes.id DESC
                 LIMIT ?2 OFFSET ?3",
            )
            .map_err(|_| SearchError::Query)?;
        let rows = statement
            .query_map(
                params![expression, i64::from(limit), i64::from(offset)],
                |row| {
                    let content: String = row.get(2)?;
                    Ok(SearchResult {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_preview: content,
                        category_path: row.get(3)?,
                        tag_names: Vec::new(),
                        updated_at: row.get(4)?,
                    })
                },
            )
            .map_err(|_| SearchError::Query)?;
        let mut items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| SearchError::Query)?;
        let tag_names_by_note = read_tag_names(connection, &items)?;
        for item in &mut items {
            item.tag_names = tag_names_by_note.get(&item.id).cloned().unwrap_or_default();
        }
        let loaded = u32::try_from(items.len()).map_err(|_| SearchError::Query)?;
        let next_offset = offset.checked_add(loaded).filter(|next| *next < total);
        Ok(SearchPage {
            items,
            total,
            next_offset,
        })
    }

    pub fn build_expression(terms: &[&str]) -> Option<String> {
        let expressions = terms
            .iter()
            .filter_map(|term| {
                let tokens = tokenize_value(term);
                (!tokens.is_empty()).then(|| format!("\"{tokens}\""))
            })
            .collect::<Vec<_>>();
        (!expressions.is_empty()).then(|| expressions.join(" AND "))
    }
}

fn read_search_document(
    transaction: &Transaction<'_>,
    note_id: &str,
) -> Result<Option<SearchDocument>, SearchError> {
    transaction
        .query_row(
            "WITH RECURSIVE category_paths(id, path) AS (
               SELECT id, name FROM categories WHERE parent_id IS NULL
               UNION ALL
               SELECT categories.id, category_paths.path || ' / ' || categories.name
               FROM categories INNER JOIN category_paths ON categories.parent_id = category_paths.id
             )
             SELECT notes.id, notes.title, notes.content, COALESCE(category_paths.path, ''),
                    COALESCE((
                      SELECT group_concat(tags.name, ' ')
                      FROM note_tags
                      INNER JOIN tags ON tags.id = note_tags.tag_id
                      WHERE note_tags.note_id = notes.id
                    ), '')
             FROM notes
             LEFT JOIN category_paths ON category_paths.id = notes.category_id
             WHERE notes.id = ?1 AND notes.is_deleted = 0",
            params![note_id],
            |row| {
                Ok(SearchDocument {
                    note_id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    category_path: row.get(3)?,
                    tag_names: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| SearchError::IndexRebuild)
}

fn read_tag_names(
    connection: &Connection,
    items: &[SearchResult],
) -> Result<HashMap<String, Vec<String>>, SearchError> {
    if items.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (1..=items.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT note_tags.note_id, tags.name
         FROM note_tags INNER JOIN tags ON tags.id = note_tags.tag_id
         WHERE note_tags.note_id IN ({placeholders})
         ORDER BY lower(tags.name), tags.id"
    );
    let values = items
        .iter()
        .map(|item| Value::Text(item.id.clone()))
        .collect::<Vec<_>>();
    let mut statement = connection.prepare(&sql).map_err(|_| SearchError::Query)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| SearchError::Query)?;
    let mut names = HashMap::<String, Vec<String>>::new();
    for row in rows {
        let (note_id, name) = row.map_err(|_| SearchError::Query)?;
        names.entry(note_id).or_default().push(name);
    }
    Ok(names)
}

fn tokenize_for_index(values: &[&str]) -> String {
    let mut output = String::new();
    for value in values {
        append_tokens(value, &mut output);
    }
    output
}

fn tokenize_value(value: &str) -> String {
    let mut output = String::new();
    append_tokens(value, &mut output);
    output
}

fn append_tokens(value: &str, output: &mut String) {
    let mut in_word = false;
    for character in value.chars() {
        if is_han_character(character) {
            if !output.is_empty() {
                output.push(' ');
            }
            output.push(character);
            in_word = false;
        } else if character.is_alphanumeric() {
            if !in_word && !output.is_empty() {
                output.push(' ');
            }
            output.extend(character.to_lowercase());
            in_word = true;
        } else {
            in_word = false;
        }
    }
}

fn is_han_character(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2EBEF
    )
}

#[cfg(test)]
mod tests {
    use super::SearchRepository;

    #[test]
    fn builds_phrase_based_and_expression_for_chinese_and_english() {
        assert_eq!(
            SearchRepository::build_expression(&["本地数据", "Note-X 2026"]),
            Some("\"本 地 数 据\" AND \"note x 2026\"".to_owned()),
        );
    }
}

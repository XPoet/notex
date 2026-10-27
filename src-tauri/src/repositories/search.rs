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

    pub fn rebuild_index_in_transaction(transaction: &Transaction<'_>) -> Result<(), SearchError> {
        let documents = read_search_documents(transaction)?;
        transaction
            .execute("DELETE FROM notes_fts", [])
            .map_err(|_| SearchError::IndexRebuild)?;
        let mut insert = transaction
            .prepare("INSERT INTO notes_fts (note_id, search_text) VALUES (?1, ?2)")
            .map_err(|_| SearchError::IndexRebuild)?;
        for document in documents {
            let searchable_text = tokenize_for_index(&[
                &document.title,
                &document.content,
                &document.category_path,
                &document.tag_names,
            ]);
            insert
                .execute(params![document.note_id, searchable_text])
                .map_err(|_| SearchError::IndexRebuild)?;
        }
        Ok(())
    }

    pub fn refresh_note_in_transaction(
        transaction: &Transaction<'_>,
        note_id: &str,
    ) -> Result<(), SearchError> {
        transaction
            .execute("DELETE FROM notes_fts WHERE note_id = ?1", params![note_id])
            .map_err(|_| SearchError::IndexRebuild)?;
        let Some(document) = read_search_document(transaction, note_id)? else {
            return Ok(());
        };
        let searchable_text = tokenize_for_index(&[
            &document.title,
            &document.content,
            &document.category_path,
            &document.tag_names,
        ]);
        transaction
            .execute(
                "INSERT INTO notes_fts (note_id, search_text) VALUES (?1, ?2)",
                params![document.note_id, searchable_text],
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
                 SELECT notes.id, notes.title, notes.content, category_paths.path, notes.updated_at
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
                        content_preview: content_preview(&content),
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
                (!tokens.is_empty()).then(|| format!("\"{}\"", tokens.join(" ")))
            })
            .collect::<Vec<_>>();
        (!expressions.is_empty()).then(|| expressions.join(" AND "))
    }
}

fn read_search_documents(
    transaction: &Transaction<'_>,
) -> Result<Vec<SearchDocument>, SearchError> {
    let mut statement = transaction
        .prepare(
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
             WHERE notes.is_deleted = 0
             ORDER BY notes.id",
        )
        .map_err(|_| SearchError::IndexRebuild)?;
    let rows = statement
        .query_map([], |row| {
            Ok(SearchDocument {
                note_id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                category_path: row.get(3)?,
                tag_names: row.get(4)?,
            })
        })
        .map_err(|_| SearchError::IndexRebuild)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| SearchError::IndexRebuild)
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
    values
        .iter()
        .flat_map(|value| tokenize_value(value))
        .collect::<Vec<_>>()
        .join(" ")
}

fn tokenize_value(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    for character in value.chars() {
        if is_han_character(character) {
            push_word(&mut tokens, &mut word);
            tokens.push(character.to_string());
        } else if character.is_alphanumeric() {
            word.extend(character.to_lowercase());
        } else {
            push_word(&mut tokens, &mut word);
        }
    }
    push_word(&mut tokens, &mut word);
    tokens
}

fn push_word(tokens: &mut Vec<String>, word: &mut String) {
    if !word.is_empty() {
        tokens.push(std::mem::take(word));
    }
}

fn is_han_character(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2EBEF
    )
}

fn content_preview(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
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

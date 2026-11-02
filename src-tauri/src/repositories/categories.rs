use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::categories::{
    CategoryDeleteImpact, CategoryDeleteMode, CategoryError, CategoryNode,
};
use crate::domain::notes::NoteSummary;
use crate::domain::settings::NoteSort;

#[derive(Clone)]
struct CategoryRecord {
    id: String,
    name: String,
    parent_id: Option<String>,
    level: i64,
    sort_order: i64,
    path: String,
    note_count: u32,
}

pub struct CategoriesRepository;

impl CategoriesRepository {
    pub fn list(connection: &Connection) -> Result<Vec<CategoryNode>, CategoryError> {
        let mut statement = connection.prepare(
            "WITH RECURSIVE tree(id, name, parent_id, level, sort_order, path, sort_path) AS (
               SELECT id, name, parent_id, level, sort_order, name, printf('%020d', sort_order) FROM categories WHERE parent_id IS NULL
               UNION ALL
               SELECT c.id, c.name, c.parent_id, c.level, c.sort_order, tree.path || ' / ' || c.name, tree.sort_path || '/' || printf('%020d', c.sort_order)
               FROM categories c JOIN tree ON c.parent_id = tree.id
             ) SELECT id, name, parent_id, level, sort_order, path FROM tree ORDER BY sort_path, id",
        ).map_err(|_| CategoryError::OperationFailed)?;
        let rows = statement
            .query_map([], |row| {
                Ok(CategoryRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    level: row.get(3)?,
                    sort_order: row.get(4)?,
                    path: row.get(5)?,
                    note_count: 0,
                })
            })
            .map_err(|_| CategoryError::OperationFailed)?;
        let mut records = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| CategoryError::OperationFailed)?;
        let parent_by_id: HashMap<String, Option<String>> = records
            .iter()
            .map(|record| (record.id.clone(), record.parent_id.clone()))
            .collect();
        let mut counts: HashMap<String, u32> = HashMap::new();
        let mut notes = connection.prepare("SELECT category_id, COUNT(*) FROM notes WHERE is_deleted = 0 AND category_id IS NOT NULL GROUP BY category_id").map_err(|_| CategoryError::OperationFailed)?;
        let note_rows = notes
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|_| CategoryError::OperationFailed)?;
        for row in note_rows {
            let (mut category_id, count) = row.map_err(|_| CategoryError::OperationFailed)?;
            loop {
                *counts.entry(category_id.clone()).or_default() += count;
                match parent_by_id.get(&category_id).and_then(Clone::clone) {
                    Some(parent_id) => category_id = parent_id,
                    None => break,
                }
            }
        }
        for record in &mut records {
            record.note_count = match counts.get(&record.id) {
                Some(count) => *count,
                None => 0,
            };
        }
        Ok(build_tree(None, &records))
    }

    pub fn create(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        name: &str,
        parent_id: Option<&str>,
        now: &str,
    ) -> Result<CategoryNode, CategoryError> {
        let parent_level = match parent_id {
            Some(parent) => transaction
                .query_row(
                    "SELECT level FROM categories WHERE id = ?1",
                    params![parent],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|_| CategoryError::OperationFailed)?
                .ok_or(CategoryError::NotFound)?,
            None => 0,
        };
        let level = parent_level + 1;
        if level > 5 {
            return Err(CategoryError::MaxDepthExceeded);
        }
        ensure_unique_name(transaction, name, parent_id, None)?;
        let sort_order: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories WHERE parent_id IS ?1",
                params![parent_id],
                |row| row.get(0),
            )
            .map_err(|_| CategoryError::OperationFailed)?;
        transaction.execute("INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)", params![id, name, parent_id, level, sort_order, now]).map_err(map_category_constraint)?;
        find_node(transaction, id)
    }

    pub fn rename(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        name: &str,
        now: &str,
    ) -> Result<CategoryNode, CategoryError> {
        let parent_id = transaction
            .query_row(
                "SELECT parent_id FROM categories WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|_| CategoryError::OperationFailed)?
            .ok_or(CategoryError::NotFound)?;
        ensure_unique_name(transaction, name, parent_id.as_deref(), Some(id))?;
        transaction
            .execute(
                "UPDATE categories SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, name, now],
            )
            .map_err(map_category_constraint)?;
        find_node(transaction, id)
    }

    pub fn move_category(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        parent_id: Option<&str>,
        ordered_ids: &[String],
        now: &str,
    ) -> Result<(), CategoryError> {
        let current = transaction
            .query_row(
                "SELECT parent_id, level FROM categories WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|_| CategoryError::OperationFailed)?
            .ok_or(CategoryError::NotFound)?;
        if parent_id == Some(id) {
            return Err(CategoryError::CycleDetected);
        }
        if let Some(parent) = parent_id {
            let is_descendant = transaction.query_row(
                "WITH RECURSIVE descendants(id) AS (SELECT id FROM categories WHERE parent_id = ?1 UNION ALL SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id) SELECT 1 FROM descendants WHERE id = ?2",
                params![id, parent], |_| Ok(())
            ).optional().map_err(|_| CategoryError::OperationFailed)?.is_some();
            if is_descendant {
                return Err(CategoryError::CycleDetected);
            }
        }
        let target_level = parent_id
            .map(|parent| {
                transaction
                    .query_row(
                        "SELECT level FROM categories WHERE id = ?1",
                        params![parent],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|_| CategoryError::OperationFailed)?
                    .ok_or(CategoryError::NotFound)
            })
            .transpose()?
            .unwrap_or(0)
            + 1;
        let max_relative_level: i64 = transaction.query_row(
            "WITH RECURSIVE descendants(id, level) AS (SELECT id, level FROM categories WHERE id = ?1 UNION ALL SELECT c.id, c.level FROM categories c JOIN descendants d ON c.parent_id = d.id) SELECT MAX(level) FROM descendants",
            params![id], |row| row.get(0)
        ).map_err(|_| CategoryError::OperationFailed)?;
        if target_level + (max_relative_level - current.1) > 5 {
            return Err(CategoryError::MaxDepthExceeded);
        }
        ensure_unique_name(
            transaction,
            &transaction
                .query_row(
                    "SELECT name FROM categories WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| CategoryError::OperationFailed)?,
            parent_id,
            Some(id),
        )?;
        let level_delta = target_level - current.1;
        transaction
            .execute(
                "WITH RECURSIVE descendants(id) AS (
                   SELECT id FROM categories WHERE id = ?1
                   UNION ALL
                   SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
                 )
                 UPDATE categories
                 SET level = level + ?2, updated_at = ?3
                 WHERE id IN descendants",
                params![id, level_delta, now],
            )
            .map_err(|_| CategoryError::OperationFailed)?;
        transaction
            .execute(
                "UPDATE categories SET parent_id = ?2 WHERE id = ?1",
                params![id, parent_id],
            )
            .map_err(|_| CategoryError::OperationFailed)?;
        reorder_siblings(transaction, parent_id, ordered_ids, now)?;
        Ok(())
    }

    pub fn delete_impact(
        connection: &Connection,
        id: &str,
    ) -> Result<CategoryDeleteImpact, CategoryError> {
        let exists = connection
            .query_row(
                "SELECT 1 FROM categories WHERE id = ?1",
                params![id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| CategoryError::OperationFailed)?
            .is_some();
        if !exists {
            return Err(CategoryError::NotFound);
        }
        let direct_note_count = count_notes(
            connection,
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 0 AND category_id = ?1",
            id,
        )?;
        let child_category_count = count_notes(
            connection,
            "WITH RECURSIVE descendants(id) AS (SELECT id FROM categories WHERE parent_id = ?1 UNION ALL SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id) SELECT COUNT(*) FROM descendants",
            id,
        )?;
        let branch_note_count = count_notes(
            connection,
            "WITH RECURSIVE descendants(id) AS (SELECT id FROM categories WHERE id = ?1 UNION ALL SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id) SELECT COUNT(*) FROM notes WHERE is_deleted = 0 AND category_id IN descendants",
            id,
        )?;
        Ok(CategoryDeleteImpact {
            direct_note_count,
            branch_note_count,
            child_category_count,
        })
    }

    pub fn delete(
        transaction: &rusqlite::Transaction<'_>,
        id: &str,
        mode: CategoryDeleteMode,
        now: &str,
    ) -> Result<(), CategoryError> {
        let parent_id = transaction
            .query_row(
                "SELECT parent_id FROM categories WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|_| CategoryError::OperationFailed)?
            .ok_or(CategoryError::NotFound)?;
        match mode {
            CategoryDeleteMode::Current => {
                transaction
                    .execute(
                        "UPDATE notes SET category_id = ?2, updated_at = ?3 WHERE category_id = ?1",
                        params![id, parent_id, now],
                    )
                    .map_err(|_| CategoryError::OperationFailed)?;
                transaction.execute("UPDATE categories SET parent_id = ?2, updated_at = ?3 WHERE parent_id = ?1", params![id, parent_id, now]).map_err(|_| CategoryError::OperationFailed)?;
                transaction.execute(
                    "WITH RECURSIVE descendants(id) AS (
                       SELECT id FROM categories WHERE parent_id = ?1
                       UNION ALL SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
                     ) UPDATE categories SET level = level - 1, updated_at = ?2 WHERE id IN descendants",
                    params![id, now],
                ).map_err(|_| CategoryError::OperationFailed)?;
                transaction
                    .execute("DELETE FROM categories WHERE id = ?1", params![id])
                    .map_err(|_| CategoryError::OperationFailed)?;
            }
            CategoryDeleteMode::Branch => delete_branch(transaction, id, now)?,
        }
        Ok(())
    }

    pub fn note_ids_in_branch(
        connection: &Connection,
        id: &str,
    ) -> Result<Vec<String>, CategoryError> {
        let mut statement = connection.prepare("WITH RECURSIVE descendants(id) AS (SELECT id FROM categories WHERE id = ?1 UNION ALL SELECT categories.id FROM categories JOIN descendants ON categories.parent_id = descendants.id) SELECT notes.id FROM notes WHERE notes.is_deleted = 0 AND notes.category_id IN descendants").map_err(|_| CategoryError::OperationFailed)?;
        statement
            .query_map(params![id], |row| row.get(0))
            .map_err(|_| CategoryError::OperationFailed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| CategoryError::OperationFailed)
    }

    pub fn set_note_category(
        transaction: &rusqlite::Transaction<'_>,
        note_id: &str,
        category_id: Option<&str>,
        now: &str,
    ) -> Result<(), CategoryError> {
        if let Some(category_id) = category_id {
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM categories WHERE id = ?1",
                    params![category_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|_| CategoryError::OperationFailed)?
                .is_some();
            if !exists {
                return Err(CategoryError::NotFound);
            }
        }
        let changed = transaction.execute("UPDATE notes SET category_id = ?2, updated_at = ?3 WHERE id = ?1 AND is_deleted = 0", params![note_id, category_id, now]).map_err(|_| CategoryError::OperationFailed)?;
        if changed == 0 {
            return Err(CategoryError::NotFound);
        }
        Ok(())
    }

    pub fn notes_by_category(
        connection: &Connection,
        category_id: Option<&str>,
        note_sort: NoteSort,
    ) -> Result<Vec<NoteSummary>, CategoryError> {
        let request = crate::domain::notes::NoteListRequest {
            category_id: category_id.map(ToOwned::to_owned),
            uncategorized: Some(category_id.is_none()),
            ..Default::default()
        };
        crate::repositories::notes::NotesRepository::list_matching(connection, &request, note_sort)
            .map_err(|_| CategoryError::OperationFailed)
    }
}

fn build_tree(parent_id: Option<&str>, records: &[CategoryRecord]) -> Vec<CategoryNode> {
    records
        .iter()
        .filter(|record| record.parent_id.as_deref() == parent_id)
        .map(|record| CategoryNode {
            id: record.id.clone(),
            name: record.name.clone(),
            parent_id: record.parent_id.clone(),
            level: record.level,
            sort_order: record.sort_order,
            path: record.path.clone(),
            note_count: record.note_count,
            children: build_tree(Some(&record.id), records),
        })
        .collect()
}
fn find_node(connection: &Connection, id: &str) -> Result<CategoryNode, CategoryError> {
    CategoriesRepository::list(connection)?
        .into_iter()
        .find_map(|node| find_in_tree(node, id))
        .ok_or(CategoryError::NotFound)
}
fn find_in_tree(node: CategoryNode, id: &str) -> Option<CategoryNode> {
    if node.id == id {
        Some(node)
    } else {
        node.children
            .into_iter()
            .find_map(|child| find_in_tree(child, id))
    }
}
fn ensure_unique_name(
    connection: &rusqlite::Transaction<'_>,
    name: &str,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<(), CategoryError> {
    let existing = connection.query_row("SELECT 1 FROM categories WHERE parent_id IS ?1 AND lower(name) = lower(?2) AND (?3 IS NULL OR id != ?3)", params![parent_id, name, excluded_id], |_| Ok(())).optional().map_err(|_| CategoryError::OperationFailed)?.is_some();
    if existing {
        Err(CategoryError::DuplicateName)
    } else {
        Ok(())
    }
}
fn reorder_siblings(
    connection: &rusqlite::Transaction<'_>,
    parent_id: Option<&str>,
    ordered_ids: &[String],
    now: &str,
) -> Result<(), CategoryError> {
    let mut statement = connection
        .prepare("SELECT id FROM categories WHERE parent_id IS ?1 ORDER BY sort_order, id")
        .map_err(|_| CategoryError::OperationFailed)?;
    let actual = statement
        .query_map(params![parent_id], |row| row.get::<_, String>(0))
        .map_err(|_| CategoryError::OperationFailed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CategoryError::OperationFailed)?;
    let desired = if ordered_ids.is_empty() {
        actual.clone()
    } else {
        ordered_ids.to_vec()
    };
    if actual.len() != desired.len()
        || actual.iter().collect::<HashSet<_>>() != desired.iter().collect::<HashSet<_>>()
    {
        return Err(CategoryError::ValidationFailed);
    }
    for (index, category_id) in desired.iter().enumerate() {
        connection
            .execute(
                "UPDATE categories SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![
                    category_id,
                    i64::try_from(index).map_err(|_| CategoryError::OperationFailed)?,
                    now
                ],
            )
            .map_err(|_| CategoryError::OperationFailed)?;
    }
    Ok(())
}
fn delete_branch(
    connection: &rusqlite::Transaction<'_>,
    id: &str,
    now: &str,
) -> Result<(), CategoryError> {
    let mut statement = connection.prepare("WITH RECURSIVE descendants(id, parent_id, name, path, depth) AS (SELECT id, parent_id, name, name, 0 FROM categories WHERE id = ?1 UNION ALL SELECT c.id, c.parent_id, c.name, descendants.path || ' / ' || c.name, descendants.depth + 1 FROM categories c JOIN descendants ON c.parent_id = descendants.id) SELECT id, path, depth FROM descendants ORDER BY depth DESC").map_err(|_| CategoryError::OperationFailed)?;
    let descendants = statement
        .query_map(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| CategoryError::OperationFailed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CategoryError::OperationFailed)?;
    for (category_id, path, _) in &descendants {
        connection.execute("UPDATE notes SET is_deleted = 1, deleted_at = ?3, trashed_from_category_id = category_id, trashed_from_category_path = ?2, category_id = NULL WHERE category_id = ?1 AND is_deleted = 0", params![category_id, path, now]).map_err(|_| CategoryError::OperationFailed)?;
    }
    for (category_id, _, _) in descendants {
        connection
            .execute("DELETE FROM categories WHERE id = ?1", params![category_id])
            .map_err(|_| CategoryError::OperationFailed)?;
    }
    Ok(())
}
fn count_notes(connection: &Connection, sql: &str, id: &str) -> Result<u32, CategoryError> {
    connection
        .query_row(sql, params![id], |row| row.get(0))
        .map_err(|_| CategoryError::OperationFailed)
}
fn map_category_constraint(_: rusqlite::Error) -> CategoryError {
    CategoryError::OperationFailed
}

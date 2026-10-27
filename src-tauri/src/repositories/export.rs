use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::export::{ExportError, ExportScope, ExportScopeKind};

pub struct ExportRepository;

#[derive(Debug, Clone)]
pub struct ExportCategory {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct ExportAsset {
    pub id: String,
    pub relative_path: String,
    pub file_name: String,
}

#[derive(Debug, Clone)]
pub struct ExportNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category_path: Vec<ExportCategory>,
    pub assets: Vec<ExportAsset>,
}

#[derive(Debug, Clone)]
pub struct ExportSnapshot {
    pub scope_label: String,
    pub notes: Vec<ExportNote>,
}

#[derive(Debug, Clone)]
struct CategoryRecord {
    id: String,
    name: String,
    parent_id: Option<String>,
}

impl ExportRepository {
    pub fn snapshot_all(connection: &mut Connection) -> Result<ExportSnapshot, ExportError> {
        let transaction = connection
            .transaction()
            .map_err(|_| ExportError::Snapshot)?;
        let category_paths = read_category_paths(&transaction)?;
        let mut notes = read_notes(
            &transaction,
            "SELECT id, title, content, category_id FROM notes
             WHERE is_deleted = 0 ORDER BY updated_at DESC, id DESC",
            [],
        )?;
        assign_category_paths(&mut notes, &category_paths)?;
        attach_assets(&transaction, &mut notes)?;
        transaction.commit().map_err(|_| ExportError::Snapshot)?;
        Ok(ExportSnapshot {
            scope_label: "全部笔记".to_owned(),
            notes,
        })
    }

    pub fn snapshot(
        connection: &mut Connection,
        scope: &ExportScope,
    ) -> Result<ExportSnapshot, ExportError> {
        let transaction = connection
            .transaction()
            .map_err(|_| ExportError::Snapshot)?;
        let snapshot = snapshot_in_transaction(&transaction, scope)?;
        transaction.commit().map_err(|_| ExportError::Snapshot)?;
        Ok(snapshot)
    }
}

fn snapshot_in_transaction(
    connection: &Connection,
    scope: &ExportScope,
) -> Result<ExportSnapshot, ExportError> {
    let category_paths = read_category_paths(connection)?;
    let (scope_label, mut notes) = match scope.kind {
        ExportScopeKind::Note => {
            let notes = read_notes(
                connection,
                "SELECT id, title, content, category_id FROM notes
                     WHERE id = ?1 AND is_deleted = 0
                     ORDER BY updated_at DESC, id DESC",
                params![scope.id],
            )?;
            if notes.is_empty() {
                return Err(ExportError::ScopeNotFound);
            }
            ("单篇笔记".to_owned(), notes)
        }
        ExportScopeKind::Category => {
            let name = if scope.id == "uncategorized" {
                "未分类".to_owned()
            } else {
                category_name(connection, &scope.id)?
            };
            let notes = read_notes(
                connection,
                "SELECT id, title, content, category_id FROM notes
                     WHERE category_id IS NULLIF(?1, 'uncategorized') AND is_deleted = 0
                     ORDER BY updated_at DESC, id DESC",
                params![scope.id],
            )?;
            (name, notes)
        }
        ExportScopeKind::CategoryWithDescendants => {
            let name = category_name(connection, &scope.id)?;
            let notes = read_notes(
                connection,
                "WITH RECURSIVE descendants(id) AS (
                       SELECT id FROM categories WHERE id = ?1
                       UNION ALL
                       SELECT categories.id FROM categories
                       INNER JOIN descendants ON categories.parent_id = descendants.id
                     )
                     SELECT notes.id, notes.title, notes.content, notes.category_id
                     FROM notes INNER JOIN descendants ON descendants.id = notes.category_id
                     WHERE notes.is_deleted = 0
                     ORDER BY notes.updated_at DESC, notes.id DESC",
                params![scope.id],
            )?;
            (name, notes)
        }
        ExportScopeKind::Tag => {
            let name = tag_name(connection, &scope.id)?;
            let notes = read_notes(
                connection,
                "SELECT notes.id, notes.title, notes.content, notes.category_id
                     FROM notes
                     INNER JOIN note_tags ON note_tags.note_id = notes.id
                     WHERE note_tags.tag_id = ?1 AND notes.is_deleted = 0
                     ORDER BY notes.updated_at DESC, notes.id DESC",
                params![scope.id],
            )?;
            (name, notes)
        }
    };
    assign_category_paths(&mut notes, &category_paths)?;
    attach_assets(connection, &mut notes)?;
    Ok(ExportSnapshot { scope_label, notes })
}

fn read_notes(
    connection: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<ExportNote>, ExportError> {
    let mut statement = connection.prepare(sql).map_err(|_| ExportError::Snapshot)?;
    let rows = statement
        .query_map(parameters, |row| {
            Ok(ExportNote {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                category_path: row
                    .get::<_, Option<String>>(3)?
                    .map(|category_id| {
                        vec![ExportCategory {
                            id: category_id,
                            name: String::new(),
                        }]
                    })
                    .unwrap_or_default(),
                assets: Vec::new(),
            })
        })
        .map_err(|_| ExportError::Snapshot)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| ExportError::Snapshot)
}

fn category_name(connection: &Connection, category_id: &str) -> Result<String, ExportError> {
    connection
        .query_row(
            "SELECT name FROM categories WHERE id = ?1",
            params![category_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ExportError::Snapshot)?
        .ok_or(ExportError::ScopeNotFound)
}

fn tag_name(connection: &Connection, tag_id: &str) -> Result<String, ExportError> {
    connection
        .query_row(
            "SELECT name FROM tags WHERE id = ?1",
            params![tag_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ExportError::Snapshot)?
        .ok_or(ExportError::ScopeNotFound)
}

fn read_category_paths(
    connection: &Connection,
) -> Result<HashMap<String, Vec<ExportCategory>>, ExportError> {
    let mut statement = connection
        .prepare("SELECT id, name, parent_id FROM categories")
        .map_err(|_| ExportError::Snapshot)?;
    let rows = statement
        .query_map([], |row| {
            Ok(CategoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
            })
        })
        .map_err(|_| ExportError::Snapshot)?;
    let records = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ExportError::Snapshot)?;
    let records_by_id = records
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect::<HashMap<_, _>>();
    let mut paths = HashMap::new();
    for category_id in records_by_id.keys() {
        let path = build_category_path(category_id, &records_by_id, &mut HashSet::new())?;
        paths.insert(category_id.clone(), path);
    }
    Ok(paths)
}

fn build_category_path(
    category_id: &str,
    records: &HashMap<String, CategoryRecord>,
    visiting: &mut HashSet<String>,
) -> Result<Vec<ExportCategory>, ExportError> {
    if !visiting.insert(category_id.to_owned()) {
        return Err(ExportError::Snapshot);
    }
    let record = records.get(category_id).ok_or(ExportError::Snapshot)?;
    let mut path = match record.parent_id.as_deref() {
        Some(parent_id) => build_category_path(parent_id, records, visiting)?,
        None => Vec::new(),
    };
    if path.len() >= 5 {
        return Err(ExportError::Snapshot);
    }
    path.push(ExportCategory {
        id: record.id.clone(),
        name: record.name.clone(),
    });
    visiting.remove(category_id);
    Ok(path)
}

fn assign_category_paths(
    notes: &mut [ExportNote],
    paths: &HashMap<String, Vec<ExportCategory>>,
) -> Result<(), ExportError> {
    for note in notes {
        let Some(category) = note.category_path.first() else {
            continue;
        };
        note.category_path = paths
            .get(&category.id)
            .cloned()
            .ok_or(ExportError::Snapshot)?;
    }
    Ok(())
}

fn attach_assets(connection: &Connection, notes: &mut [ExportNote]) -> Result<(), ExportError> {
    const BATCH_SIZE: usize = 300;
    let mut assets_by_note = HashMap::<String, Vec<ExportAsset>>::new();
    for chunk in notes.chunks(BATCH_SIZE) {
        let placeholders = (1..=chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT note_assets.note_id, assets.id, assets.relative_path, assets.file_name
             FROM note_assets INNER JOIN assets ON assets.id = note_assets.asset_id
             WHERE note_assets.note_id IN ({placeholders})
             ORDER BY note_assets.note_id, assets.id"
        );
        let values = chunk
            .iter()
            .map(|note| Value::Text(note.id.clone()))
            .collect::<Vec<_>>();
        let mut statement = connection
            .prepare(&sql)
            .map_err(|_| ExportError::Snapshot)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ExportAsset {
                        id: row.get(1)?,
                        relative_path: row.get(2)?,
                        file_name: row.get(3)?,
                    },
                ))
            })
            .map_err(|_| ExportError::Snapshot)?;
        for row in rows {
            let (note_id, asset) = row.map_err(|_| ExportError::Snapshot)?;
            assets_by_note.entry(note_id).or_default().push(asset);
        }
    }
    for note in notes {
        note.assets = assets_by_note.remove(&note.id).unwrap_or_default();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::params;

    use crate::database::connection::open_database;
    use crate::repositories::bootstrap::BootstrapRepository;

    use super::{ExportRepository, ExportScope, ExportScopeKind};

    #[test]
    fn snapshots_category_descendants_and_linked_assets() -> Result<(), Box<dyn std::error::Error>>
    {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-export-repository-{timestamp}"));
        fs::create_dir_all(&directory)?;
        let database_path = directory.join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let mut connection = open_database(&database_path)?;
        connection.execute(
            "INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at)
             VALUES ('root', '工作', NULL, 1, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')",
            [],
        )?;
        connection.execute(
            "INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at)
             VALUES ('child', '项目 A', 'root', 2, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')",
            [],
        )?;
        connection.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at)
             VALUES ('note', '接口说明', '![图片](./assets/image.png)', 'child', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')",
            [],
        )?;
        connection.execute(
            "INSERT INTO assets (id, file_name, extension, relative_path, mime_type, size, width, height, hash, created_at)
             VALUES ('asset', 'image.png', 'png', 'assets/image.png', 'image/png', 1, 1, 1, 'hash', '2026-07-24T00:00:00Z')",
            [],
        )?;
        connection.execute(
            "INSERT INTO note_assets (note_id, asset_id, created_at) VALUES (?1, ?2, ?3)",
            params!["note", "asset", "2026-07-24T00:00:00Z"],
        )?;

        let snapshot = ExportRepository::snapshot(
            &mut connection,
            &ExportScope {
                kind: ExportScopeKind::CategoryWithDescendants,
                id: "root".to_owned(),
            },
        )?;
        assert_eq!(snapshot.notes.len(), 1);
        assert_eq!(snapshot.notes[0].category_path.len(), 2);
        assert_eq!(snapshot.notes[0].assets[0].file_name, "image.png");
        Ok(())
    }

    #[test]
    fn snapshots_all_export_scopes_with_the_expected_note_sets()
    -> Result<(), Box<dyn std::error::Error>> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-export-scopes-{timestamp}"));
        fs::create_dir_all(&directory)?;
        let database_path = directory.join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let mut connection = open_database(&database_path)?;
        connection.execute("INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at) VALUES ('root', '工作', NULL, 1, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z'), ('child', '项目', 'root', 2, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO tags (id, name, created_at, updated_at) VALUES ('tag', '导出', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO notes (id, title, content, category_id, created_at, updated_at) VALUES ('root-note', '根级笔记', '', 'root', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z'), ('child-note', '子级笔记', '', 'child', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z'), ('tag-note', '标签笔记', '', NULL, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO note_tags (note_id, tag_id, created_at) VALUES ('tag-note', 'tag', '2026-07-24T00:00:00Z')", [])?;

        let note = ExportRepository::snapshot(
            &mut connection,
            &ExportScope {
                kind: ExportScopeKind::Note,
                id: "root-note".to_owned(),
            },
        )?;
        let category = ExportRepository::snapshot(
            &mut connection,
            &ExportScope {
                kind: ExportScopeKind::Category,
                id: "root".to_owned(),
            },
        )?;
        let descendants = ExportRepository::snapshot(
            &mut connection,
            &ExportScope {
                kind: ExportScopeKind::CategoryWithDescendants,
                id: "root".to_owned(),
            },
        )?;
        let tag = ExportRepository::snapshot(
            &mut connection,
            &ExportScope {
                kind: ExportScopeKind::Tag,
                id: "tag".to_owned(),
            },
        )?;

        assert_eq!(note.notes.len(), 1);
        assert_eq!(
            category
                .notes
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["root-note"]
        );
        assert_eq!(descendants.notes.len(), 2);
        assert_eq!(
            tag.notes
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["tag-note"]
        );
        Ok(())
    }
}

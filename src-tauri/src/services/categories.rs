use std::path::{Path, PathBuf};

use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::database::connection::open_database;
use crate::domain::categories::{
    CategoryDeleteImpact, CategoryDeleteMode, CategoryError, CategoryNode,
};
use crate::domain::notes::NoteSummary;
use crate::repositories::categories::CategoriesRepository;
use crate::repositories::search::SearchRepository;
use crate::repositories::settings::SettingsRepository;

pub struct CategoriesService {
    database_path: PathBuf,
}
impl CategoriesService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            database_path: data_directory.join("database").join("notex.db"),
        }
    }
    pub fn list(&self) -> Result<Vec<CategoryNode>, CategoryError> {
        let connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        CategoriesRepository::list(&connection)
    }
    pub fn create(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<CategoryNode, CategoryError> {
        let name = normalized_name(name)?;
        let mut connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        let category = CategoriesRepository::create(
            &mut connection,
            &Uuid::new_v4().to_string(),
            &name,
            parent_id,
            &current_time()?,
        )?;
        SearchRepository::rebuild_index(&mut connection)
            .map_err(|_| CategoryError::OperationFailed)?;
        Ok(category)
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<CategoryNode, CategoryError> {
        let name = normalized_name(name)?;
        let mut connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        let category = CategoriesRepository::rename(&mut connection, id, &name, &current_time()?)?;
        SearchRepository::rebuild_index(&mut connection)
            .map_err(|_| CategoryError::OperationFailed)?;
        Ok(category)
    }
    pub fn move_category(
        &self,
        id: &str,
        parent_id: Option<&str>,
        ordered_ids: &[String],
    ) -> Result<(), CategoryError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        CategoriesRepository::move_category(
            &mut connection,
            id,
            parent_id,
            ordered_ids,
            &current_time()?,
        )?;
        SearchRepository::rebuild_index(&mut connection).map_err(|_| CategoryError::OperationFailed)
    }
    pub fn impact(&self, id: &str) -> Result<CategoryDeleteImpact, CategoryError> {
        let connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        CategoriesRepository::delete_impact(&connection, id)
    }
    pub fn delete(&self, id: &str, mode: CategoryDeleteMode) -> Result<(), CategoryError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        CategoriesRepository::delete(&mut connection, id, mode, &current_time()?)?;
        SearchRepository::rebuild_index(&mut connection).map_err(|_| CategoryError::OperationFailed)
    }
    pub fn notes_by_category(
        &self,
        category_id: Option<&str>,
    ) -> Result<Vec<NoteSummary>, CategoryError> {
        let connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        let note_sort = SettingsRepository::note_sort(&connection).unwrap_or_default();
        CategoriesRepository::notes_by_category(&connection, category_id, note_sort)
    }
    pub fn set_note_category(
        &self,
        note_id: &str,
        category_id: Option<&str>,
    ) -> Result<(), CategoryError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| CategoryError::OperationFailed)?;
        let transaction = connection
            .transaction()
            .map_err(|_| CategoryError::OperationFailed)?;
        if let Some(category_id) = category_id {
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM categories WHERE id = ?1",
                    rusqlite::params![category_id],
                    |_| Ok(()),
                )
                .is_ok();
            if !exists {
                return Err(CategoryError::NotFound);
            }
        }
        let changed = transaction.execute("UPDATE notes SET category_id = ?2, updated_at = ?3 WHERE id = ?1 AND is_deleted = 0", rusqlite::params![note_id, category_id, current_time()?]).map_err(|_| CategoryError::OperationFailed)?;
        if changed == 0 {
            return Err(CategoryError::NotFound);
        }
        transaction
            .commit()
            .map_err(|_| CategoryError::OperationFailed)?;
        SearchRepository::rebuild_index(&mut connection).map_err(|_| CategoryError::OperationFailed)
    }
}
fn normalized_name(value: &str) -> Result<String, CategoryError> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 120 {
        Err(CategoryError::ValidationFailed)
    } else {
        Ok(name.to_owned())
    }
}
fn current_time() -> Result<String, CategoryError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| CategoryError::OperationFailed)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::domain::categories::{CategoryDeleteMode, CategoryError};
    use crate::repositories::bootstrap::BootstrapRepository;
    use crate::services::notes::NotesService;

    use super::CategoriesService;

    fn data_directory() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-categories-{timestamp}"));
        let _ = std::fs::create_dir_all(directory.join("database"));
        directory
    }

    #[test]
    fn enforces_depth_cycle_and_branch_delete_semantics() -> Result<(), Box<dyn std::error::Error>>
    {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let categories = CategoriesService::new(&directory);
        let first = categories.create("项目", None)?;
        let second = categories.create("第一层", Some(&first.id))?;
        let third = categories.create("第二层", Some(&second.id))?;
        let fourth = categories.create("第三层", Some(&third.id))?;
        let fifth = categories.create("第四层", Some(&fourth.id))?;
        assert!(matches!(
            categories.create("超限", Some(&fifth.id)),
            Err(CategoryError::MaxDepthExceeded)
        ));
        assert!(matches!(
            categories.move_category(&first.id, Some(&second.id), &[]),
            Err(CategoryError::CycleDetected)
        ));

        let notes = NotesService::new(&directory);
        let note = notes.create()?;
        categories.set_note_category(&note.id, Some(&second.id))?;
        categories.delete(&first.id, CategoryDeleteMode::Branch)?;
        assert!(notes.get(&note.id).is_err());
        Ok(())
    }

    #[test]
    fn moves_category_subtree_and_keeps_notes_attached() -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let categories = CategoriesService::new(&directory);
        let source_root = categories.create("原分类", None)?;
        let source_parent = categories.create("原父分类", Some(&source_root.id))?;
        let moved = categories.create("待移动分类", Some(&source_parent.id))?;
        let descendant = categories.create("子分类", Some(&moved.id))?;
        let target_root = categories.create("目标分类", None)?;
        let notes = NotesService::new(&directory);
        let note = notes.create()?;
        categories.set_note_category(&note.id, Some(&descendant.id))?;

        categories.move_category(
            &moved.id,
            Some(&target_root.id),
            std::slice::from_ref(&moved.id),
        )?;

        let moved_tree = categories.list()?;
        let target = moved_tree
            .iter()
            .find(|category| category.id == target_root.id)
            .ok_or("目标分类不存在")?;
        let moved_after = target.children.first().ok_or("移动后的分类不存在")?;
        let descendant_after = moved_after.children.first().ok_or("移动后的子分类不存在")?;
        assert_eq!(moved_after.level, 2);
        assert_eq!(descendant_after.level, 3);
        assert_eq!(descendant_after.path, "目标分类 / 待移动分类 / 子分类");

        let target_notes = categories.notes_by_category(Some(&target_root.id))?;
        assert!(target_notes.iter().any(|summary| summary.id == note.id));
        assert_eq!(notes.get(&note.id)?.category_id, Some(descendant.id));
        Ok(())
    }
}

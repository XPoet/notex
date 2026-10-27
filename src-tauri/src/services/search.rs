use std::path::{Path, PathBuf};

use crate::database::connection::open_database;
use crate::domain::search::{SearchError, SearchPage};
use crate::repositories::search::SearchRepository;

const DEFAULT_PAGE_SIZE: u32 = 30;
const MAX_PAGE_SIZE: u32 = 100;
const MAX_OFFSET: u32 = 10_000;
const MAX_QUERY_LENGTH: usize = 200;
const MAX_TERM_COUNT: usize = 12;

pub struct SearchService {
    database_path: PathBuf,
}

impl SearchService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            database_path: data_directory.join("database").join("notex.db"),
        }
    }

    pub fn search(
        &self,
        query: &str,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Result<SearchPage, SearchError> {
        let expression = normalized_expression(query)?;
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
        if offset > MAX_OFFSET || limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(SearchError::Validation);
        }
        let connection = open_database(&self.database_path).map_err(|_| SearchError::Query)?;
        SearchRepository::search(&connection, &expression, offset, limit)
    }

    pub fn rebuild(&self) -> Result<(), SearchError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| SearchError::IndexRebuild)?;
        SearchRepository::rebuild_index(&mut connection)
    }
}

fn normalized_expression(query: &str) -> Result<String, SearchError> {
    let normalized = query.trim();
    if normalized.is_empty() || normalized.chars().count() > MAX_QUERY_LENGTH {
        return Err(SearchError::Validation);
    }
    let terms = normalized.split_whitespace().collect::<Vec<_>>();
    if terms.len() > MAX_TERM_COUNT {
        return Err(SearchError::Validation);
    }
    SearchRepository::build_expression(&terms).ok_or(SearchError::Validation)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use rusqlite::params;

    use crate::database::connection::open_database;
    use crate::repositories::bootstrap::BootstrapRepository;
    use crate::repositories::search::SearchRepository;
    use crate::services::categories::CategoriesService;
    use crate::services::notes::NotesService;
    use crate::services::tags::TagsService;
    use crate::services::trash::TrashService;

    use super::SearchService;

    fn data_directory() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-search-{timestamp}"));
        let _ = std::fs::create_dir_all(directory.join("database"));
        directory
    }

    #[test]
    fn searches_title_content_category_and_tags_with_and_excluding_trash()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let notes = NotesService::new(&directory);
        let categories = CategoriesService::new(&directory);
        let tags = TagsService::new(&directory);
        let search = SearchService::new(&directory);
        let note = notes.create()?;
        notes.save(&note.id, "本地工作流", "这里记录离线数据和导出约定。")?;
        let category = categories.create("项目资料", None)?;
        categories.set_note_category(&note.id, Some(&category.id))?;
        let tag = tags.create("紧急处理")?;
        tags.set_note_tags(&note.id, std::slice::from_ref(&tag.id))?;

        assert_eq!(search.search("工作流", None, None)?.total, 1);
        assert_eq!(search.search("离线 数据", None, None)?.total, 1);
        assert_eq!(search.search("项目资料", None, None)?.total, 1);
        assert_eq!(search.search("紧急处理", None, None)?.total, 1);
        assert_eq!(search.search("工作流 紧急", None, None)?.total, 1);

        TrashService::new(&directory).trash(&note.id)?;
        assert_eq!(search.search("工作流", None, None)?.total, 0);
        Ok(())
    }

    #[test]
    fn rebuilds_a_missing_index_without_changing_original_notes()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let notes = NotesService::new(&directory);
        let note = notes.create()?;
        notes.save(&note.id, "索引恢复", "重建后仍可检索。")?;
        let connection = open_database(&directory.join("database").join("notex.db"))?;
        connection.execute("DELETE FROM notes_fts", [])?;

        let search = SearchService::new(&directory);
        assert_eq!(search.search("索引恢复", None, None)?.total, 0);
        search.rebuild()?;
        assert_eq!(search.search("索引恢复", None, None)?.items[0].id, note.id);
        Ok(())
    }

    #[test]
    fn performance_searches_and_saves_ten_thousand_notes_within_target_duration()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        let database_path = directory.join("database").join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let mut connection = open_database(&database_path)?;
        let transaction = connection.transaction()?;
        for index in 0..10_000 {
            let (title, content) = if index == 7_777 {
                ("目标文档", "用于验证十万级前的全文索引查询。")
            } else {
                ("日常记录", "普通离线笔记内容。")
            };
            transaction.execute(
                "INSERT INTO notes (id, title, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![
                    format!("note-{index}"),
                    title,
                    content,
                    "2026-07-24T00:00:00Z"
                ],
            )?;
        }
        transaction.commit()?;
        SearchRepository::rebuild_index(&mut connection)?;

        let start = Instant::now();
        let notes = NotesService::new(&directory).list()?;
        let list_elapsed = start.elapsed();
        assert!(list_elapsed < Duration::from_millis(200));
        assert_eq!(notes.len(), 10_000);

        let start = Instant::now();
        let result = SearchService::new(&directory).search("目标文档", None, None)?;
        let search_elapsed = start.elapsed();
        assert!(search_elapsed < Duration::from_millis(300));
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].id, "note-7777");

        let start = Instant::now();
        NotesService::new(&directory).save(
            "note-7777",
            "性能更新",
            "增量索引不应重建全部笔记。",
        )?;
        let save_elapsed = start.elapsed();
        assert!(save_elapsed < Duration::from_millis(200));
        assert_eq!(
            SearchService::new(&directory)
                .search("性能更新", None, None)?
                .items[0]
                .id,
            "note-7777"
        );
        eprintln!(
            "10,000 条性能夹具：列表 {} ms，搜索 {} ms，单笔记保存 {} ms。",
            list_elapsed.as_millis(),
            search_elapsed.as_millis(),
            save_elapsed.as_millis(),
        );
        Ok(())
    }
}

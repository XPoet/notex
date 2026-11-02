use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::{Connection, params};

use crate::database::connection::open_database;
use crate::domain::categories::CategoryDeleteMode;
use crate::domain::notes::NoteListRequest;
use crate::repositories::bootstrap::BootstrapRepository;
use crate::services::assets::AssetsService;
use crate::services::bootstrap::BootstrapService;
use crate::services::categories::CategoriesService;
use crate::services::notes::NotesService;
use crate::services::search::SearchService;
use crate::services::tags::TagsService;
use crate::services::trash::TrashService;

fn workspace() -> Result<(PathBuf, Connection), Box<dyn std::error::Error>> {
    let directory =
        std::env::temp_dir().join(format!("notex-performance-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(directory.join("database"))?;
    let database = directory.join("database/notex.db");
    BootstrapRepository::initialize(&database)?;
    Ok((directory, open_database(&database)?))
}

#[test]
fn pages_all_matches_with_stable_order_and_summary_filters()
-> Result<(), Box<dyn std::error::Error>> {
    let (directory, connection) = workspace()?;
    let notes = NotesService::new(&directory);
    let mut ids = HashSet::new();
    let mut target = String::new();
    for index in 0..123 {
        let note = notes.create()?;
        let body = if index == 122 {
            "needle % _".to_owned()
        } else {
            "正文 mixed text\n".repeat(500)
        };
        notes.save(&note.id, &format!("记录 {index}"), &body)?;
        if index == 122 {
            target = note.id.clone();
        }
        ids.insert(note.id);
    }
    // Force ties to exercise the ID tie-breaker rather than the clock resolution.
    connection.execute("UPDATE notes SET updated_at = 'same-time'", [])?;
    let mut offset = None;
    let mut loaded = Vec::new();
    loop {
        let page = notes.page(NoteListRequest {
            offset,
            ..Default::default()
        })?;
        assert_eq!(page.total, 123);
        assert!(page.items.len() <= 50);
        assert!(
            page.items
                .iter()
                .all(|item| item.content_preview.chars().count() <= 160)
        );
        loaded.extend(page.items.into_iter().map(|note| note.id));
        offset = page.next_offset;
        if offset.is_none() {
            break;
        }
    }
    assert_eq!(loaded.len(), 123);
    assert_eq!(loaded.iter().cloned().collect::<HashSet<_>>(), ids);
    assert!(loaded.windows(2).all(|pair| pair[0] > pair[1]));
    let matches = notes.page(NoteListRequest {
        query: Some("NEEDLE % _".to_owned()),
        ..Default::default()
    })?;
    assert_eq!(matches.total, 1);
    assert_eq!(matches.items[0].id, target);

    let categories = CategoriesService::new(&directory);
    let parent = categories.create("父级", None)?;
    let child = categories.create("子级", Some(&parent.id))?;
    categories.set_note_category(&target, Some(&child.id))?;
    let tags = TagsService::new(&directory);
    let tag = tags.create("过滤标签")?;
    tags.set_note_tags(&target, std::slice::from_ref(&tag.id))?;
    let request = NoteListRequest {
        category_id: Some(parent.id),
        tag_ids: Some(vec![tag.id.clone(), tag.id]),
        query: Some("needle".to_owned()),
        ..Default::default()
    };
    assert_eq!(notes.page(request)?.items[0].id, target);
    assert_eq!(
        notes
            .page(NoteListRequest {
                uncategorized: Some(true),
                ..Default::default()
            })?
            .total,
        122
    );
    assert!(
        notes
            .page(NoteListRequest {
                limit: Some(101),
                ..Default::default()
            })
            .is_err()
    );
    assert!(
        notes
            .page(NoteListRequest {
                category_id: Some(child.id),
                uncategorized: Some(true),
                ..Default::default()
            })
            .is_err()
    );
    Ok(())
}

#[test]
fn metadata_changes_only_refresh_affected_documents() -> Result<(), Box<dyn std::error::Error>> {
    let (directory, connection) = workspace()?;
    let notes = NotesService::new(&directory);
    let note = notes.create()?;
    notes.save(&note.id, "目标", "相关内容")?;
    let unrelated = notes.create()?;
    notes.save(&unrelated.id, "无关", "保持原样")?;
    connection.execute_batch(&format!("CREATE TRIGGER protect_unrelated BEFORE INSERT ON note_search_documents WHEN NEW.note_id = '{}' BEGIN SELECT RAISE(ABORT, 'unrelated document must not refresh'); END;", unrelated.id))?;
    let categories = CategoriesService::new(&directory);
    let parent = categories.create("旧路径", None)?;
    let child = categories.create("子路径", Some(&parent.id))?;
    let destination = categories.create("目标路径", None)?;
    categories.set_note_category(&note.id, Some(&child.id))?;
    categories.rename(&parent.id, "新路径")?;
    categories.move_category(&parent.id, Some(&destination.id), &[])?;
    let search = SearchService::new(&directory);
    assert_eq!(search.search("新路径", None, None)?.total, 1);
    assert_eq!(search.search("旧路径", None, None)?.total, 0);
    assert_eq!(search.search("目标路径", None, None)?.total, 1);
    let tags = TagsService::new(&directory);
    let tag = tags.create("旧标签")?;
    let target = tags.create("合并目标")?;
    tags.set_note_tags(&note.id, std::slice::from_ref(&tag.id))?;
    tags.rename(&tag.id, "新标签")?;
    assert_eq!(search.search("新标签", None, None)?.total, 1);
    tags.merge(&tag.id, &target.id)?;
    assert_eq!(search.search("新标签", None, None)?.total, 0);
    assert_eq!(search.search("合并目标", None, None)?.total, 1);
    tags.delete(&target.id)?;
    assert_eq!(search.search("合并目标", None, None)?.total, 0);
    categories.delete(&parent.id, CategoryDeleteMode::Current)?;
    assert_eq!(search.search("新路径", None, None)?.total, 0);
    assert_eq!(search.search("子路径", None, None)?.total, 1);
    categories.delete(&child.id, CategoryDeleteMode::Branch)?;
    assert_eq!(search.search("相关内容", None, None)?.total, 0);
    assert_eq!(search.search("保持原样", None, None)?.total, 1);
    Ok(())
}

#[test]
fn index_failure_rolls_back_metadata_content_and_empty_cleanup()
-> Result<(), Box<dyn std::error::Error>> {
    let (directory, connection) = workspace()?;
    let notes = NotesService::new(&directory);
    let note = notes.create()?;
    notes.save(&note.id, "保存前", "原文")?;
    let empty = notes.create()?;
    let categories = CategoriesService::new(&directory);
    let category = categories.create("分类", None)?;
    let tags = TagsService::new(&directory);
    let tag = tags.create("标签")?;
    tags.set_note_tags(&note.id, std::slice::from_ref(&tag.id))?;
    connection.execute_batch("ALTER TABLE notes_fts RENAME TO unavailable_notes_fts")?;
    assert!(
        categories
            .set_note_category(&note.id, Some(&category.id))
            .is_err()
    );
    assert!(notes.get(&note.id)?.category_id.is_none());
    assert!(tags.rename(&tag.id, "失败重命名").is_err());
    assert_eq!(tags.list_for_note(&note.id)?[0].name, "标签");
    assert!(tags.set_note_tags(&note.id, &[]).is_err());
    assert_eq!(tags.list_for_note(&note.id)?.len(), 1);
    assert!(tags.delete(&tag.id).is_err());
    assert_eq!(tags.list()?.len(), 1);
    assert!(notes.save(&note.id, "失败后", "不得提交").is_err());
    assert_eq!(notes.get(&note.id)?.content, "原文");
    assert_eq!(
        notes
            .list()?
            .iter()
            .find(|item| item.id == note.id)
            .map(|item| item.content_preview.as_str()),
        Some("原文")
    );
    assert!(notes.cleanup_empty(&empty.id).is_err());
    assert!(notes.get(&empty.id).is_ok());
    assert!(TrashService::new(&directory).trash(&note.id).is_err());
    assert!(notes.get(&note.id).is_ok());
    Ok(())
}

#[test]
fn reuses_valid_index_on_restart_and_restores_drafts_with_preview()
-> Result<(), Box<dyn std::error::Error>> {
    let (directory, connection) = workspace()?;
    let notes = NotesService::new(&directory);
    let note = notes.create()?;
    notes.save(&note.id, "标题", "保存正文")?;
    let document_id: i64 = connection.query_row(
        "SELECT document_id FROM note_search_documents WHERE note_id = ?1",
        params![note.id],
        |row| row.get(0),
    )?;
    connection.execute_batch("CREATE TRIGGER protect_valid_index BEFORE INSERT ON note_search_documents BEGIN SELECT RAISE(ABORT, 'valid index must be reused'); END;")?;
    BootstrapService::new(directory.clone()).bootstrap()?;
    // Re-saving an identical snapshot does not tokenize or touch the index either.
    notes.save(&note.id, "标题", "保存正文")?;
    connection.execute_batch("DROP TRIGGER protect_valid_index")?;
    notes.save_recovery_draft(
        &note.id,
        "恢复标题",
        "<b>恢复内容</b>  第二行",
        "TEST_FAILURE",
    )?;
    BootstrapService::new(directory.clone()).bootstrap()?;
    assert_eq!(notes.get(&note.id)?.content, "<b>恢复内容</b>  第二行");
    assert_eq!(notes.list()?[0].content_preview, "恢复内容 第二行");
    assert_eq!(
        SearchService::new(&directory)
            .search("恢复内容", None, None)?
            .total,
        1
    );
    assert_eq!(
        connection.query_row(
            "SELECT document_id FROM note_search_documents WHERE note_id = ?1",
            params![note.id],
            |row| row.get::<_, i64>(0)
        )?,
        document_id
    );
    assert!(!notes.cleanup_empty(&note.id)?);
    let empty = notes.create()?;
    assert!(notes.cleanup_empty(&empty.id)?);
    assert!(!notes.cleanup_empty(&empty.id)?);
    Ok(())
}

#[test]
fn thumbnail_is_bounded_png_and_keeps_note_access_checks() -> Result<(), Box<dyn std::error::Error>>
{
    let (directory, _) = workspace()?;
    let notes = NotesService::new(&directory);
    let note = notes.create()?;
    let unrelated = notes.create()?;
    let image = image::DynamicImage::new_rgb8(2400, 1600);
    let mut encoded = std::io::Cursor::new(Vec::new());
    image.write_to(&mut encoded, image::ImageFormat::Png)?;
    let assets = AssetsService::new(&directory);
    let asset = assets.save_pasted_image(&note.id, encoded.get_ref())?;
    let preview = assets.read_note_thumbnail(&note.id, &asset.relative_path)?;
    assert_eq!(image::guess_format(&preview)?, image::ImageFormat::Png);
    let decoded = image::load_from_memory(&preview)?;
    assert_eq!(decoded.width(), 1280);
    assert!(decoded.height() <= 1280);
    assert_eq!(
        assets.read_note_image(&note.id, &asset.relative_path)?,
        encoded.into_inner()
    );
    assert!(
        assets
            .read_note_thumbnail(&unrelated.id, &asset.relative_path)
            .is_err()
    );
    assert!(
        assets
            .read_note_thumbnail(&note.id, "assets/../database/notex.db")
            .is_err()
    );
    Ok(())
}

#[test]
fn recovery_index_failure_preserves_the_draft_and_original_note()
-> Result<(), Box<dyn std::error::Error>> {
    let (directory, connection) = workspace()?;
    let notes = NotesService::new(&directory);
    let note = notes.create()?;
    notes.save(&note.id, "原始标题", "原始正文")?;
    notes.save_recovery_draft(&note.id, "恢复标题", "等待恢复的正文", "TEST_FAILURE")?;
    connection.execute_batch("ALTER TABLE notes_fts RENAME TO unavailable_notes_fts")?;
    assert!(
        BootstrapService::new(directory.clone())
            .bootstrap()
            .is_err()
    );
    assert_eq!(notes.get(&note.id)?.title, "原始标题");
    assert_eq!(notes.get(&note.id)?.content, "原始正文");
    assert_eq!(notes.list()?[0].content_preview, "原始正文");
    assert_eq!(
        connection.query_row(
            "SELECT content FROM recovery_drafts WHERE note_id = ?1",
            params![note.id],
            |row| row.get::<_, String>(0)
        )?,
        "等待恢复的正文"
    );
    Ok(())
}

#[test]
fn oversized_original_is_rejected_by_pixel_budget_but_thumbnail_remains_available()
-> Result<(), Box<dyn std::error::Error>> {
    let (directory, _) = workspace()?;
    let note = NotesService::new(&directory).create()?;
    let image = image::DynamicImage::new_rgb8(3500, 2500);
    let mut encoded = std::io::Cursor::new(Vec::new());
    image.write_to(&mut encoded, image::ImageFormat::Png)?;
    assert!(encoded.get_ref().len() < 24 * 1024 * 1024);
    let assets = AssetsService::new(&directory);
    let asset = assets.save_pasted_image(&note.id, encoded.get_ref())?;
    assert!(matches!(
        assets.read_note_image(&note.id, &asset.relative_path),
        Err(crate::domain::assets::AssetError::ReadFailed)
    ));
    let thumbnail = assets.read_note_thumbnail(&note.id, &asset.relative_path)?;
    let decoded = image::load_from_memory(&thumbnail)?;
    assert!(decoded.width() <= 1280 && decoded.height() <= 1280);
    assert!(
        thumbnail.len() as u64 + u64::from(decoded.width()) * u64::from(decoded.height()) * 4
            <= 24 * 1024 * 1024
    );
    Ok(())
}

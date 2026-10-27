use std::path::{Path, PathBuf};

use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::database::connection::open_database;
use crate::domain::notes::NoteDetail;
use crate::domain::trash::{RestoreNoteResult, TrashCleanupResult, TrashError, TrashedNoteSummary};
use crate::repositories::notes::NotesRepository;
use crate::repositories::search::SearchRepository;
use crate::repositories::trash::TrashRepository;
use crate::services::assets::AssetsService;

pub struct TrashService {
    database_path: PathBuf,
    data_directory: PathBuf,
}

impl TrashService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            database_path: data_directory.join("database").join("notex.db"),
            data_directory: data_directory.to_path_buf(),
        }
    }

    pub fn trash(&self, id: &str) -> Result<(), TrashError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| TrashError::OperationFailed)?;
        TrashRepository::trash(&mut connection, id, &current_time()?)?;
        SearchRepository::rebuild_index(&mut connection).map_err(|_| TrashError::OperationFailed)
    }

    pub fn list(&self) -> Result<Vec<TrashedNoteSummary>, TrashError> {
        let connection =
            open_database(&self.database_path).map_err(|_| TrashError::OperationFailed)?;
        TrashRepository::list(&connection)
    }

    pub fn restore(&self, id: &str) -> Result<RestoreNoteResult, TrashError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| TrashError::OperationFailed)?;
        let restored_to_uncategorized =
            TrashRepository::restore(&mut connection, id, &current_time()?)?;
        SearchRepository::rebuild_index(&mut connection)
            .map_err(|_| TrashError::OperationFailed)?;
        let note: NoteDetail = NotesRepository::find_detail(&connection, id)
            .map_err(|_| TrashError::OperationFailed)?;
        Ok(RestoreNoteResult {
            note,
            restored_to_uncategorized,
        })
    }

    pub fn permanently_delete(&self, id: &str) -> Result<TrashCleanupResult, TrashError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| TrashError::OperationFailed)?;
        let mut result =
            TrashRepository::permanently_delete(&mut connection, id, &current_time()?)?;
        SearchRepository::rebuild_index(&mut connection)
            .map_err(|_| TrashError::OperationFailed)?;
        result.pending_file_cleanup_count = AssetsService::new(&self.data_directory)
            .cleanup_pending()
            .map_err(|_| TrashError::OperationFailed)?;
        Ok(result)
    }

    pub fn empty(&self) -> Result<TrashCleanupResult, TrashError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| TrashError::OperationFailed)?;
        let mut result = TrashRepository::empty(&mut connection, &current_time()?)?;
        SearchRepository::rebuild_index(&mut connection)
            .map_err(|_| TrashError::OperationFailed)?;
        result.pending_file_cleanup_count = AssetsService::new(&self.data_directory)
            .cleanup_pending()
            .map_err(|_| TrashError::OperationFailed)?;
        Ok(result)
    }
}

fn current_time() -> Result<String, TrashError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| TrashError::OperationFailed)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::repositories::bootstrap::BootstrapRepository;
    use crate::services::assets::AssetsService;
    use crate::services::notes::NotesService;

    use super::TrashService;

    fn data_directory() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-trash-{timestamp}"));
        let _ = std::fs::create_dir_all(directory.join("database"));
        directory
    }

    #[test]
    fn trashes_restores_and_permanently_deletes_a_note() -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let notes = NotesService::new(&directory);
        let note = notes.create()?;
        notes.save(&note.id, "标题", "正文")?;
        let trash = TrashService::new(&directory);

        trash.trash(&note.id)?;
        assert_eq!(trash.list()?.len(), 1);
        let restored = trash.restore(&note.id)?;
        assert!(!restored.restored_to_uncategorized);
        assert_eq!(trash.list()?.len(), 0);

        trash.trash(&note.id)?;
        assert_eq!(trash.permanently_delete(&note.id)?.deleted_note_count, 1);
        assert!(notes.get(&note.id).is_err());
        Ok(())
    }

    #[test]
    fn keeps_shared_asset_until_its_last_note_is_permanently_deleted()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        BootstrapRepository::initialize(&directory.join("database").join("notex.db"))?;
        let notes = NotesService::new(&directory);
        let first = notes.create()?;
        let second = notes.create()?;
        let assets = AssetsService::new(&directory);
        let image = valid_png()?;
        let saved = assets.save_pasted_image(&first.id, &image)?;
        assets.save_pasted_image(&second.id, &image)?;
        let file_path = directory.join(&saved.relative_path);
        let trash = TrashService::new(&directory);

        trash.trash(&first.id)?;
        trash.permanently_delete(&first.id)?;
        assert!(file_path.is_file());
        trash.trash(&second.id)?;
        trash.permanently_delete(&second.id)?;
        assert!(!file_path.exists());
        Ok(())
    }

    fn valid_png() -> Result<Vec<u8>, image::ImageError> {
        let image = image::DynamicImage::new_rgba8(1, 1);
        let mut cursor = std::io::Cursor::new(Vec::new());
        image.write_to(&mut cursor, image::ImageFormat::Png)?;
        Ok(cursor.into_inner())
    }
}

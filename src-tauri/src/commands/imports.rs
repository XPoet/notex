use tauri::{AppHandle, Manager};

use crate::domain::imports::{ImportCommandError, ImportError};
use crate::domain::notes::NoteDetail;
use crate::services::imports::ImportsService;

#[tauri::command]
pub async fn import_note(
    app: AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<NoteDetail, ImportCommandError> {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| ImportCommandError::from(ImportError::SaveFailed))?;
    tauri::async_runtime::spawn_blocking(move || {
        ImportsService::new(&data_directory).import(&file_name, &bytes)
    })
    .await
    .map_err(|_| ImportCommandError::from(ImportError::SaveFailed))?
    .map_err(ImportCommandError::from)
}

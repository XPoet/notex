use tauri::{AppHandle, Manager};

use crate::domain::notes::{
    NoteCommandError, NoteDetail, NoteListRequest, NotePage, NoteSaveResult, NoteSummary,
};
use crate::services::notes::NotesService;

#[tauri::command]
pub async fn create_note(
    app: AppHandle,
    category_id: Option<String>,
) -> Result<NoteDetail, NoteCommandError> {
    run_blocking(app, move |service| match category_id.as_deref() {
        Some(category_id) => service.create_with_category(Some(category_id)),
        None => service.create(),
    })
    .await
}

#[tauri::command]
pub async fn list_notes(app: AppHandle) -> Result<Vec<NoteSummary>, NoteCommandError> {
    run_blocking(app, |service| service.list()).await
}

#[tauri::command]
pub async fn list_note_page(
    app: AppHandle,
    request: NoteListRequest,
) -> Result<NotePage, NoteCommandError> {
    run_blocking(app, move |service| service.page(request)).await
}

#[tauri::command]
pub async fn get_note(app: AppHandle, id: String) -> Result<NoteDetail, NoteCommandError> {
    run_blocking(app, move |service| service.get(&id)).await
}

#[tauri::command]
pub async fn save_note(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
) -> Result<NoteSaveResult, NoteCommandError> {
    run_blocking(app, move |service| service.save(&id, &title, &content)).await
}

#[tauri::command]
pub async fn set_note_pinned(
    app: AppHandle,
    id: String,
    pinned: bool,
) -> Result<NoteDetail, NoteCommandError> {
    run_blocking(app, move |service| service.set_pinned(&id, pinned)).await
}

#[tauri::command]
pub async fn cleanup_empty_note(app: AppHandle, id: String) -> Result<bool, NoteCommandError> {
    run_blocking(app, move |service| service.cleanup_empty(&id)).await
}

#[tauri::command]
pub async fn save_recovery_draft(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
    failure_code: String,
) -> Result<(), NoteCommandError> {
    run_blocking(app, move |service| {
        service.save_recovery_draft(&id, &title, &content, &failure_code)
    })
    .await
}

async fn run_blocking<T, F>(app: AppHandle, task: F) -> Result<T, NoteCommandError>
where
    T: Send + 'static,
    F: FnOnce(NotesService) -> Result<T, crate::domain::notes::NoteError> + Send + 'static,
{
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| NoteCommandError::from(crate::domain::notes::NoteError::SaveFailed))?;
    tauri::async_runtime::spawn_blocking(move || task(NotesService::new(&data_directory)))
        .await
        .map_err(|_| NoteCommandError::from(crate::domain::notes::NoteError::SaveFailed))?
        .map_err(NoteCommandError::from)
}

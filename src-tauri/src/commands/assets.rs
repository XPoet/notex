use tauri::{AppHandle, Manager};

use crate::domain::assets::{AssetCommandError, AssetHealth, SavedAsset};
use crate::services::assets::AssetsService;

#[tauri::command]
pub async fn save_pasted_image(
    app: AppHandle,
    note_id: String,
    bytes: Vec<u8>,
) -> Result<SavedAsset, AssetCommandError> {
    run_blocking(app, move |service| {
        service.save_pasted_image(&note_id, &bytes)
    })
    .await
}

#[tauri::command]
pub async fn get_note_asset_health(
    app: AppHandle,
    note_id: String,
) -> Result<AssetHealth, AssetCommandError> {
    run_blocking(app, move |service| service.health(&note_id)).await
}

#[tauri::command]
pub async fn read_note_image(
    app: AppHandle,
    note_id: String,
    relative_path: String,
    thumbnail: Option<bool>,
) -> Result<tauri::ipc::Response, AssetCommandError> {
    let bytes = run_blocking(app, move |service| {
        if thumbnail.unwrap_or(false) {
            service.read_note_thumbnail(&note_id, &relative_path)
        } else {
            service.read_note_image(&note_id, &relative_path)
        }
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

async fn run_blocking<T, F>(app: AppHandle, task: F) -> Result<T, AssetCommandError>
where
    T: Send + 'static,
    F: FnOnce(AssetsService) -> Result<T, crate::domain::assets::AssetError> + Send + 'static,
{
    let data_directory = app.path().app_data_dir().map_err(|_| {
        AssetCommandError::from(crate::domain::assets::AssetError::StorageUnavailable)
    })?;
    tauri::async_runtime::spawn_blocking(move || task(AssetsService::new(&data_directory)))
        .await
        .map_err(|_| AssetCommandError::from(crate::domain::assets::AssetError::SaveFailed))?
        .map_err(AssetCommandError::from)
}

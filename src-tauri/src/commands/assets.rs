use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::domain::assets::{
    AssetCommandError, AssetError, AssetHealth, AttachmentBatch, SavedAsset,
};
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
pub async fn save_note_attachment(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<SavedAsset, AssetCommandError> {
    let note_id = request
        .headers()
        .get("x-note-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AssetCommandError::from(AssetError::NoteNotFound))?
        .to_owned();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AssetCommandError::from(AssetError::UnsupportedFile))?;
    let name =
        decode_name(name).ok_or_else(|| AssetCommandError::from(AssetError::UnsupportedFile))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AssetError::UnsupportedFile.into());
    };
    if bytes.len() > 100 * 1024 * 1024 {
        return Err(AssetError::FileTooLarge.into());
    }
    let bytes = bytes.clone();
    run_blocking(app, move |service| {
        service.save_attachment(&note_id, &name, &bytes)
    })
    .await
}

#[tauri::command]
pub async fn choose_note_attachments(
    app: AppHandle,
    note_id: String,
) -> Result<AttachmentBatch, AssetCommandError> {
    let handle = app.clone();
    run_blocking(app, move |service| {
        let paths = handle
            .dialog()
            .file()
            .add_filter(
                "附件",
                &[
                    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "png", "jpg", "jpeg",
                    "gif", "webp",
                ],
            )
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.into_path().map_err(|_| AssetError::ReadFailed))
            .collect::<Result<Vec<_>, _>>()?;
        service.import_files(&note_id, &paths)
    })
    .await
}

#[tauri::command]
pub async fn paste_note_attachments(
    app: AppHandle,
    note_id: String,
) -> Result<AttachmentBatch, AssetCommandError> {
    run_blocking(app, move |service| {
        service.import_files(&note_id, &crate::services::file_clipboard::files()?)
    })
    .await
}

#[tauri::command]
pub async fn list_note_assets(
    app: AppHandle,
    note_id: String,
) -> Result<Vec<SavedAsset>, AssetCommandError> {
    run_blocking(app, move |service| service.list(&note_id)).await
}

#[tauri::command]
pub async fn open_note_asset(
    app: AppHandle,
    note_id: String,
    relative_path: String,
) -> Result<(), AssetCommandError> {
    let handle = app.clone();
    run_blocking(app, move |service| {
        let path = service.validated_path(&note_id, &relative_path)?;
        handle
            .opener()
            .open_path(path.to_string_lossy().into_owned(), None::<String>)
            .map_err(|_| AssetError::OpenFailed)
    })
    .await
}

#[tauri::command]
pub async fn reveal_note_asset(
    app: AppHandle,
    note_id: String,
    relative_path: String,
) -> Result<(), AssetCommandError> {
    let handle = app.clone();
    run_blocking(app, move |service| {
        let path = service.linked_path(&note_id, &relative_path)?;
        handle
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|_| AssetError::OpenFailed)
    })
    .await
}

#[tauri::command]
pub async fn copy_note_asset(
    window: WebviewWindow,
    note_id: String,
    relative_path: String,
) -> Result<(), AssetCommandError> {
    run_blocking(window.app_handle().clone(), move |service| {
        let path = service.validated_path(&note_id, &relative_path)?;
        crate::services::file_clipboard::write_file(&window, &path)
    })
    .await
}

#[tauri::command]
pub async fn save_note_asset_as(
    app: AppHandle,
    note_id: String,
    relative_path: String,
) -> Result<(), AssetCommandError> {
    let handle = app.clone();
    run_blocking(app, move |service| {
        let name = service
            .list(&note_id)?
            .into_iter()
            .find(|asset| asset.relative_path == relative_path)
            .ok_or(AssetError::ReadFailed)?
            .original_name;
        if let Some(target) = handle
            .dialog()
            .file()
            .set_file_name(name)
            .blocking_save_file()
        {
            service.save_copy(
                &note_id,
                &relative_path,
                &target.into_path().map_err(|_| AssetError::ExportFailed)?,
            )?;
        }
        Ok(())
    })
    .await
}

fn decode_name(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = char::from(input.next()?).to_digit(16)?;
            let low = char::from(input.next()?).to_digit(16)?;
            bytes.push(u8::try_from(high * 16 + low).ok()?);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
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

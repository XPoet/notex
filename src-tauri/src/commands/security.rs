use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::domain::security::{
    AccessCommandError, AccessError, AccessSnapshot, ConfigurePasswordRequest,
};
use crate::services::security::{AccessState, SecurityService};

#[tauri::command]
pub async fn get_access_status(app: AppHandle) -> Result<AccessSnapshot, AccessCommandError> {
    run_blocking(app, |service, state| service.status(&state)).await
}

#[tauri::command]
pub async fn unlock_app(
    app: AppHandle,
    password: String,
) -> Result<AccessSnapshot, AccessCommandError> {
    let password = Zeroizing::new(password);
    run_blocking(app, move |service, state| service.unlock(&state, &password)).await
}

#[tauri::command]
pub async fn configure_startup_password(
    app: AppHandle,
    request: ConfigurePasswordRequest,
) -> Result<AccessSnapshot, AccessCommandError> {
    run_blocking(app, move |service, state| {
        service.configure(&state, &request)
    })
    .await
}

async fn run_blocking<F>(app: AppHandle, task: F) -> Result<AccessSnapshot, AccessCommandError>
where
    F: FnOnce(SecurityService, AccessState) -> Result<AccessSnapshot, AccessError> + Send + 'static,
{
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| AccessCommandError::from(AccessError::ReadFailed))?;
    let state = app.state::<AccessState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || task(SecurityService::new(&directory), state))
        .await
        .map_err(|_| AccessCommandError::from(AccessError::ReadFailed))?
        .map_err(AccessCommandError::from)
}

mod commands;
mod database;
mod domain;
mod repositories;
mod services;

use tauri::Manager;

use domain::security::AccessCommandError;
use services::security::AccessState;
use services::shutdown::ShutdownState;

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;
            Ok(())
        })
        .manage(services::export::ExportTaskRegistry::default())
        .manage(AccessState::default())
        .manage(ShutdownState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.state::<ShutdownState>().request(window.app_handle());
            }
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                commands::security::get_access_status,
                commands::security::unlock_app,
                commands::security::configure_startup_password,
                commands::bootstrap::bootstrap_app,
                commands::bootstrap::show_main_window,
                commands::bootstrap::exit_application,
                commands::notes::create_note,
                commands::imports::import_note,
                commands::notes::list_notes,
                commands::notes::get_note,
                commands::notes::save_note,
                commands::notes::set_note_pinned,
                commands::notes::cleanup_empty_note,
                commands::notes::save_recovery_draft,
                commands::settings::get_settings,
                commands::settings::save_settings,
                commands::settings::open_data_directory,
                commands::search::search_notes,
                commands::search::rebuild_search_index,
                commands::export::export_notes,
                commands::export::cancel_export,
                commands::export::open_export_directory,
                commands::assets::save_pasted_image,
                commands::assets::get_note_asset_health,
                commands::assets::read_note_image,
                commands::categories::list_categories,
                commands::categories::create_category,
                commands::categories::rename_category,
                commands::categories::move_category,
                commands::categories::get_category_delete_impact,
                commands::categories::delete_category,
                commands::categories::list_notes_by_category,
                commands::categories::set_note_category,
                commands::tags::list_tags,
                commands::tags::list_note_tags,
                commands::tags::create_tag,
                commands::tags::rename_tag,
                commands::tags::merge_tag,
                commands::tags::delete_tag,
                commands::tags::set_note_tags,
                commands::tags::list_notes_by_tags,
                commands::trash::trash_note,
                commands::trash::list_trashed_notes,
                commands::trash::restore_note,
                commands::trash::permanently_delete_note,
                commands::trash::empty_trash,
            ];
            move |invoke: tauri::ipc::Invoke| {
                let access = invoke.message.webview_ref().state::<AccessState>();
                if let Err(error) = access.authorize_command(invoke.message.command()) {
                    invoke.resolver.reject(AccessCommandError::from(error));
                    return true;
                }
                handler(invoke)
            }
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let shutdown = app.state::<ShutdownState>();
                if !shutdown.is_complete() {
                    api.prevent_exit();
                    shutdown.request(app);
                }
            }
        });
    Ok(())
}

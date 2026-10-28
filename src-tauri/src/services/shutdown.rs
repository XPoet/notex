use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::domain::bootstrap::BootstrapCommandError;
use crate::services::security::{AccessState, SecurityService};

const EXIT_REQUESTED_EVENT: &str = "notex-exit-requested";

#[derive(Clone, Default)]
pub struct ShutdownState(Arc<AtomicU8>);

impl ShutdownState {
    pub fn is_complete(&self) -> bool {
        self.0.load(Ordering::Acquire) == 2
    }

    fn begin(&self) -> bool {
        self.0
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn request(&self, app: &AppHandle) {
        if self.0.load(Ordering::Acquire) == 0 {
            let _ = app.emit_to("main", EXIT_REQUESTED_EVENT, ());
        }
    }

    pub async fn exit(&self, app: AppHandle) -> Result<(), BootstrapCommandError> {
        if !self.begin() {
            return Ok(());
        }
        if let Some(window) = app.get_webview_window("main") {
            if window.hide().is_err() {
                self.0.store(0, Ordering::Release);
                return Err(BootstrapCommandError::bootstrap_failed());
            }
        }
        // 尚未解锁时直接退出，避免在密码验证前读取笔记并生成明文备份。
        if !app.state::<AccessState>().is_unlocked() {
            app.state::<AccessState>().clear_backup_password();
            self.0.store(2, Ordering::Release);
            app.exit(0);
            return Ok(());
        }
        // 压缩失败只保留旧备份，不弹窗、不阻止退出；后台任务完成前保持进程存活。
        let backup_result = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            move || {
                app.path().app_data_dir().ok().and_then(|directory| {
                    SecurityService::new(&directory)
                        .create_exit_backup(&app.state::<AccessState>())
                        .ok()
                })
            }
        })
        .await;
        if !matches!(backup_result, Ok(Some(()))) {
            eprintln!("NoteX: exit backup failed; previous backup retained.");
        }
        app.state::<AccessState>().clear_backup_password();
        self.0.store(2, Ordering::Release);
        app.exit(0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Ordering, ShutdownState};

    #[test]
    fn only_starts_one_backup_before_allowing_exit() {
        let state = ShutdownState::default();
        let clone = state.clone();
        assert!(!state.is_complete());
        assert!(state.begin());
        assert!(!clone.begin());
        assert!(!state.is_complete());
        state.0.store(2, Ordering::Release);
        assert!(clone.is_complete());
        assert!(!state.begin());
    }
}

use rusqlite::ErrorCode;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub status: &'static str,
    pub schema_version: u32,
}

#[derive(Debug, Error)]
pub enum BootstrapError {
    #[error("应用数据目录不可用。")]
    DataDirectoryUnavailable,
    #[error("应用数据目录不可写。")]
    DataDirectoryNotWritable,
    #[error("无法打开本地数据库。")]
    DatabaseOpenFailed,
    #[error("本地数据库正被占用，请稍后重试。")]
    DatabaseLocked,
    #[error("本地数据库损坏，已停止继续写入。")]
    DatabaseCorrupted,
    #[error("本地数据结构初始化失败。")]
    MigrationFailed,
    #[error("本地数据初始化失败，请稍后重试。")]
    BootstrapFailed,
}

impl BootstrapError {
    pub fn from_database_error(error: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(sqlite_error, _) = error {
            return match sqlite_error.code {
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Self::DatabaseLocked,
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => Self::DatabaseCorrupted,
                _ => Self::DatabaseOpenFailed,
            };
        }
        Self::DatabaseOpenFailed
    }

    pub fn migration_failed(_: rusqlite::Error) -> Self {
        Self::MigrationFailed
    }

    pub fn migration_failed_message(_: &str) -> Self {
        Self::MigrationFailed
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapCommandError {
    pub code: &'static str,
    pub message: &'static str,
}

impl BootstrapCommandError {
    pub fn data_directory_unavailable(_: String) -> Self {
        Self::from(BootstrapError::DataDirectoryUnavailable)
    }

    pub fn bootstrap_failed() -> Self {
        Self::from(BootstrapError::BootstrapFailed)
    }
}

impl From<BootstrapError> for BootstrapCommandError {
    fn from(error: BootstrapError) -> Self {
        let (code, message) = match error {
            BootstrapError::DataDirectoryUnavailable => (
                "DATA_DIRECTORY_UNAVAILABLE",
                "无法获取应用数据目录，请检查系统账户配置后重试。",
            ),
            BootstrapError::DataDirectoryNotWritable => (
                "DATA_DIRECTORY_NOT_WRITABLE",
                "应用数据目录不可写，请检查磁盘空间和目录权限后重试。",
            ),
            BootstrapError::DatabaseOpenFailed => (
                "DATABASE_OPEN_FAILED",
                "无法打开本地数据库，请检查磁盘空间后重试。",
            ),
            BootstrapError::DatabaseLocked => (
                "DATABASE_LOCKED",
                "本地数据库正被占用，请关闭其他 NoteX 窗口后重试。",
            ),
            BootstrapError::DatabaseCorrupted => (
                "DATABASE_CORRUPTED",
                "本地数据库异常，已停止继续写入以保护现有数据。",
            ),
            BootstrapError::MigrationFailed => (
                "MIGRATION_FAILED",
                "本地数据结构初始化失败，已停止继续写入。",
            ),
            BootstrapError::BootstrapFailed => {
                ("BOOTSTRAP_FAILED", "本地数据初始化失败，请稍后重试。")
            }
        };
        Self { code, message }
    }
}

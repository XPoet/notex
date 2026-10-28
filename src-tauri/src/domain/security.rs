use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessSnapshot {
    pub password_enabled: bool,
    pub locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurePasswordRequest {
    pub current_password: Option<String>,
    pub new_password: Option<String>,
}

impl Drop for ConfigurePasswordRequest {
    fn drop(&mut self) {
        self.current_password.zeroize();
        self.new_password.zeroize();
    }
}

#[derive(Debug, Error)]
pub enum AccessError {
    #[error("请先输入开启密码解锁 NoteX。")]
    Locked,
    #[error("密码不正确，请重新输入。")]
    IncorrectPassword,
    #[error("密码需为 4～20 个字符，且不能全部为空白。")]
    InvalidPassword,
    #[error("无法读取开启密码配置，请重试。")]
    ReadFailed,
    #[error("无法保存开启密码配置，请重试。")]
    SaveFailed,
    #[error("无法同步自动备份的密码，请检查备份目录后重试。")]
    BackupSyncFailed,
    #[error("密码连续输错 5 次，请等待 30 秒后重试。")]
    TooManyAttempts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<AccessError> for AccessCommandError {
    fn from(error: AccessError) -> Self {
        let code = match error {
            AccessError::Locked => "APP_LOCKED",
            AccessError::IncorrectPassword => "PASSWORD_INCORRECT",
            AccessError::InvalidPassword => "PASSWORD_VALIDATION_FAILED",
            AccessError::ReadFailed => "PASSWORD_READ_FAILED",
            AccessError::SaveFailed => "PASSWORD_SAVE_FAILED",
            AccessError::BackupSyncFailed => "PASSWORD_BACKUP_SYNC_FAILED",
            AccessError::TooManyAttempts => "PASSWORD_TOO_MANY_ATTEMPTS",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

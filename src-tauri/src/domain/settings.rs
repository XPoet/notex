use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum AppLanguage {
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
    #[serde(rename = "zh-TW")]
    TraditionalChinese,
    #[serde(rename = "en")]
    English,
}

impl AppLanguage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SimplifiedChinese => "zh-CN",
            Self::TraditionalChinese => "zh-TW",
            Self::English => "en",
        }
    }

    pub fn from_stored(value: &str) -> Option<Self> {
        match value {
            "zh-CN" => Some(Self::SimplifiedChinese),
            "zh-TW" => Some(Self::TraditionalChinese),
            "en" => Some(Self::English),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    Light,
    Dark,
    System,
}

impl ThemePreference {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }

    pub fn from_stored(value: &str) -> Self {
        match value {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoteSort {
    #[default]
    UpdatedAt,
    CreatedAt,
    Title,
}

impl NoteSort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UpdatedAt => "updatedAt",
            Self::CreatedAt => "createdAt",
            Self::Title => "title",
        }
    }

    pub fn from_stored(value: &str) -> Self {
        match value {
            "createdAt" => Self::CreatedAt,
            "title" => Self::Title,
            _ => Self::UpdatedAt,
        }
    }

    pub const fn order_by_sql(self) -> &'static str {
        match self {
            Self::UpdatedAt => "updated_at DESC, id DESC",
            Self::CreatedAt => "created_at DESC, id DESC",
            Self::Title => "title COLLATE NOCASE ASC, id DESC",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub language: Option<AppLanguage>,
    pub theme: ThemePreference,
    pub note_sort: NoteSort,
    pub editor_font_size: u8,
    pub show_category_counts: bool,
    pub data_directory: String,
    pub default_export_directory: String,
    pub has_custom_default_export_directory: bool,
    pub app_version: String,
    pub schema_version: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsRequest {
    pub language: AppLanguage,
    pub theme: ThemePreference,
    pub note_sort: NoteSort,
    pub editor_font_size: u8,
    pub show_category_counts: bool,
    #[serde(default)]
    pub default_export_directory: Option<Option<String>>,
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("设置内容不符合要求。")]
    ValidationFailed,
    #[error("无法读取本地设置。")]
    ReadFailed,
    #[error("无法保存本地设置。")]
    SaveFailed,
    #[error("默认导出目录不可用。")]
    DirectoryUnavailable,
    #[error("默认导出目录不可写。")]
    DirectoryNotWritable,
    #[error("无法打开数据目录。")]
    OpenFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCommandError {
    pub code: &'static str,
    pub message: &'static str,
}

impl From<SettingsError> for SettingsCommandError {
    fn from(error: SettingsError) -> Self {
        let (code, message) = match error {
            SettingsError::ValidationFailed => {
                ("SETTINGS_VALIDATION_FAILED", "设置内容不符合要求。")
            }
            SettingsError::ReadFailed => ("SETTINGS_READ_FAILED", "无法读取本地设置，请稍后重试。"),
            SettingsError::SaveFailed => ("SETTINGS_SAVE_FAILED", "无法保存本地设置，请稍后重试。"),
            SettingsError::DirectoryUnavailable => (
                "SETTINGS_DIRECTORY_UNAVAILABLE",
                "默认导出目录不可用，请重新选择。",
            ),
            SettingsError::DirectoryNotWritable => (
                "SETTINGS_DIRECTORY_NOT_WRITABLE",
                "默认导出目录不可写，请选择其他目录。",
            ),
            SettingsError::OpenFailed => ("SETTINGS_OPEN_FAILED", "无法打开数据目录。"),
        };
        Self { code, message }
    }
}

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAsset {
    pub id: String,
    pub relative_path: String,
    pub original_name: String,
    pub mime_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size: i64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetHealth {
    pub missing_asset_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBatch {
    pub assets: Vec<SavedAsset>,
    pub failed_names: Vec<String>,
}

#[derive(Debug, Error)]
pub enum AssetError {
    #[error("笔记不存在或已删除。")]
    NoteNotFound,
    #[error("图片数据无效。")]
    InvalidImageData,
    #[error("暂不支持该图片格式。")]
    UnsupportedImageFormat,
    #[error("图片尺寸无效。")]
    InvalidDimensions,
    #[error("本地资源目录不可用。")]
    StorageUnavailable,
    #[error("资源文件写入失败。")]
    WriteFailed,
    #[error("资源保存失败。")]
    SaveFailed,
    #[error("资源无法读取。")]
    ReadFailed,
    #[error("不支持的附件格式或文件内容无效。")]
    UnsupportedFile,
    #[error("附件大小超过 100 MiB。")]
    FileTooLarge,
    #[error("无法使用默认应用打开附件。")]
    OpenFailed,
    #[error("附件另存为失败。")]
    ExportFailed,
    #[error("无法读取剪贴板文件。")]
    ClipboardFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCommandError {
    pub code: &'static str,
    pub message: &'static str,
}

impl From<AssetError> for AssetCommandError {
    fn from(error: AssetError) -> Self {
        let (code, message) = match error {
            AssetError::NoteNotFound => ("ASSET_NOTE_NOT_FOUND", "笔记不存在或已删除。"),
            AssetError::InvalidImageData => {
                ("INVALID_IMAGE_DATA", "图片数据无效，未插入图片引用。")
            }
            AssetError::UnsupportedImageFormat => (
                "UNSUPPORTED_IMAGE_FORMAT",
                "暂不支持该图片格式，未插入图片引用。",
            ),
            AssetError::InvalidDimensions => {
                ("IMAGE_DIMENSIONS_INVALID", "图片尺寸无效，未插入图片引用。")
            }
            AssetError::StorageUnavailable => (
                "ASSET_STORAGE_UNAVAILABLE",
                "本地资源目录不可用，未插入资源引用。",
            ),
            AssetError::WriteFailed => ("ASSET_WRITE_FAILED", "资源文件写入失败，未插入资源引用。"),
            AssetError::SaveFailed => ("ASSET_SAVE_FAILED", "资源保存失败，未插入资源引用。"),
            AssetError::ReadFailed => ("ASSET_READ_FAILED", "资源无法读取，文件缺失或内容无效。"),
            AssetError::UnsupportedFile => {
                ("ASSET_UNSUPPORTED_FILE", "不支持的附件格式或文件内容无效。")
            }
            AssetError::FileTooLarge => ("ASSET_FILE_TOO_LARGE", "附件大小超过 100 MiB。"),
            AssetError::OpenFailed => (
                "ASSET_OPEN_FAILED",
                "无法使用默认应用打开附件，请检查文件和默认应用设置。",
            ),
            AssetError::ExportFailed => ("ASSET_EXPORT_FAILED", "附件另存为失败。"),
            AssetError::ClipboardFailed => ("ASSET_CLIPBOARD_FAILED", "无法读取剪贴板文件。"),
        };
        Self { code, message }
    }
}

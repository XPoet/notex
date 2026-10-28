use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("文件名或正文不符合笔记要求。")]
    ValidationFailed,
    #[error("仅支持 MD 和 TXT 文件。")]
    UnsupportedFormat,
    #[error("文件超过 10 MiB，请拆分后导入。")]
    FileTooLarge,
    #[error("文件不是有效文本，请转换为 UTF-8 或带 BOM 的 UTF-16 后导入。")]
    InvalidEncoding,
    #[error("笔记导入失败，请重试。")]
    SaveFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<ImportError> for ImportCommandError {
    fn from(error: ImportError) -> Self {
        let code = match error {
            ImportError::ValidationFailed => "IMPORT_VALIDATION_FAILED",
            ImportError::UnsupportedFormat => "IMPORT_UNSUPPORTED_FORMAT",
            ImportError::FileTooLarge => "IMPORT_FILE_TOO_LARGE",
            ImportError::InvalidEncoding => "IMPORT_INVALID_ENCODING",
            ImportError::SaveFailed => "IMPORT_SAVE_FAILED",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

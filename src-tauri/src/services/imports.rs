use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::database::connection::open_database;
use crate::domain::imports::ImportError;
use crate::domain::notes::NoteDetail;
use crate::repositories::notes::NotesRepository;
use crate::services::notes::{current_time, validate_note};

const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;

pub struct ImportsService {
    database_path: PathBuf,
}

impl ImportsService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            database_path: data_directory.join("database").join("notex.db"),
        }
    }

    pub fn import(&self, file_name: &str, bytes: &[u8]) -> Result<NoteDetail, ImportError> {
        let title = note_title(file_name)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(ImportError::FileTooLarge);
        }
        let content = decode_text(bytes)?;
        validate_note(title, &content).map_err(|_| ImportError::ValidationFailed)?;
        let mut connection =
            open_database(&self.database_path).map_err(|_| ImportError::SaveFailed)?;
        NotesRepository::import(
            &mut connection,
            &Uuid::new_v4().to_string(),
            title,
            &content,
            &current_time().map_err(|_| ImportError::SaveFailed)?,
        )
        .map_err(|_| ImportError::SaveFailed)
    }
}

fn note_title(file_name: &str) -> Result<&str, ImportError> {
    if file_name.contains(['/', '\\']) || file_name.chars().any(char::is_control) {
        return Err(ImportError::ValidationFailed);
    }
    let (title, extension) = file_name
        .rsplit_once('.')
        .ok_or(ImportError::UnsupportedFormat)?;
    if !extension.eq_ignore_ascii_case("md") && !extension.eq_ignore_ascii_case("txt") {
        return Err(ImportError::UnsupportedFormat);
    }
    if title.trim().is_empty() || title == "." || title == ".." {
        return Err(ImportError::ValidationFailed);
    }
    Ok(title)
}

fn decode_text(bytes: &[u8]) -> Result<String, ImportError> {
    let content = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little_endian = bytes[0] == 0xff;
        let payload = &bytes[2..];
        if !payload.chunks_exact(2).remainder().is_empty() {
            return Err(ImportError::InvalidEncoding);
        }
        let units: Vec<u16> = payload
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| ImportError::InvalidEncoding)?
    } else {
        let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
        std::str::from_utf8(payload)
            .map_err(|_| ImportError::InvalidEncoding)?
            .to_owned()
    };
    if content.chars().any(|character| {
        character.is_control() && !matches!(character, '\n' | '\r' | '\t' | '\u{c}')
    }) {
        return Err(ImportError::InvalidEncoding);
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::database::connection::open_database;
    use crate::repositories::bootstrap::BootstrapRepository;
    use crate::services::notes::NotesService;
    use crate::services::search::SearchService;

    use super::{ImportError, ImportsService, MAX_FILE_BYTES};

    fn workspace() -> Result<PathBuf, Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!("notex-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("database"))?;
        BootstrapRepository::initialize(&directory.join("database/notex.db"))?;
        Ok(directory)
    }

    #[test]
    fn imports_markdown_and_txt_as_uncategorized_searchable_notes()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = workspace()?;
        let service = ImportsService::new(&directory);
        let content = "# 正文标题\r\n\r\n导入测试 **格式保留**\r\n![图片](./images/a.png)\r\n";
        let markdown = service.import("文件名.记录.MD", content.as_bytes())?;
        assert_eq!(markdown.title, "文件名.记录");
        assert_eq!(markdown.content, content);
        assert!(markdown.category_id.is_none());
        assert!(!markdown.is_pinned);
        let plain = service.import("纯文本.txt", "纯文本\n第二行".as_bytes())?;
        assert_eq!(plain.content, "纯文本\n第二行");
        assert!(plain.category_id.is_none());
        assert_eq!(NotesService::new(&directory).list()?.len(), 2);
        let search = SearchService::new(&directory);
        assert_eq!(
            search.search("文件名", None, None)?.items[0].id,
            markdown.id
        );
        assert_eq!(
            search.search("格式保留", None, None)?.items[0].id,
            markdown.id
        );
        Ok(())
    }

    #[test]
    fn preserves_same_named_notes_and_empty_files() -> Result<(), Box<dyn std::error::Error>> {
        let directory = workspace()?;
        let service = ImportsService::new(&directory);
        let first = service.import("同名.md", b"original")?;
        let second = service.import("同名.txt", b"second")?;
        let empty = service.import("空白.txt", b"")?;
        assert_ne!(first.id, second.id);
        assert_eq!(first.title, second.title);
        assert_eq!(empty.title, "空白");
        assert_eq!(empty.content, "");
        let notes = NotesService::new(&directory);
        assert_eq!(notes.get(&first.id)?.content, "original");
        assert_eq!(notes.list()?.len(), 3);
        Ok(())
    }

    #[test]
    fn decodes_utf8_bom_and_both_utf16_byte_orders_without_replacement()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = workspace()?;
        let service = ImportsService::new(&directory);
        let content = "中文与 emoji 📝\n正文";
        let mut utf8 = vec![0xef, 0xbb, 0xbf];
        utf8.extend_from_slice(content.as_bytes());
        let mut little = vec![0xff, 0xfe];
        let mut big = vec![0xfe, 0xff];
        for unit in content.encode_utf16() {
            little.extend_from_slice(&unit.to_le_bytes());
            big.extend_from_slice(&unit.to_be_bytes());
        }
        for bytes in [utf8, little, big] {
            assert_eq!(service.import("编码.txt", &bytes)?.content, content);
        }
        Ok(())
    }

    #[test]
    fn rejects_binary_and_invalid_encodings_without_creating_notes()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = workspace()?;
        let service = ImportsService::new(&directory);
        for bytes in [
            vec![0x81, 0xff],
            b"binary\0content".to_vec(),
            vec![0xff, 0xfe, 0x61],
            vec![0xff, 0xfe, 0x00, 0xd8],
            vec![0xfe, 0xff, 0xdc, 0x00],
        ] {
            assert!(matches!(
                service.import("bad.txt", &bytes),
                Err(ImportError::InvalidEncoding)
            ));
        }
        assert!(NotesService::new(&directory).list()?.is_empty());
        Ok(())
    }

    #[test]
    fn validates_names_extensions_size_and_note_limits_on_the_backend()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = workspace()?;
        let service = ImportsService::new(&directory);
        for name in [
            "../file.md",
            "C:\\file.txt",
            ".md",
            "  .txt",
            "control\n.md",
        ] {
            assert!(matches!(
                service.import(name, b"text"),
                Err(ImportError::ValidationFailed)
            ));
        }
        assert!(matches!(
            service.import("image.png", b"text"),
            Err(ImportError::UnsupportedFormat)
        ));
        assert!(matches!(
            service.import("no-extension", b"text"),
            Err(ImportError::UnsupportedFormat)
        ));
        assert!(matches!(
            service.import("large.txt", &vec![b'a'; MAX_FILE_BYTES + 1]),
            Err(ImportError::FileTooLarge)
        ));
        assert!(matches!(
            service.import("long.txt", &vec![b'a'; 4_000_001]),
            Err(ImportError::ValidationFailed)
        ));
        assert!(matches!(
            service.import(&format!("{}.md", "名".repeat(4_001)), b"text"),
            Err(ImportError::ValidationFailed)
        ));
        assert!(NotesService::new(&directory).list()?.is_empty());
        Ok(())
    }

    #[test]
    fn rolls_back_note_when_search_index_write_fails() -> Result<(), Box<dyn std::error::Error>> {
        let directory = workspace()?;
        let service = ImportsService::new(&directory);
        let first = service.import("已有笔记.md", b"keep this")?;
        // 在隔离测试库中模拟索引不可用，验证事务不会留下半成品笔记。
        let connection = open_database(&directory.join("database/notex.db"))?;
        connection.execute_batch("ALTER TABLE notes_fts RENAME TO unavailable_notes_fts")?;
        assert!(matches!(
            service.import("失败.md", b"new content"),
            Err(ImportError::SaveFailed)
        ));
        let notes = NotesService::new(&directory);
        assert_eq!(notes.list()?.len(), 1);
        assert_eq!(notes.get(&first.id)?.content, "keep this");
        Ok(())
    }
}

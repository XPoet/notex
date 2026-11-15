use std::io::{Cursor, Read};

use crate::domain::assets::AssetError;

pub(super) fn detect(
    extension: &str,
    bytes: &[u8],
) -> Result<(&'static str, &'static str), AssetError> {
    let format = match extension {
        "pdf" if bytes.starts_with(b"%PDF-") => ("pdf", "application/pdf"),
        "docx"
            if is_office_zip(
                bytes,
                "word/document.xml",
                "wordprocessingml.document.main+xml",
            ) =>
        {
            (
                "docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        }
        "pptx"
            if is_office_zip(
                bytes,
                "ppt/presentation.xml",
                "presentationml.presentation.main+xml",
            ) =>
        {
            (
                "pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        }
        "xlsx" if is_office_zip(bytes, "xl/workbook.xml", "spreadsheetml.sheet.main+xml") => (
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "doc" if has_ole_stream(bytes, &["WordDocument"]) => ("doc", "application/msword"),
        "ppt" if has_ole_stream(bytes, &["PowerPoint Document"]) => {
            ("ppt", "application/vnd.ms-powerpoint")
        }
        "xls" if has_ole_stream(bytes, &["Workbook", "Book"]) => {
            ("xls", "application/vnd.ms-excel")
        }
        _ => return Err(AssetError::UnsupportedFile),
    };
    Ok(format)
}

fn is_office_zip(bytes: &[u8], document: &str, content_type: &str) -> bool {
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return false;
    };
    if archive.len() > 20_000 || archive.by_name(document).is_err() {
        return false;
    }
    let Ok(types) = archive.by_name("[Content_Types].xml") else {
        return false;
    };
    if types.size() > 256 * 1024 {
        return false;
    }
    let mut xml = String::new();
    types.take(256 * 1024 + 1).read_to_string(&mut xml).is_ok()
        && xml.contains(content_type)
        && xml.contains(document)
}

// Follow the CFB directory chain rather than trusting the common OLE signature
// or the supplied extension. No embedded streams or macros are executed.
fn has_ole_stream(bytes: &[u8], expected: &[&str]) -> bool {
    if !bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
        || bytes.get(28..30) != Some(b"\xfe\xff")
    {
        return false;
    }
    let shift = bytes.get(30).copied().unwrap_or_default();
    if !matches!(shift, 9 | 12) || bytes.get(31) != Some(&0) {
        return false;
    }
    let sector_size = 1_usize << shift;
    let sector = |id: u32| -> Option<&[u8]> {
        let start = usize::try_from(id)
            .ok()?
            .checked_add(1)?
            .checked_mul(sector_size)?;
        bytes.get(start..start.checked_add(sector_size)?)
    };
    let mut fat_sectors = Vec::new();
    for offset in (76..512).step_by(4) {
        let Some(id) = u32_at(bytes, offset) else {
            return false;
        };
        if id < 0xffff_fffa {
            fat_sectors.push(id);
        }
    }
    let mut difat = u32_at(bytes, 68).unwrap_or(0xffff_fffe);
    let mut seen_difat = std::collections::HashSet::new();
    while difat < 0xffff_fffa {
        if !seen_difat.insert(difat) {
            return false;
        }
        let Some(data) = sector(difat) else {
            return false;
        };
        for offset in (0..sector_size - 4).step_by(4) {
            let Some(id) = u32_at(data, offset) else {
                return false;
            };
            if id < 0xffff_fffa {
                fat_sectors.push(id);
            }
        }
        difat = u32_at(data, sector_size - 4).unwrap_or(0xffff_fffe);
    }
    let mut current = u32_at(bytes, 48).unwrap_or(0xffff_fffe);
    let mut seen = std::collections::HashSet::new();
    while current < 0xffff_fffa {
        if !seen.insert(current) {
            return false;
        }
        let Some(directory) = sector(current) else {
            return false;
        };
        for entry in directory.chunks_exact(128) {
            if entry[66] != 2 {
                continue;
            }
            let length = usize::from(u16::from_le_bytes([entry[64], entry[65]]));
            if !(2..=64).contains(&length) || length % 2 != 0 {
                continue;
            }
            let name: Vec<_> = entry[..length - 2]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            if let Ok(name) = String::from_utf16(&name) {
                if expected.contains(&name.as_str()) {
                    return true;
                }
            }
        }
        let index = current as usize;
        let Some(fat_id) = fat_sectors.get(index / (sector_size / 4)) else {
            return false;
        };
        let Some(fat) = sector(*fat_id) else {
            return false;
        };
        current = u32_at(fat, index % (sector_size / 4) * 4).unwrap_or(0xffff_fffe);
    }
    false
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    let data = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes([data[0], data[1], data[2], data[3]]))
}

#[cfg(test)]
mod tests {
    use super::detect;
    use std::io::{Cursor, Write};

    #[test]
    fn validates_office_container_and_rejects_disguised_files()
    -> Result<(), Box<dyn std::error::Error>> {
        for (extension, document, mime) in [
            (
                "docx",
                "word/document.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            ),
            (
                "pptx",
                "ppt/presentation.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
            ),
            (
                "xlsx",
                "xl/workbook.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            ),
        ] {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file(document, options)?;
            zip.write_all(b"<document/>")?;
            zip.start_file("[Content_Types].xml", options)?;
            let types = format!(
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{document}" ContentType="{mime}"/></Types>"#
            );
            zip.write_all(types.as_bytes())?;
            let bytes = zip.finish()?.into_inner();
            assert_eq!(detect(extension, &bytes)?.0, extension);
            let disguised = if extension == "docx" { "xlsx" } else { "docx" };
            assert!(detect(disguised, &bytes).is_err());
        }
        assert!(detect("pdf", b"renamed executable").is_err());
        assert!(detect("doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1").is_err());
        Ok(())
    }
}

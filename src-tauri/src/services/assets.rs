use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use image::{ImageReader, Limits};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::database::connection::open_database;
use crate::domain::assets::{AssetError, AssetHealth, SavedAsset};
use crate::repositories::assets::AssetsRepository;

pub struct AssetsService {
    database_path: PathBuf,
    assets_directory: PathBuf,
    temp_directory: PathBuf,
}

impl AssetsService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            database_path: data_directory.join("database").join("notex.db"),
            assets_directory: data_directory.join("assets"),
            temp_directory: data_directory.join("temp"),
        }
    }

    pub fn save_pasted_image(&self, note_id: &str, bytes: &[u8]) -> Result<SavedAsset, AssetError> {
        let metadata = ImageMetadata::detect(bytes)?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        let now = current_time()?;
        let mut connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;

        if !AssetsRepository::note_exists(&connection, note_id)? {
            return Err(AssetError::NoteNotFound);
        }
        if let Some(asset) = AssetsRepository::find_by_hash(&connection, &hash)? {
            AssetsRepository::link_existing(&mut connection, note_id, &asset.id, &now)?;
            return Ok(asset);
        }

        self.ensure_storage_directories()?;
        let id = Uuid::new_v4().to_string();
        let file_name = format!("{id}.{}", metadata.extension);
        let relative_path = format!("assets/{file_name}");
        let temporary_path = self.temp_directory.join(format!("{id}.tmp"));
        let final_path = self.assets_directory.join(&file_name);
        write_atomically(&temporary_path, &final_path, bytes)?;

        let asset = SavedAsset {
            id,
            relative_path,
            mime_type: metadata.mime_type.to_owned(),
            width: metadata.width,
            height: metadata.height,
            size: i64::try_from(bytes.len()).map_err(|_| AssetError::InvalidImageData)?,
        };
        if let Err(error) =
            AssetsRepository::create_and_link(&mut connection, note_id, &asset, &hash, &now)
        {
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
        Ok(asset)
    }

    pub fn health(&self, note_id: &str) -> Result<AssetHealth, AssetError> {
        let connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        AssetsRepository::health(&connection, &self.assets_directory, note_id)
    }

    pub fn read_note_image(
        &self,
        note_id: &str,
        relative_path: &str,
    ) -> Result<Vec<u8>, AssetError> {
        let connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        if !AssetsRepository::is_linked(&connection, note_id, relative_path)? {
            return Err(AssetError::ReadFailed);
        }
        let path = controlled_asset_path(&self.assets_directory, relative_path)
            .map_err(|_| AssetError::ReadFailed)?;
        let directory = self
            .assets_directory
            .canonicalize()
            .map_err(|_| AssetError::ReadFailed)?;
        let path = path.canonicalize().map_err(|_| AssetError::ReadFailed)?;
        if !path.starts_with(directory) || !path.is_file() {
            return Err(AssetError::ReadFailed);
        }
        let bytes = fs::read(path).map_err(|_| AssetError::ReadFailed)?;
        if !matches!(
            image::guess_format(&bytes),
            Ok(image::ImageFormat::Png
                | image::ImageFormat::Jpeg
                | image::ImageFormat::Gif
                | image::ImageFormat::WebP)
        ) {
            return Err(AssetError::ReadFailed);
        }
        Ok(bytes)
    }

    pub fn cleanup_pending(&self) -> Result<u32, AssetError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        let paths = AssetsRepository::pending_cleanup_paths(&connection)?;
        let mut pending_count = 0;
        for relative_path in paths {
            let file_path = controlled_asset_path(&self.assets_directory, &relative_path)?;
            match fs::remove_file(file_path) {
                Ok(()) => {
                    AssetsRepository::mark_cleanup_succeeded(&mut connection, &relative_path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    AssetsRepository::mark_cleanup_succeeded(&mut connection, &relative_path)?;
                }
                Err(_) => {
                    AssetsRepository::mark_cleanup_failed(
                        &mut connection,
                        &relative_path,
                        "ASSET_FILE_DELETE_FAILED",
                    )?;
                    pending_count += 1;
                }
            }
        }
        Ok(pending_count)
    }

    fn ensure_storage_directories(&self) -> Result<(), AssetError> {
        fs::create_dir_all(&self.assets_directory).map_err(map_storage_error)?;
        fs::create_dir_all(&self.temp_directory).map_err(map_storage_error)?;
        Ok(())
    }
}

fn controlled_asset_path(
    assets_directory: &Path,
    relative_path: &str,
) -> Result<PathBuf, AssetError> {
    let Some(file_name) = relative_path.strip_prefix("assets/") else {
        return Err(AssetError::SaveFailed);
    };
    let path = Path::new(file_name);
    if path.components().count() != 1 || path.file_name().is_none() {
        return Err(AssetError::SaveFailed);
    }
    Ok(assets_directory.join(file_name))
}

fn write_atomically(
    temporary_path: &Path,
    final_path: &Path,
    bytes: &[u8],
) -> Result<(), AssetError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_path)
        .map_err(map_storage_error)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(temporary_path);
        return Err(map_storage_error(error));
    }
    drop(file);
    if let Err(error) = fs::rename(temporary_path, final_path) {
        let _ = fs::remove_file(temporary_path);
        return Err(map_storage_error(error));
    }
    // Windows 不支持以普通文件方式打开并同步目录；文件内容已在重命名前同步。
    #[cfg(unix)]
    sync_parent_directory(final_path)?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), AssetError> {
    let parent = path.parent().ok_or(AssetError::StorageUnavailable)?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(map_storage_error)
}

fn map_storage_error(error: std::io::Error) -> AssetError {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound => {
            AssetError::StorageUnavailable
        }
        _ => AssetError::WriteFailed,
    }
}

fn current_time() -> Result<String, AssetError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| AssetError::SaveFailed)
}

struct ImageMetadata {
    extension: &'static str,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

impl ImageMetadata {
    fn detect(bytes: &[u8]) -> Result<Self, AssetError> {
        let metadata = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            png_metadata(bytes)
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            jpeg_metadata(bytes)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            gif_metadata(bytes)
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            webp_metadata(bytes)
        } else {
            Err(AssetError::UnsupportedImageFormat)
        }?;
        validate_image_bytes(bytes, metadata)
    }
}

fn validate_image_bytes(
    bytes: &[u8],
    metadata: ImageMetadata,
) -> Result<ImageMetadata, AssetError> {
    let mut reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| AssetError::InvalidImageData)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(32_768);
    limits.max_image_height = Some(32_768);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| AssetError::InvalidImageData)?;
    if decoded.width() != metadata.width || decoded.height() != metadata.height {
        return Err(AssetError::InvalidImageData);
    }
    Ok(metadata)
}

fn png_metadata(bytes: &[u8]) -> Result<ImageMetadata, AssetError> {
    if bytes.len() < 24 || bytes.get(12..16) != Some(b"IHDR") {
        return Err(AssetError::InvalidImageData);
    }
    let width = read_u32_be(bytes, 16)?;
    let height = read_u32_be(bytes, 20)?;
    dimensions(width, height, "png", "image/png")
}

fn gif_metadata(bytes: &[u8]) -> Result<ImageMetadata, AssetError> {
    if bytes.len() < 10 {
        return Err(AssetError::InvalidImageData);
    }
    let width = u32::from(u16::from_le_bytes([bytes[6], bytes[7]]));
    let height = u32::from(u16::from_le_bytes([bytes[8], bytes[9]]));
    dimensions(width, height, "gif", "image/gif")
}

fn jpeg_metadata(bytes: &[u8]) -> Result<ImageMetadata, AssetError> {
    let mut index = 2;
    while index + 9 < bytes.len() {
        while bytes.get(index) == Some(&0xff) {
            index += 1;
        }
        let marker = *bytes.get(index).ok_or(AssetError::InvalidImageData)?;
        index += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
            continue;
        }
        let segment_length = usize::from(read_u16_be(bytes, index)?);
        if segment_length < 2 || index + segment_length > bytes.len() {
            return Err(AssetError::InvalidImageData);
        }
        if is_sof_marker(marker) {
            if segment_length < 8 {
                return Err(AssetError::InvalidImageData);
            }
            let height = u32::from(read_u16_be(bytes, index + 3)?);
            let width = u32::from(read_u16_be(bytes, index + 5)?);
            return dimensions(width, height, "jpg", "image/jpeg");
        }
        index += segment_length;
    }
    Err(AssetError::InvalidImageData)
}

fn webp_metadata(bytes: &[u8]) -> Result<ImageMetadata, AssetError> {
    if bytes.len() < 30 {
        return Err(AssetError::InvalidImageData);
    }
    match bytes.get(12..16) {
        Some(b"VP8X") => {
            let width = read_u24_le(bytes, 24)?
                .checked_add(1)
                .ok_or(AssetError::InvalidDimensions)?;
            let height = read_u24_le(bytes, 27)?
                .checked_add(1)
                .ok_or(AssetError::InvalidDimensions)?;
            dimensions(width, height, "webp", "image/webp")
        }
        Some(b"VP8L") => {
            if bytes.get(20) != Some(&0x2f) || bytes.len() < 25 {
                return Err(AssetError::InvalidImageData);
            }
            let width = 1 + (u32::from(bytes[21]) | (u32::from(bytes[22] & 0x3f) << 8));
            let height = 1
                + (u32::from(bytes[22] >> 6)
                    | (u32::from(bytes[23]) << 2)
                    | (u32::from(bytes[24] & 0x0f) << 10));
            dimensions(width, height, "webp", "image/webp")
        }
        Some(b"VP8 ") => {
            if bytes.get(23..26) != Some(b"\x9d\x01\x2a") || bytes.len() < 30 {
                return Err(AssetError::InvalidImageData);
            }
            let width = u32::from(read_u16_le(bytes, 26)? & 0x3fff);
            let height = u32::from(read_u16_le(bytes, 28)? & 0x3fff);
            dimensions(width, height, "webp", "image/webp")
        }
        _ => Err(AssetError::InvalidImageData),
    }
}

fn dimensions(
    width: u32,
    height: u32,
    extension: &'static str,
    mime_type: &'static str,
) -> Result<ImageMetadata, AssetError> {
    if width == 0 || height == 0 {
        return Err(AssetError::InvalidDimensions);
    }
    Ok(ImageMetadata {
        extension,
        mime_type,
        width,
        height,
    })
}

fn is_sof_marker(marker: u8) -> bool {
    matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
}

fn read_u16_be(bytes: &[u8], start: usize) -> Result<u16, AssetError> {
    let slice = bytes
        .get(start..start + 2)
        .ok_or(AssetError::InvalidImageData)?;
    Ok(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_u16_le(bytes: &[u8], start: usize) -> Result<u16, AssetError> {
    let slice = bytes
        .get(start..start + 2)
        .ok_or(AssetError::InvalidImageData)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u24_le(bytes: &[u8], start: usize) -> Result<u32, AssetError> {
    let slice = bytes
        .get(start..start + 3)
        .ok_or(AssetError::InvalidImageData)?;
    Ok(u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16))
}

fn read_u32_be(bytes: &[u8], start: usize) -> Result<u32, AssetError> {
    let slice = bytes
        .get(start..start + 4)
        .ok_or(AssetError::InvalidImageData)?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::repositories::bootstrap::BootstrapRepository;
    use crate::services::notes::NotesService;

    use super::{
        AssetsService, ImageMetadata, gif_metadata, jpeg_metadata, png_metadata, webp_metadata,
    };

    #[test]
    fn detects_png_gif_jpeg_and_webp_dimensions() -> Result<(), Box<dyn std::error::Error>> {
        let png = [
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
            0, 0, 2, 0, 0, 0, 3,
        ];
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 2, 0, 3, 0];
        let jpeg = [
            0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 3, 0, 2, 1, 0, 0xff, 0xd9,
        ];
        let webp = [
            b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'E', b'B', b'P', b'V', b'P', b'8', b'X', 10,
            0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0,
        ];
        assert_eq!(png_metadata(&png)?.width, 2);
        assert_eq!(gif_metadata(&gif)?.height, 3);
        assert_eq!(jpeg_metadata(&jpeg)?.width, 2);
        assert_eq!(webp_metadata(&webp)?.height, 3);
        Ok(())
    }

    #[test]
    fn rejects_an_image_with_only_a_valid_file_header() {
        let png_header_only = [
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
            0, 0, 2, 0, 0, 0, 3,
        ];

        assert!(ImageMetadata::detect(&png_header_only).is_err());
    }

    #[test]
    fn persists_png_and_reuses_an_existing_asset_for_another_note()
    -> Result<(), Box<dyn std::error::Error>> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let root = std::env::temp_dir().join(format!("notex-assets-{timestamp}"));
        let database_path = root.join("database").join("notex.db");
        std::fs::create_dir_all(root.join("database"))?;
        BootstrapRepository::initialize(&database_path)?;
        let notes = NotesService::new(&root);
        let first_note = notes.create()?;
        let second_note = notes.create()?;
        let service = AssetsService::new(&root);
        let png = valid_png()?;

        let asset = service.save_pasted_image(&first_note.id, &png)?;
        assert_eq!(
            service.read_note_image(&first_note.id, &asset.relative_path)?,
            png
        );
        assert!(
            service
                .read_note_image(&second_note.id, &asset.relative_path)
                .is_err()
        );
        assert!(
            service
                .read_note_image(&first_note.id, "assets/../database/notex.db")
                .is_err()
        );
        let reused = service.save_pasted_image(&second_note.id, &png)?;
        assert_eq!(asset.id, reused.id);
        assert!(root.join(&asset.relative_path).is_file());
        assert_eq!(service.health(&first_note.id)?.missing_asset_count, 0);
        Ok(())
    }

    #[test]
    fn image_preview_rejects_missing_and_invalid_files() -> Result<(), Box<dyn std::error::Error>> {
        let (root, service, note_id) = preview_fixture()?;
        let png = valid_png()?;
        let asset = service.save_pasted_image(&note_id, &png)?;
        let path = root.join(&asset.relative_path);
        std::fs::write(&path, b"not an image")?;
        assert!(
            service
                .read_note_image(&note_id, &asset.relative_path)
                .is_err()
        );
        std::fs::rename(path, root.join("missing.png"))?;
        assert!(
            service
                .read_note_image(&note_id, &asset.relative_path)
                .is_err()
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn image_preview_rejects_symlinks_outside_assets() -> Result<(), Box<dyn std::error::Error>> {
        let (root, service, note_id) = preview_fixture()?;
        let asset = service.save_pasted_image(&note_id, &valid_png()?)?;
        let path = root.join(&asset.relative_path);
        let outside = root.join("outside.png");
        std::fs::rename(&path, &outside)?;
        std::os::unix::fs::symlink(outside, path)?;
        assert!(
            service
                .read_note_image(&note_id, &asset.relative_path)
                .is_err()
        );
        Ok(())
    }

    fn preview_fixture()
    -> Result<(std::path::PathBuf, AssetsService, String), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("notex-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("database"))?;
        BootstrapRepository::initialize(&root.join("database").join("notex.db"))?;
        let note = NotesService::new(&root).create()?;
        let service = AssetsService::new(&root);
        Ok((root, service, note.id))
    }

    fn valid_png() -> Result<Vec<u8>, image::ImageError> {
        let image = image::DynamicImage::new_rgba8(1, 1);
        let mut cursor = std::io::Cursor::new(Vec::new());
        image.write_to(&mut cursor, image::ImageFormat::Png)?;
        Ok(cursor.into_inner())
    }
}

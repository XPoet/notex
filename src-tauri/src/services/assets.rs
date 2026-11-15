use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use image::{ImageReader, Limits};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::database::connection::open_database;
use crate::domain::asset_references::{is_identifier, is_managed_path};
use crate::domain::assets::{AssetError, AssetHealth, AttachmentBatch, SavedAsset};
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
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(AssetError::FileTooLarge);
        }
        let metadata = ImageMetadata::detect(bytes)?;
        let name = format!(
            "截图-{}.{}",
            OffsetDateTime::now_utc().unix_timestamp_nanos(),
            metadata.extension
        );
        self.save_attachment(note_id, &name, bytes)
    }

    pub fn save_attachment(
        &self,
        note_id: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<SavedAsset, AssetError> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(AssetError::FileTooLarge);
        }
        validate_original_name(name)?;
        let metadata = attachment_metadata(name, bytes)?;
        let now = current_time()?;
        let mut connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        if !is_identifier(note_id) || !AssetsRepository::note_exists(&connection, note_id)? {
            return Err(AssetError::NoteNotFound);
        }
        self.ensure_storage_directories()?;
        let directory = self.assets_directory.join(note_id);
        fs::create_dir_all(&directory).map_err(map_storage_error)?;
        let root = self
            .assets_directory
            .canonicalize()
            .map_err(map_storage_error)?;
        if fs::symlink_metadata(&directory)
            .map_err(map_storage_error)?
            .file_type()
            .is_symlink()
        {
            return Err(AssetError::StorageUnavailable);
        }
        let directory = directory.canonicalize().map_err(map_storage_error)?;
        if !directory.starts_with(&root) {
            return Err(AssetError::StorageUnavailable);
        }
        let id = Uuid::new_v4().to_string();
        let relative_path = format!("assets/{note_id}/{id}.{}", metadata.extension);
        let temporary_path = self.temp_directory.join(format!("{id}.tmp"));
        let final_path = directory.join(format!("{id}.{}", metadata.extension));
        write_atomically(&temporary_path, &final_path, bytes)?;
        let asset = SavedAsset {
            id,
            relative_path,
            original_name: name.to_owned(),
            mime_type: metadata.mime_type.to_owned(),
            width: metadata.width,
            height: metadata.height,
            size: i64::try_from(bytes.len()).map_err(|_| AssetError::FileTooLarge)?,
            modified_at: modified_at(&final_path),
        };
        let hash = format!("{:x}", Sha256::digest(bytes));
        if let Err(error) =
            AssetsRepository::create_and_link(&mut connection, note_id, &asset, &hash, &now)
        {
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
        Ok(asset)
    }

    pub fn import_file(&self, note_id: &str, source: &Path) -> Result<SavedAsset, AssetError> {
        let path = source.canonicalize().map_err(|_| AssetError::ReadFailed)?;
        if !path.is_file() {
            return Err(AssetError::ReadFailed);
        }
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(AssetError::UnsupportedFile)?;
        let bytes = read_bounded(&path)?;
        self.save_attachment(note_id, name, &bytes)
    }

    pub fn import_files(
        &self,
        note_id: &str,
        sources: &[PathBuf],
    ) -> Result<AttachmentBatch, AssetError> {
        if sources.len() > 100 {
            return Err(AssetError::UnsupportedFile);
        }
        let mut batch = AttachmentBatch {
            assets: Vec::new(),
            failed_names: Vec::new(),
        };
        for source in sources {
            match self.import_file(note_id, source) {
                Ok(asset) => batch.assets.push(asset),
                Err(_) => batch.failed_names.push(
                    source
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("附件")
                        .to_owned(),
                ),
            }
        }
        Ok(batch)
    }

    pub fn validated_path(
        &self,
        note_id: &str,
        relative_path: &str,
    ) -> Result<PathBuf, AssetError> {
        let path = self.linked_path(note_id, relative_path)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(AssetError::ReadFailed)?;
        attachment_metadata(name, &read_bounded(&path)?)?;
        Ok(path)
    }

    pub fn save_copy(
        &self,
        note_id: &str,
        relative_path: &str,
        target: &Path,
    ) -> Result<(), AssetError> {
        let source = self.validated_path(note_id, relative_path)?;
        let parent = target
            .parent()
            .ok_or(AssetError::ExportFailed)?
            .canonicalize()
            .map_err(|_| AssetError::ExportFailed)?;
        let name = target.file_name().ok_or(AssetError::ExportFailed)?;
        let target = parent.join(name);
        if target == source {
            return Err(AssetError::ExportFailed);
        }
        let temporary = parent.join(format!(".notex-{}.tmp", Uuid::new_v4()));
        write_atomically(&temporary, &target, &read_bounded(&source)?)
            .map_err(|_| AssetError::ExportFailed)
    }

    pub fn list(&self, note_id: &str) -> Result<Vec<SavedAsset>, AssetError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        if !AssetsRepository::note_exists(&connection, note_id)? {
            return Err(AssetError::NoteNotFound);
        }
        let mut assets = AssetsRepository::list(&connection, note_id)?;
        for asset in &mut assets {
            let Ok(path) = resolve_asset_path(&self.assets_directory, &asset.relative_path) else {
                asset.modified_at = None;
                continue;
            };
            let current_modified = modified_at(&path);
            if asset.modified_at == current_modified && current_modified.is_some() {
                continue;
            }
            let Ok(bytes) = read_bounded(&path) else {
                asset.modified_at = None;
                continue;
            };
            let Ok(metadata) = attachment_metadata(&asset.original_name, &bytes) else {
                asset.modified_at = None;
                continue;
            };
            asset.width = metadata.width;
            asset.height = metadata.height;
            asset.size = i64::try_from(bytes.len()).map_err(|_| AssetError::FileTooLarge)?;
            asset.modified_at = current_modified;
            AssetsRepository::refresh_metadata(
                &mut connection,
                asset,
                &format!("{:x}", Sha256::digest(&bytes)),
            )?;
        }
        Ok(assets)
    }

    pub fn health(&self, note_id: &str) -> Result<AssetHealth, AssetError> {
        let connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        if !AssetsRepository::note_exists(&connection, note_id)? {
            return Err(AssetError::NoteNotFound);
        }
        let assets = AssetsRepository::list(&connection, note_id)?;
        let missing = assets
            .iter()
            .filter(|asset| {
                resolve_asset_path(&self.assets_directory, &asset.relative_path).is_err()
            })
            .count();
        Ok(AssetHealth {
            missing_asset_count: u32::try_from(missing).map_err(|_| AssetError::ReadFailed)?,
        })
    }

    pub fn linked_path(&self, note_id: &str, relative_path: &str) -> Result<PathBuf, AssetError> {
        let connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        if !AssetsRepository::is_linked(&connection, note_id, relative_path)? {
            return Err(AssetError::ReadFailed);
        }
        resolve_asset_path(&self.assets_directory, relative_path)
    }

    /// Copy first, switch each association transactionally, and retain original files.
    /// Missing old images keep their original references and are retried at next startup.
    pub fn migrate_legacy(&self) -> Result<(), AssetError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        let links = AssetsRepository::legacy_links(&connection)?;
        for (note_id, old) in links {
            if !is_identifier(&note_id) {
                return Err(AssetError::SaveFailed);
            }
            let Ok(source) = resolve_asset_path(&self.assets_directory, &old.relative_path) else {
                continue;
            };
            let Ok(bytes) = read_bounded(&source) else {
                continue;
            };
            let Ok(metadata) = attachment_metadata(&old.original_name, &bytes) else {
                continue;
            };
            self.ensure_storage_directories()?;
            let directory = self.assets_directory.join(&note_id);
            fs::create_dir_all(&directory).map_err(map_storage_error)?;
            let canonical_root = self
                .assets_directory
                .canonicalize()
                .map_err(map_storage_error)?;
            if !directory
                .canonicalize()
                .map_err(map_storage_error)?
                .starts_with(&canonical_root)
            {
                return Err(AssetError::StorageUnavailable);
            }
            let id = Uuid::new_v4().to_string();
            let target = directory.join(format!("{id}.{}", metadata.extension));
            write_atomically(
                &self.temp_directory.join(format!("{id}.tmp")),
                &target,
                &bytes,
            )?;
            let copied = match read_bounded(&target) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = fs::remove_file(&target);
                    return Err(error);
                }
            };
            if Sha256::digest(&copied) != Sha256::digest(&bytes) {
                let _ = fs::remove_file(&target);
                return Err(AssetError::WriteFailed);
            }
            let asset = SavedAsset {
                id: id.clone(),
                relative_path: format!("assets/{note_id}/{id}.{}", metadata.extension),
                original_name: old.original_name,
                mime_type: metadata.mime_type.to_owned(),
                width: metadata.width,
                height: metadata.height,
                size: i64::try_from(bytes.len()).map_err(|_| AssetError::FileTooLarge)?,
                modified_at: modified_at(&target),
            };
            let hash = format!("{:x}", Sha256::digest(&bytes));
            if let Err(error) = AssetsRepository::migrate_link(
                &mut connection,
                &note_id,
                &old.id,
                &asset,
                &hash,
                &current_time()?,
            ) {
                let _ = fs::remove_file(&target);
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn read_note_image(
        &self,
        note_id: &str,
        relative_path: &str,
    ) -> Result<Vec<u8>, AssetError> {
        let bytes = self.read_note_image_bytes(note_id, relative_path)?;
        let mut reader = ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|_| AssetError::ReadFailed)?;
        let mut limits = Limits::default();
        limits.max_image_width = Some(32_768);
        limits.max_image_height = Some(32_768);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        // Inspect dimensions without decoding the original into another pixel buffer.
        let (width, height) = reader
            .into_dimensions()
            .map_err(|_| AssetError::ReadFailed)?;
        let encoded_size = u64::try_from(bytes.len()).map_err(|_| AssetError::ReadFailed)?;
        let memory_cost = u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .and_then(|decoded_size| decoded_size.checked_add(encoded_size))
            .ok_or(AssetError::ReadFailed)?;
        if width == 0
            || height == 0
            || width > 32_768
            || height > 32_768
            || memory_cost > 24 * 1024 * 1024
        {
            return Err(AssetError::ReadFailed);
        }
        Ok(bytes)
    }

    fn read_note_image_bytes(
        &self,
        note_id: &str,
        relative_path: &str,
    ) -> Result<Vec<u8>, AssetError> {
        let path = self.linked_path(note_id, relative_path)?;
        let bytes = read_bounded(&path)?;
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

    pub fn read_note_thumbnail(
        &self,
        note_id: &str,
        relative_path: &str,
    ) -> Result<Vec<u8>, AssetError> {
        let bytes = self.read_note_image_bytes(note_id, relative_path)?;
        let mut reader = ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| AssetError::ReadFailed)?;
        let mut limits = Limits::default();
        limits.max_image_width = Some(32_768);
        limits.max_image_height = Some(32_768);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(|_| AssetError::ReadFailed)?;
        let thumbnail = if image.width() > 1280 || image.height() > 1280 {
            image.thumbnail(1280, 1280)
        } else {
            image
        };
        let mut output = std::io::Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| AssetError::ReadFailed)?;
        Ok(output.into_inner())
    }

    pub fn cleanup_pending(&self) -> Result<u32, AssetError> {
        let mut connection =
            open_database(&self.database_path).map_err(|_| AssetError::StorageUnavailable)?;
        let paths = AssetsRepository::pending_cleanup_paths(&connection)?;
        let mut pending_count = 0;
        for relative_path in paths {
            let file_path = controlled_asset_path(&self.assets_directory, &relative_path)?;
            if file_path.try_exists().map_err(|_| AssetError::ReadFailed)?
                && resolve_asset_path(&self.assets_directory, &relative_path).is_err()
            {
                AssetsRepository::mark_cleanup_failed(
                    &mut connection,
                    &relative_path,
                    "ASSET_PATH_INVALID",
                )?;
                pending_count += 1;
                continue;
            }
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
        let root = self
            .assets_directory
            .parent()
            .ok_or(AssetError::StorageUnavailable)?
            .canonicalize()
            .map_err(map_storage_error)?;
        for directory in [&self.assets_directory, &self.temp_directory] {
            if !directory
                .canonicalize()
                .map_err(map_storage_error)?
                .starts_with(&root)
            {
                return Err(AssetError::StorageUnavailable);
            }
        }
        Ok(())
    }
}

fn controlled_asset_path(
    assets_directory: &Path,
    relative_path: &str,
) -> Result<PathBuf, AssetError> {
    if !is_managed_path(relative_path) {
        return Err(AssetError::SaveFailed);
    }
    let relative = relative_path
        .strip_prefix("assets/")
        .ok_or(AssetError::SaveFailed)?;
    Ok(assets_directory.join(relative))
}

pub(super) fn resolve_asset_path(
    assets_directory: &Path,
    relative_path: &str,
) -> Result<PathBuf, AssetError> {
    let path = controlled_asset_path(assets_directory, relative_path)?;
    let root = assets_directory
        .canonicalize()
        .map_err(|_| AssetError::ReadFailed)?;
    let data_root = assets_directory
        .parent()
        .ok_or(AssetError::ReadFailed)?
        .canonicalize()
        .map_err(|_| AssetError::ReadFailed)?;
    if !root.starts_with(&data_root) {
        return Err(AssetError::ReadFailed);
    }
    let mut component_path = assets_directory.to_path_buf();
    for component in relative_path
        .strip_prefix("assets/")
        .ok_or(AssetError::ReadFailed)?
        .split('/')
    {
        component_path.push(component);
        if fs::symlink_metadata(&component_path)
            .map_err(|_| AssetError::ReadFailed)?
            .file_type()
            .is_symlink()
        {
            return Err(AssetError::ReadFailed);
        }
    }
    let path = path.canonicalize().map_err(|_| AssetError::ReadFailed)?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(AssetError::ReadFailed);
    }
    Ok(path)
}

const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

fn read_bounded(path: &Path) -> Result<Vec<u8>, AssetError> {
    let file = fs::File::open(path).map_err(|_| AssetError::ReadFailed)?;
    if file.metadata().map_err(|_| AssetError::ReadFailed)?.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(AssetError::FileTooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_ATTACHMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AssetError::ReadFailed)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AssetError::FileTooLarge);
    }
    Ok(bytes)
}

fn modified_at(path: &Path) -> Option<String> {
    Some(
        fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .to_string(),
    )
}

fn validate_original_name(name: &str) -> Result<(), AssetError> {
    if name.is_empty()
        || name.len() > 1024
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(AssetError::UnsupportedFile);
    }
    Ok(())
}

struct AttachmentMetadata {
    extension: &'static str,
    mime_type: &'static str,
    width: Option<u32>,
    height: Option<u32>,
}

fn attachment_metadata(name: &str, bytes: &[u8]) -> Result<AttachmentMetadata, AssetError> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or(AssetError::UnsupportedFile)?;
    if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        let image = ImageMetadata::detect(bytes)?;
        if extension != image.extension && !(extension == "jpeg" && image.extension == "jpg") {
            return Err(AssetError::UnsupportedFile);
        }
        return Ok(AttachmentMetadata {
            extension: image.extension,
            mime_type: image.mime_type,
            width: Some(image.width),
            height: Some(image.height),
        });
    }
    let (extension, mime_type) = super::file_formats::detect(&extension, bytes)?;
    Ok(AttachmentMetadata {
        extension,
        mime_type,
        width: None,
        height: None,
    })
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
    fn persists_independent_copies_for_each_note() -> Result<(), Box<dyn std::error::Error>> {
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
        assert_ne!(asset.id, reused.id);
        assert!(
            reused
                .relative_path
                .starts_with(&format!("assets/{}/", second_note.id))
        );
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
    #[test]
    fn stores_named_documents_and_refreshes_external_edits_without_changing_other_notes()
    -> Result<(), Box<dyn std::error::Error>> {
        let (root, service, note_id) = preview_fixture()?;
        let other = NotesService::new(&root).create()?;
        let original = b"%PDF-1.7\noriginal\n%%EOF";
        let file = service.save_attachment(&note_id, "报告 [终稿].pdf", original)?;
        let separate = service.save_attachment(&other.id, "报告 [终稿].pdf", original)?;
        assert_eq!(file.original_name, "报告 [终稿].pdf");
        assert_eq!(file.width, None);
        assert_ne!(file.id, separate.id);
        let edited = b"%PDF-1.7\nexternally edited document\n%%EOF";
        std::fs::write(root.join(&file.relative_path), edited)?;
        let refreshed = service.list(&note_id)?;
        assert_eq!(refreshed[0].size, edited.len() as i64);
        assert_eq!(std::fs::read(root.join(separate.relative_path))?, original);
        assert!(service.linked_path(&other.id, &file.relative_path).is_err());
        assert!(
            service
                .save_attachment(&note_id, "伪装.pdf", b"executable")
                .is_err()
        );
        assert!(
            service
                .save_attachment(&note_id, "../outside.pdf", original)
                .is_err()
        );
        assert!(
            service
                .validated_path(&note_id, "assets/../database/notex.db")
                .is_err()
        );
        Ok(())
    }

    fn legacy_fixture()
    -> Result<(std::path::PathBuf, AssetsService, String, String), Box<dyn std::error::Error>> {
        let (root, service, first) = preview_fixture()?;
        let second = NotesService::new(&root).create()?.id;
        std::fs::create_dir_all(root.join("assets"))?;
        std::fs::write(root.join("assets/legacy.png"), valid_png()?)?;
        let mut connection =
            crate::database::connection::open_database(&root.join("database/notex.db"))?;
        let transaction = connection.transaction()?;
        transaction.execute("INSERT INTO assets (id, file_name, original_name, extension, relative_path, mime_type, size, width, height, hash, created_at) VALUES ('legacy', 'legacy.png', '旧图.png', 'png', 'assets/legacy.png', 'image/png', 1, 1, 1, 'legacy', '2026-01-01T00:00:00Z')", [])?;
        for id in [&first, &second] {
            transaction.execute("INSERT INTO note_assets (note_id, asset_id, created_at) VALUES (?1, 'legacy', '2026-01-01T00:00:00Z')", [id])?;
            transaction.execute("UPDATE notes SET content = '![旧图](./assets/legacy.png)', updated_at = '2026-01-01T00:00:00Z' WHERE id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok((root, service, first, second))
    }

    #[test]
    fn migration_copies_shared_images_rewrites_recovery_and_preserves_originals_idempotently()
    -> Result<(), Box<dyn std::error::Error>> {
        let (root, service, first, second) = legacy_fixture()?;
        let notes = NotesService::new(&root);
        notes.save_recovery_draft(
            &first,
            "草稿",
            "恢复 ![图](./assets/legacy.png)",
            "NOTE_SAVE_FAILED",
        )?;
        crate::services::trash::TrashService::new(&root).trash(&second)?;
        service.migrate_legacy()?;
        service.migrate_legacy()?;
        let first_asset = service.list(&first)?.remove(0);
        let connection =
            crate::database::connection::open_database(&root.join("database/notex.db"))?;
        let second_asset =
            crate::repositories::assets::AssetsRepository::list(&connection, &second)?.remove(0);
        assert_ne!(first_asset.relative_path, second_asset.relative_path);
        assert!(root.join("assets/legacy.png").is_file());
        assert_eq!(
            std::fs::read(root.join(&first_asset.relative_path))?,
            valid_png()?
        );
        assert_eq!(notes.get(&first)?.updated_at, "2026-01-01T00:00:00Z");
        assert!(
            notes
                .get(&first)?
                .content
                .contains(&first_asset.relative_path)
        );
        let draft: String = connection.query_row(
            "SELECT content FROM recovery_drafts WHERE note_id = ?1",
            [&first],
            |row| row.get(0),
        )?;
        assert!(draft.contains(&first_asset.relative_path));
        assert_eq!(
            connection.query_row("SELECT COUNT(*) FROM assets", [], |row| row
                .get::<_, u32>(0))?,
            2
        );
        crate::services::trash::TrashService::new(&root).restore(&second)?;
        assert!(
            service
                .read_note_image(&second, &second_asset.relative_path)
                .is_ok()
        );
        Ok(())
    }

    #[test]
    fn failed_migration_keeps_original_associations_and_cleans_only_its_new_copy()
    -> Result<(), Box<dyn std::error::Error>> {
        let (root, service, first, _) = legacy_fixture()?;
        let connection =
            crate::database::connection::open_database(&root.join("database/notex.db"))?;
        connection.execute_batch("CREATE TRIGGER reject_copy BEFORE INSERT ON note_assets WHEN NEW.asset_id != 'legacy' BEGIN SELECT RAISE(ABORT, 'injected'); END;")?;
        assert!(service.migrate_legacy().is_err());
        assert!(root.join("assets/legacy.png").is_file());
        assert_eq!(
            NotesService::new(&root).get(&first)?.content,
            "![旧图](./assets/legacy.png)"
        );
        assert_eq!(
            connection.query_row("SELECT COUNT(*) FROM assets", [], |row| row
                .get::<_, u32>(0))?,
            1
        );
        Ok(())
    }
}

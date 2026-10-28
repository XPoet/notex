use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use zip::{
    AesMode, CompressionMethod, ZipArchive, ZipWriter,
    write::{FileOptions, SimpleFileOptions},
};

use crate::database::connection::open_database;
use crate::domain::export::{ExportError, ExportScopeKind};
use crate::repositories::export::{ExportCategory, ExportRepository};
use crate::services::export::{
    ExportLayout, asset_reference, controlled_asset_file_name, replace_asset_reference,
};

pub struct BackupService {
    data_directory: PathBuf,
}

impl BackupService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            data_directory: data_directory.to_path_buf(),
        }
    }

    pub fn create_latest(&self, password: Option<&str>) -> Result<(), ExportError> {
        self.recover_pending_update(password)?;
        let mut update = self.prepare_latest(password)?;
        update.apply()?;
        update.finish()
    }

    fn prepare_latest(&self, password: Option<&str>) -> Result<BackupUpdate, ExportError> {
        let root = self
            .data_directory
            .canonicalize()
            .map_err(|_| ExportError::Write)?;
        let database_path = root.join("database/notex.db");
        // 启动失败时不创建空数据库，也不覆盖已有备份。
        if !database_path.is_file() {
            return Err(ExportError::Snapshot);
        }
        let database_path = database_path
            .canonicalize()
            .map_err(|_| ExportError::Snapshot)?;
        if !database_path.starts_with(&root) {
            return Err(ExportError::Snapshot);
        }
        let mut connection = open_database(&database_path).map_err(|_| ExportError::Snapshot)?;
        let snapshot = ExportRepository::snapshot_all(&mut connection)?;
        let directory = root.join("backups");
        fs::create_dir_all(&directory).map_err(|_| ExportError::Write)?;
        let directory = directory.canonicalize().map_err(|_| ExportError::Write)?;
        if !directory.starts_with(&root) {
            return Err(ExportError::Write);
        }
        self.prepare_archive(&directory, |archive| {
            let options = file_options(password);
            let empty = snapshot.notes.is_empty();
            let mut layout = ExportLayout::new(PathBuf::new());
            let uncategorized = [ExportCategory {
                id: "uncategorized".to_owned(),
                name: "未分类".to_owned(),
            }];
            let uncategorized_directory =
                layout.markdown_directory(ExportScopeKind::Category, "", "", &uncategorized)?;
            let mut copied_assets = HashSet::new();
            let mut copied_names = HashSet::new();
            for note in snapshot.notes {
                let directory = if note.category_path.is_empty() {
                    uncategorized_directory.clone()
                } else {
                    layout.markdown_directory(
                        ExportScopeKind::CategoryWithDescendants,
                        "",
                        "",
                        &note.category_path,
                    )?
                };
                let markdown_path = layout.markdown_path(&directory, &note.title, &note.id)?;
                let mut content = note.content;
                for asset in note.assets {
                    let name = controlled_asset_file_name(&asset)?;
                    if name.contains(['/', '\\']) {
                        return Err(ExportError::Write);
                    }
                    let reference = asset_reference(&markdown_path, Path::new(""), name)?;
                    content = replace_asset_reference(&content, &asset.relative_path, &reference);
                    if !copied_assets.insert(asset.id.clone()) {
                        continue;
                    }
                    if !copied_names.insert(name.to_owned()) {
                        return Err(ExportError::Write);
                    }
                    let assets_directory = root
                        .join("assets")
                        .canonicalize()
                        .map_err(|_| ExportError::Write)?;
                    let source_path = assets_directory
                        .join(name)
                        .canonicalize()
                        .map_err(|_| ExportError::Write)?;
                    if !assets_directory.starts_with(&root)
                        || !source_path.starts_with(&assets_directory)
                    {
                        return Err(ExportError::Write);
                    }
                    let mut source = File::open(source_path).map_err(|_| ExportError::Write)?;
                    archive
                        .start_file(format!("assets/{name}"), options)
                        .map_err(|_| ExportError::Write)?;
                    io::copy(&mut source, archive).map_err(|_| ExportError::Write)?;
                }
                archive
                    .start_file(archive_path(&markdown_path)?, options)
                    .map_err(|_| ExportError::Write)?;
                archive
                    .write_all(content.as_bytes())
                    .map_err(|_| ExportError::Write)?;
            }
            if empty && password.is_some() {
                write_empty_marker(archive, options)?;
            }
            Ok(())
        })
    }

    pub fn prepare_password_change(
        &self,
        old_password: Option<&str>,
        new_password: Option<&str>,
    ) -> Result<Option<BackupUpdate>, ExportError> {
        self.recover_pending_update(old_password)?;
        let Some(directory) = self.existing_directory()? else {
            return Ok(None);
        };
        let path = directory.join("NoteX-latest.zip");
        if !regular_file_exists(&path)? {
            return Ok(None);
        }
        let source = File::open(&path).map_err(|_| ExportError::Write)?;
        let mut source = ZipArchive::new(source).map_err(|_| ExportError::Write)?;
        self.prepare_archive(&directory, |archive| {
            let options = file_options(new_password);
            let mut count = 0;
            for index in 0..source.len() {
                let mut entry = match old_password {
                    Some(password) => source.by_index_decrypt(index, password.as_bytes()),
                    None => source.by_index(index),
                }
                .map_err(|_| ExportError::Write)?;
                if entry.is_dir() {
                    continue;
                }
                let name = entry.enclosed_name().ok_or(ExportError::Write)?;
                archive
                    .start_file(archive_path(&name)?, options)
                    .map_err(|_| ExportError::Write)?;
                io::copy(&mut entry, archive).map_err(|_| ExportError::Write)?;
                count += 1;
            }
            if count == 0 && new_password.is_some() {
                write_empty_marker(archive, options)?;
            }
            Ok(())
        })
        .map(Some)
    }

    pub fn ensure_encrypted(&self, password: &str) -> Result<(), ExportError> {
        self.recover_pending_update(Some(password))?;
        let Some(directory) = self.existing_directory()? else {
            return Ok(());
        };
        let path = directory.join("NoteX-latest.zip");
        if !regular_file_exists(&path)? {
            return Ok(());
        }
        if !archive_matches_password(&path, Some(password))? {
            if let Some(mut update) =
                self.prepare_password_change(Some(password), Some(password))?
            {
                update.apply()?;
                update.finish()?;
            }
        }
        Ok(())
    }

    pub fn recover_pending_update(&self, password: Option<&str>) -> Result<(), ExportError> {
        let Some(directory) = self.existing_directory()? else {
            return Ok(());
        };
        let rollback = directory.join("NoteX-latest.zip.rollback");
        if regular_file_exists(&rollback)? {
            let latest = directory.join("NoteX-latest.zip");
            if regular_file_exists(&latest)? && archive_matches_password(&latest, password)? {
                fs::remove_file(&rollback).map_err(|_| ExportError::Write)?;
            } else if archive_matches_password(&rollback, password)? {
                fs::rename(&rollback, &latest).map_err(|_| ExportError::Write)?;
            } else {
                return Err(ExportError::Write);
            }
        }
        let temporary = directory.join("NoteX-latest.zip.part");
        if regular_file_exists(&temporary)? {
            fs::remove_file(temporary).map_err(|_| ExportError::Write)?;
        }
        Ok(())
    }

    fn existing_directory(&self) -> Result<Option<PathBuf>, ExportError> {
        if !self
            .data_directory
            .try_exists()
            .map_err(|_| ExportError::Write)?
        {
            return Ok(None);
        }
        let root = self
            .data_directory
            .canonicalize()
            .map_err(|_| ExportError::Write)?;
        let directory = root.join("backups");
        if !directory.try_exists().map_err(|_| ExportError::Write)? {
            return Ok(None);
        }
        let directory = directory.canonicalize().map_err(|_| ExportError::Write)?;
        if !directory.starts_with(root) {
            return Err(ExportError::Write);
        }
        Ok(Some(directory))
    }

    fn prepare_archive<F>(&self, directory: &Path, write: F) -> Result<BackupUpdate, ExportError>
    where
        F: FnOnce(&mut ZipWriter<File>) -> Result<(), ExportError>,
    {
        let final_path = directory.join("NoteX-latest.zip");
        let rollback_path = directory.join("NoteX-latest.zip.rollback");
        regular_file_exists(&final_path)?;
        if fs::symlink_metadata(&rollback_path).is_ok() {
            return Err(ExportError::Write);
        }
        let temporary_path = directory.join("NoteX-latest.zip.part");
        if let Ok(metadata) = fs::symlink_metadata(&temporary_path) {
            if !metadata.file_type().is_file() {
                return Err(ExportError::Write);
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|_| ExportError::Write)?;
        let result = (|| {
            let mut archive = ZipWriter::new(file);
            write(&mut archive)?;
            let file = archive.finish().map_err(|_| ExportError::Write)?;
            file.sync_all().map_err(|_| ExportError::Write)?;
            Ok(())
        })();
        if result.is_err() {
            // 仅清理本次生成的中间文件，上一份完整备份始终保留。
            let _ = fs::remove_file(&temporary_path);
        }
        result?;
        Ok(BackupUpdate {
            temporary_path,
            final_path,
            rollback_path,
            previous_moved: false,
            published: false,
            complete: false,
        })
    }
}

pub struct BackupUpdate {
    temporary_path: PathBuf,
    final_path: PathBuf,
    rollback_path: PathBuf,
    previous_moved: bool,
    published: bool,
    complete: bool,
}

impl BackupUpdate {
    pub fn apply(&mut self) -> Result<(), ExportError> {
        if regular_file_exists(&self.final_path)? {
            fs::rename(&self.final_path, &self.rollback_path).map_err(|_| ExportError::Write)?;
            self.previous_moved = true;
        }
        fs::rename(&self.temporary_path, &self.final_path).map_err(|_| ExportError::Write)?;
        self.published = true;
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), ExportError> {
        if self.previous_moved {
            fs::remove_file(&self.rollback_path).map_err(|_| ExportError::Write)?;
        }
        self.complete = true;
        Ok(())
    }

    pub fn rollback(&mut self) -> Result<(), ExportError> {
        if self.previous_moved {
            fs::rename(&self.rollback_path, &self.final_path).map_err(|_| ExportError::Write)?;
            self.previous_moved = false;
        } else if self.published {
            fs::rename(&self.final_path, &self.temporary_path).map_err(|_| ExportError::Write)?;
        }
        self.published = false;
        if self.temporary_path.is_file() {
            fs::remove_file(&self.temporary_path).map_err(|_| ExportError::Write)?;
        }
        self.complete = true;
        Ok(())
    }
}

impl Drop for BackupUpdate {
    fn drop(&mut self) {
        if !self.complete && self.rollback().is_err() {
            eprintln!("NoteX: backup rollback failed; recovery files retained.");
        }
    }
}

fn regular_file_exists(path: &Path) -> Result<bool, ExportError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        _ => Err(ExportError::Write),
    }
}

fn file_options(password: Option<&str>) -> FileOptions<'_, ()> {
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(true);
    match password {
        Some(password) => options.with_aes_encryption(AesMode::Aes256, password),
        None => options,
    }
}

fn archive_matches_password(path: &Path, password: Option<&str>) -> Result<bool, ExportError> {
    let source = File::open(path).map_err(|_| ExportError::Write)?;
    let Ok(mut archive) = ZipArchive::new(source) else {
        return Ok(false);
    };
    if archive.is_empty() {
        return Ok(password.is_none());
    }
    let mut files = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| ExportError::Write)?;
        if entry.is_dir() {
            continue;
        }
        files += 1;
        if entry.encrypted() != password.is_some() {
            return Ok(false);
        }
        drop(entry);
        let entry = match password {
            Some(password) => archive.by_index_decrypt(index, password.as_bytes()),
            None => archive.by_index(index),
        };
        let Ok(mut entry) = entry else {
            return Ok(false);
        };
        if io::copy(&mut entry, &mut io::sink()).is_err() {
            return Ok(false);
        }
    }
    Ok(files > 0 || password.is_none())
}

fn write_empty_marker(
    archive: &mut ZipWriter<File>,
    options: FileOptions<'_, ()>,
) -> Result<(), ExportError> {
    archive
        .start_file("NoteX-backup.txt", options)
        .map_err(|_| ExportError::Write)?;
    archive
        .write_all("NoteX 自动备份：暂无笔记。".as_bytes())
        .map_err(|_| ExportError::Write)
}

fn archive_path(path: &Path) -> Result<String, ExportError> {
    path.components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str().ok_or(ExportError::Write),
            _ => Err(ExportError::Write),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|components| components.join("/"))
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use rusqlite::params;
    use uuid::Uuid;
    use zip::ZipArchive;

    use crate::repositories::bootstrap::BootstrapRepository;

    use super::*;

    fn fixture() -> Result<PathBuf, Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!("notex-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(directory.join("database"))?;
        fs::create_dir_all(directory.join("assets"))?;
        let database = directory.join("database/notex.db");
        BootstrapRepository::initialize(&database)?;
        let mut connection = open_database(&database)?;
        let transaction = connection.transaction()?;
        for (id, name, parent_id, level) in [
            ("root", "工作", None, 1),
            ("child", "项目", Some("root"), 2),
            ("same-name", "未分类", None, 1),
            ("assets-name", "assets", None, 1),
        ] {
            transaction.execute(
                "INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')",
                params![id, name, parent_id, level],
            )?;
        }
        for (id, title, category, deleted) in [
            ("root-note", "说明", Some("root"), 0),
            ("child-note", "说明", Some("child"), 0),
            ("uncategorized", "说明", None, 0),
            ("duplicate", "说明", Some("child"), 0),
            ("same-name-note", "说明", Some("same-name"), 0),
            ("assets-name-note", "说明", Some("assets-name"), 0),
            ("deleted", "回收站内容", Some("root"), 1),
        ] {
            transaction.execute(
                "INSERT INTO notes (id, title, content, category_id, is_deleted, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')",
                params![id, title, "备份正文".repeat(1000), category, deleted],
            )?;
        }
        transaction.commit()?;
        Ok(directory)
    }

    fn attach_image(directory: &Path, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut connection = open_database(&directory.join("database/notex.db"))?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO assets (id, file_name, extension, relative_path, mime_type, size, width, height, hash, created_at)
             VALUES ('image', ?1, 'png', ?2, 'image/png', 3, 1, 1, 'backup-test-hash', '2026-10-22T00:00:00Z')",
            params![name, format!("assets/{name}")],
        )?;
        for id in ["root-note", "child-note"] {
            transaction.execute(
                "INSERT INTO note_assets (note_id, asset_id, created_at)
                 VALUES (?1, 'image', '2026-10-22T00:00:00Z')",
                params![id],
            )?;
            transaction.execute(
                "UPDATE notes SET content = ?1 WHERE id = ?2",
                params![format!("![图片](./assets/{name})"), id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn latest(directory: &Path) -> PathBuf {
        directory.join("backups/NoteX-latest.zip")
    }

    #[test]
    fn compresses_all_categories_and_uncategorized_notes_with_shared_images()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        attach_image(&directory, "image.png")?;
        fs::write(directory.join("assets/image.png"), b"png")?;
        BackupService::new(&directory).create_latest(None)?;

        let mut archive = ZipArchive::new(File::open(latest(&directory))?)?;
        let names = archive
            .file_names()
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        assert_eq!(names.len(), 7);
        for path in [
            "工作/说明.md",
            "工作/项目/说明.md",
            "工作/项目/说明-2.md",
            "未分类/说明.md",
            "未分类-2/说明.md",
            "assets-2/说明.md",
            "assets/image.png",
        ] {
            assert!(names.contains(path), "missing {path}");
        }
        assert!(!names.iter().any(|name| name.contains("回收站")));
        let mut markdown = String::new();
        archive
            .by_name("工作/项目/说明.md")?
            .read_to_string(&mut markdown)?;
        // 同名笔记的顺序由快照排序决定，检查包含图片的那一篇。
        if !markdown.contains("![图片]") {
            markdown.clear();
            archive
                .by_name("工作/项目/说明-2.md")?
                .read_to_string(&mut markdown)?;
        }
        assert_eq!(markdown, "![图片](../../assets/image.png)");
        let note = archive.by_name("未分类/说明.md")?;
        assert_eq!(note.compression(), CompressionMethod::Deflated);
        assert!(note.compressed_size() < note.size());
        drop(note);
        let mut image = Vec::new();
        archive
            .by_name("assets/image.png")?
            .read_to_end(&mut image)?;
        assert_eq!(image, b"png");
        Ok(())
    }

    #[test]
    fn replaces_the_only_archive_and_supports_an_empty_workspace()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        let service = BackupService::new(&directory);
        service.create_latest(None)?;
        let mut connection = open_database(&directory.join("database/notex.db"))?;
        let transaction = connection.transaction()?;
        transaction.execute("UPDATE notes SET is_deleted = 1", [])?;
        transaction.commit()?;
        service.create_latest(None)?;

        let archive = ZipArchive::new(File::open(latest(&directory))?)?;
        assert!(archive.is_empty());
        assert_eq!(fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[test]
    fn keeps_the_previous_archive_and_cleans_partial_output_when_an_image_is_missing()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        let service = BackupService::new(&directory);
        service.create_latest(None)?;
        let previous = fs::read(latest(&directory))?;
        attach_image(&directory, "missing.png")?;

        assert!(service.create_latest(None).is_err());
        assert_eq!(fs::read(latest(&directory))?, previous);
        assert_eq!(fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn rejects_assets_and_backup_directories_outside_the_data_directory()
    -> Result<(), Box<dyn std::error::Error>> {
        use std::os::unix::fs::symlink;

        let directory = fixture()?;
        attach_image(&directory, "outside.png")?;
        let outside = std::env::temp_dir().join(format!("notex-outside-{}", Uuid::new_v4()));
        fs::write(&outside, b"private")?;
        symlink(&outside, directory.join("assets/outside.png"))?;
        assert!(BackupService::new(&directory).create_latest(None).is_err());
        assert!(!latest(&directory).exists());

        let another = fixture()?;
        symlink(directory.join("assets"), another.join("backups"))?;
        assert!(BackupService::new(&another).create_latest(None).is_err());
        assert!(!directory.join("assets/NoteX-latest.zip").exists());
        Ok(())
    }

    #[test]
    fn does_not_create_a_database_when_startup_has_not_completed()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!("notex-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory)?;
        assert!(BackupService::new(&directory).create_latest(None).is_err());
        assert!(!directory.join("database").exists());
        assert!(!directory.join("backups").exists());
        Ok(())
    }

    #[test]
    fn encrypts_every_note_and_image_with_the_same_password()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        attach_image(&directory, "image.png")?;
        fs::write(directory.join("assets/image.png"), b"png")?;
        let password = "  备份🔒123  ";
        BackupService::new(&directory).create_latest(Some(password))?;
        let mut archive = ZipArchive::new(File::open(latest(&directory))?)?;
        assert_eq!(archive.len(), 7);
        for index in 0..archive.len() {
            assert!(archive.by_index(index).is_err());
            assert!(
                archive
                    .by_index_decrypt(index, b"wrong-password")
                    .and_then(|mut entry| io::copy(&mut entry, &mut io::sink())
                        .map_err(zip::result::ZipError::Io))
                    .is_err()
            );
            let aes = archive
                .get_aes_verification_key_and_salt(index)?
                .ok_or("missing AES metadata")?;
            assert_eq!(aes.aes_mode, AesMode::Aes256);
            let mut entry = archive.by_index_decrypt(index, password.as_bytes())?;
            assert!(entry.encrypted());
            assert!(io::copy(&mut entry, &mut io::sink())? > 0);
        }
        let mut image = Vec::new();
        archive
            .by_name_decrypt("assets/image.png", password.as_bytes())?
            .read_to_end(&mut image)?;
        assert_eq!(image, b"png");
        assert_eq!(fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[test]
    fn reprotects_existing_backup_without_changing_its_contents()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        let service = BackupService::new(&directory);
        service.create_latest(None)?;
        // 密码变更只重写已有备份，不用当前数据库覆盖此前的备份内容。
        let mut database = open_database(&directory.join("database/notex.db"))?;
        let transaction = database.transaction()?;
        transaction.execute("UPDATE notes SET content = 'new content'", [])?;
        transaction.commit()?;
        let mut update = service
            .prepare_password_change(None, Some("1234"))?
            .ok_or("missing update")?;
        update.apply()?;
        update.finish()?;
        assert!(archive_matches_password(&latest(&directory), Some("1234"))?);
        let mut archive = ZipArchive::new(File::open(latest(&directory))?)?;
        let mut content = String::new();
        archive
            .by_name_decrypt("工作/说明.md", b"1234")?
            .read_to_string(&mut content)?;
        assert_eq!(content, "备份正文".repeat(1000));
        drop(archive);
        for (old, new) in [(Some("1234"), Some("5678")), (Some("5678"), None)] {
            let mut update = service
                .prepare_password_change(old, new)?
                .ok_or("missing update")?;
            update.apply()?;
            update.finish()?;
            assert!(archive_matches_password(&latest(&directory), new)?);
            if let Some(old) = old {
                assert!(!archive_matches_password(&latest(&directory), Some(old))?);
            }
        }
        assert_eq!(fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[test]
    fn rolls_back_an_uncommitted_backup_replacement() -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        let service = BackupService::new(&directory);
        service.create_latest(None)?;
        let previous = fs::read(latest(&directory))?;
        {
            let mut update = service
                .prepare_password_change(None, Some("1234"))?
                .ok_or("missing update")?;
            update.apply()?;
            assert!(archive_matches_password(&latest(&directory), Some("1234"))?);
        }
        assert_eq!(fs::read(latest(&directory))?, previous);
        assert_eq!(fs::read_dir(directory.join("backups"))?.count(), 1);
        Ok(())
    }

    #[test]
    fn recovers_interrupted_password_changes_using_the_committed_password()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        let service = BackupService::new(&directory);
        service.create_latest(None)?;
        let previous = fs::read(latest(&directory))?;
        for committed in [false, true] {
            let mut update = service
                .prepare_password_change(None, Some("1234"))?
                .ok_or("missing update")?;
            update.apply()?;
            // 模拟发布 ZIP 后进程中断，跳过析构回滚。
            std::mem::forget(update);
            let password = committed.then_some("1234");
            service.recover_pending_update(password)?;
            assert!(archive_matches_password(&latest(&directory), password)?);
            if !committed {
                assert_eq!(fs::read(latest(&directory))?, previous);
            }
            assert_eq!(fs::read_dir(directory.join("backups"))?.count(), 1);
        }
        Ok(())
    }

    #[test]
    fn encrypts_empty_workspaces_and_upgrades_legacy_unencrypted_backups()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = fixture()?;
        let mut database = open_database(&directory.join("database/notex.db"))?;
        let transaction = database.transaction()?;
        transaction.execute("UPDATE notes SET is_deleted = 1", [])?;
        transaction.commit()?;
        let service = BackupService::new(&directory);
        service.create_latest(None)?;
        assert!(ZipArchive::new(File::open(latest(&directory))?)?.is_empty());
        service.ensure_encrypted("1234")?;
        assert!(archive_matches_password(&latest(&directory), Some("1234"))?);
        assert!(!archive_matches_password(&latest(&directory), None)?);
        assert!(!archive_matches_password(
            &latest(&directory),
            Some("wrong")
        )?);
        service.create_latest(Some("5678"))?;
        assert!(archive_matches_password(&latest(&directory), Some("5678"))?);
        Ok(())
    }
}

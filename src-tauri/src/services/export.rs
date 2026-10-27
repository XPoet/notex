use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use time::OffsetDateTime;
use uuid::Uuid;

use crate::database::connection::open_database;
use crate::domain::export::{
    ExportError, ExportIssue, ExportProgress, ExportRequest, ExportResult, ExportScopeKind,
};
use crate::repositories::export::{ExportAsset, ExportCategory, ExportNote, ExportRepository};

#[derive(Clone, Default)]
pub struct ExportTaskRegistry {
    inner: Arc<Mutex<ExportTaskState>>,
}

#[derive(Default)]
struct ExportTaskState {
    active_job_ids: HashSet<String>,
    cancelled_job_ids: HashSet<String>,
    completed_directories: HashMap<String, PathBuf>,
}

impl ExportTaskRegistry {
    pub fn begin(&self, job_id: &str) -> Result<(), ExportError> {
        validate_job_id(job_id)?;
        let mut state = self.inner.lock().map_err(|_| ExportError::Write)?;
        if state.active_job_ids.contains(job_id) || state.completed_directories.contains_key(job_id)
        {
            return Err(ExportError::Validation);
        }
        state.cancelled_job_ids.remove(job_id);
        state.active_job_ids.insert(job_id.to_owned());
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), ExportError> {
        validate_job_id(job_id)?;
        let mut state = self.inner.lock().map_err(|_| ExportError::Write)?;
        if !state.active_job_ids.contains(job_id) {
            return Err(ExportError::TaskNotFound);
        }
        state.cancelled_job_ids.insert(job_id.to_owned());
        Ok(())
    }

    pub fn is_cancelled(&self, job_id: &str) -> Result<bool, ExportError> {
        let state = self.inner.lock().map_err(|_| ExportError::Write)?;
        Ok(state.cancelled_job_ids.contains(job_id))
    }

    pub fn complete(&self, job_id: &str, directory: PathBuf) -> Result<(), ExportError> {
        let mut state = self.inner.lock().map_err(|_| ExportError::Write)?;
        state.active_job_ids.remove(job_id);
        state.cancelled_job_ids.remove(job_id);
        state
            .completed_directories
            .insert(job_id.to_owned(), directory);
        Ok(())
    }

    pub fn fail(&self, job_id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.active_job_ids.remove(job_id);
            state.cancelled_job_ids.remove(job_id);
        }
    }

    pub fn completed_directory(&self, job_id: &str) -> Result<PathBuf, ExportError> {
        validate_job_id(job_id)?;
        let state = self.inner.lock().map_err(|_| ExportError::Open)?;
        state
            .completed_directories
            .get(job_id)
            .cloned()
            .filter(|directory| directory.is_dir())
            .ok_or(ExportError::TaskNotFound)
    }
}

pub struct ExportService {
    database_path: PathBuf,
    assets_directory: PathBuf,
}

impl ExportService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            database_path: data_directory.join("database").join("notex.db"),
            assets_directory: data_directory.join("assets"),
        }
    }

    pub fn export<F>(
        &self,
        request: &ExportRequest,
        registry: &ExportTaskRegistry,
        report_progress: F,
    ) -> Result<ExportResult, ExportError>
    where
        F: Fn(ExportProgress) -> Result<(), ExportError>,
    {
        validate_request(request)?;
        registry.begin(&request.job_id)?;
        let result = self.export_started(request, registry, report_progress);
        if result.is_err() {
            registry.fail(&request.job_id);
        }
        result
    }

    fn export_started<F>(
        &self,
        request: &ExportRequest,
        registry: &ExportTaskRegistry,
        report_progress: F,
    ) -> Result<ExportResult, ExportError>
    where
        F: Fn(ExportProgress) -> Result<(), ExportError>,
    {
        let target_directory = validate_target_directory(&request.target_directory)?;
        let mut connection =
            open_database(&self.database_path).map_err(|_| ExportError::Snapshot)?;
        let snapshot = ExportRepository::snapshot(&mut connection, &request.scope)?;
        let total = u32::try_from(snapshot.notes.len()).map_err(|_| ExportError::Validation)?;
        let (output_directory, directory_label) = create_output_directory(&target_directory)?;
        fs::create_dir(output_directory.join("assets")).map_err(|_| ExportError::Write)?;

        let mut layout = ExportLayout::new(output_directory.clone());
        let mut copied_asset_ids = HashSet::new();
        let mut copied_asset_names = HashSet::new();
        let mut issues = Vec::new();
        let mut exported_count = 0;
        let mut failed_count = 0;

        report_progress(ExportProgress {
            total,
            processed: 0,
            succeeded: exported_count,
            failed: failed_count,
            current_title: None,
        })?;

        for (index, note) in snapshot.notes.iter().enumerate() {
            if registry.is_cancelled(&request.job_id)? {
                break;
            }
            let title = display_title(&note.title, &note.id);
            match self.export_note(
                note,
                request.scope.kind,
                &request.scope.id,
                &snapshot.scope_label,
                &mut layout,
                &mut copied_asset_ids,
                &mut copied_asset_names,
                &mut issues,
            ) {
                Ok(()) => exported_count += 1,
                Err(_) => {
                    failed_count += 1;
                    issues.push(ExportIssue {
                        note_id: Some(note.id.clone()),
                        title: title.clone(),
                        code: "EXPORT_NOTE_WRITE_FAILED".to_owned(),
                        message: "该笔记导出失败，其他笔记已继续处理。".to_owned(),
                    });
                }
            }
            let processed = u32::try_from(index + 1).map_err(|_| ExportError::Validation)?;
            report_progress(ExportProgress {
                total,
                processed,
                succeeded: exported_count,
                failed: failed_count,
                current_title: Some(title),
            })?;
        }

        let cancelled = registry.is_cancelled(&request.job_id)?;
        registry.complete(&request.job_id, output_directory)?;
        Ok(ExportResult {
            job_id: request.job_id.clone(),
            directory_label,
            exported_count,
            failed_count,
            cancelled,
            issues,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn export_note(
        &self,
        note: &ExportNote,
        scope_kind: ExportScopeKind,
        scope_id: &str,
        scope_label: &str,
        layout: &mut ExportLayout,
        copied_asset_ids: &mut HashSet<String>,
        copied_asset_names: &mut HashSet<String>,
        issues: &mut Vec<ExportIssue>,
    ) -> Result<(), ExportError> {
        let markdown_directory =
            layout.markdown_directory(scope_kind, scope_id, scope_label, &note.category_path)?;
        fs::create_dir_all(&markdown_directory).map_err(|_| ExportError::Write)?;
        let markdown_path = layout.markdown_path(&markdown_directory, &note.title, &note.id)?;
        let mut content = note.content.clone();
        for asset in &note.assets {
            let target_file_name = controlled_asset_file_name(asset)?;
            let relative_path =
                asset_reference(&markdown_path, &layout.output_directory, target_file_name)?;
            content = replace_asset_reference(&content, &asset.relative_path, &relative_path);
            if !copied_asset_ids.contains(&asset.id) {
                let source_path = self.assets_directory.join(target_file_name);
                let target_path = layout
                    .output_directory
                    .join("assets")
                    .join(target_file_name);
                if !source_path.is_file() {
                    copied_asset_ids.insert(asset.id.clone());
                    issues.push(ExportIssue {
                        note_id: Some(note.id.clone()),
                        title: display_title(&note.title, &note.id),
                        code: "EXPORT_ASSET_MISSING".to_owned(),
                        message: "关联图片资源缺失，已导出 Markdown 引用。".to_owned(),
                    });
                    continue;
                }
                let canonical_assets_directory = self
                    .assets_directory
                    .canonicalize()
                    .map_err(|_| ExportError::Write)?;
                let canonical_source_path =
                    source_path.canonicalize().map_err(|_| ExportError::Write)?;
                if !canonical_source_path.starts_with(&canonical_assets_directory) {
                    return Err(ExportError::Write);
                }
                if !copied_asset_names.insert(target_file_name.to_owned()) {
                    return Err(ExportError::Write);
                }
                copy_new_file_atomically(&canonical_source_path, &target_path)?;
                copied_asset_ids.insert(asset.id.clone());
            }
        }
        write_new_file_atomically(&markdown_path, content.as_bytes())
    }
}

pub(super) struct ExportLayout {
    output_directory: PathBuf,
    category_directories: HashMap<String, PathBuf>,
    directory_names: HashMap<PathBuf, HashSet<String>>,
    file_names: HashMap<PathBuf, HashSet<String>>,
}

impl ExportLayout {
    pub(super) fn new(output_directory: PathBuf) -> Self {
        let directory_names = HashMap::from([(
            output_directory.clone(),
            HashSet::from(["assets".to_owned()]),
        )]);
        Self {
            output_directory,
            category_directories: HashMap::new(),
            directory_names,
            file_names: HashMap::new(),
        }
    }

    pub(super) fn markdown_directory(
        &mut self,
        scope_kind: ExportScopeKind,
        scope_id: &str,
        scope_label: &str,
        category_path: &[ExportCategory],
    ) -> Result<PathBuf, ExportError> {
        match scope_kind {
            ExportScopeKind::Note => Ok(self.output_directory.clone()),
            ExportScopeKind::Tag => self.named_directory(
                &self.output_directory.clone(),
                &format!("tag-{scope_id}"),
                scope_label,
            ),
            ExportScopeKind::Category | ExportScopeKind::CategoryWithDescendants => {
                let mut current = self.output_directory.clone();
                for category in category_path {
                    current = self.category_directory(&current, category)?;
                }
                Ok(current)
            }
        }
    }

    fn category_directory(
        &mut self,
        parent: &Path,
        category: &ExportCategory,
    ) -> Result<PathBuf, ExportError> {
        if let Some(directory) = self.category_directories.get(&category.id) {
            return Ok(directory.clone());
        }
        let directory = self.named_directory(parent, &category.id, &category.name)?;
        self.category_directories
            .insert(category.id.clone(), directory.clone());
        Ok(directory)
    }

    fn named_directory(
        &mut self,
        parent: &Path,
        identifier: &str,
        preferred_name: &str,
    ) -> Result<PathBuf, ExportError> {
        let names = self
            .directory_names
            .entry(parent.to_path_buf())
            .or_default();
        let base = sanitize_file_name(preferred_name, identifier);
        let name = unique_name(names, &base, identifier, "");
        let directory = parent.join(name);
        Ok(directory)
    }

    pub(super) fn markdown_path(
        &mut self,
        directory: &Path,
        title: &str,
        note_id: &str,
    ) -> Result<PathBuf, ExportError> {
        let names = self.file_names.entry(directory.to_path_buf()).or_default();
        let base = sanitize_file_name(title, note_id);
        let file_name = unique_name(names, &base, note_id, ".md");
        Ok(directory.join(file_name))
    }
}

fn validate_request(request: &ExportRequest) -> Result<(), ExportError> {
    validate_job_id(&request.job_id)?;
    if request.scope.id.trim().is_empty() || request.scope.id.chars().count() > 128 {
        return Err(ExportError::Validation);
    }
    if request.target_directory.trim().is_empty() {
        return Err(ExportError::Validation);
    }
    Ok(())
}

fn validate_job_id(job_id: &str) -> Result<(), ExportError> {
    Uuid::parse_str(job_id)
        .map(|_| ())
        .map_err(|_| ExportError::Validation)
}

fn validate_target_directory(target_directory: &str) -> Result<PathBuf, ExportError> {
    let path = Path::new(target_directory);
    if !path.is_absolute() {
        return Err(ExportError::TargetUnavailable);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| ExportError::TargetUnavailable)?;
    canonical
        .is_dir()
        .then_some(canonical)
        .ok_or(ExportError::TargetUnavailable)
}

fn create_output_directory(target_directory: &Path) -> Result<(PathBuf, String), ExportError> {
    let now = OffsetDateTime::now_utc();
    let base = format!(
        "NoteX 导出-{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
    );
    for index in 1..=1_000 {
        let label = if index == 1 {
            base.clone()
        } else {
            format!("{base}-{index}")
        };
        let directory = target_directory.join(&label);
        match fs::create_dir(&directory) {
            Ok(()) => return Ok((directory, label)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(ExportError::TargetUnavailable),
        }
    }
    Err(ExportError::TargetUnavailable)
}

pub(super) fn controlled_asset_file_name(asset: &ExportAsset) -> Result<&str, ExportError> {
    let expected_relative_path = format!("assets/{}", asset.file_name);
    let file_name = Path::new(&asset.file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == asset.file_name)
        .filter(|value| !value.is_empty())
        .ok_or(ExportError::Write)?;
    if asset.relative_path != expected_relative_path {
        return Err(ExportError::Write);
    }
    Ok(file_name)
}

pub(super) fn asset_reference(
    markdown_path: &Path,
    output_directory: &Path,
    file_name: &str,
) -> Result<String, ExportError> {
    let markdown_directory = markdown_path.parent().ok_or(ExportError::Write)?;
    let relative_directory = markdown_directory
        .strip_prefix(output_directory)
        .map_err(|_| ExportError::Write)?;
    let depth = relative_directory.components().count();
    if depth == 0 {
        return Ok(format!("./assets/{file_name}"));
    }
    Ok(format!("{}assets/{file_name}", "../".repeat(depth)))
}

pub(super) fn replace_asset_reference(
    content: &str,
    source_relative_path: &str,
    target_relative_path: &str,
) -> String {
    let source_with_dot = format!("](./{source_relative_path})");
    let source_without_dot = format!("]({source_relative_path})");
    let target = format!("]({target_relative_path})");
    content
        .replace(&source_with_dot, &target)
        .replace(&source_without_dot, &target)
}

fn write_new_file_atomically(path: &Path, bytes: &[u8]) -> Result<(), ExportError> {
    let temporary_path = temporary_path(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|_| ExportError::Write)?;
    file.write_all(bytes).map_err(|_| ExportError::Write)?;
    file.sync_all().map_err(|_| ExportError::Write)?;
    drop(file);
    fs::rename(temporary_path, path).map_err(|_| ExportError::Write)
}

fn copy_new_file_atomically(source_path: &Path, target_path: &Path) -> Result<(), ExportError> {
    let temporary_path = temporary_path(target_path)?;
    let mut source = File::open(source_path).map_err(|_| ExportError::Write)?;
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|_| ExportError::Write)?;
    io::copy(&mut source, &mut target).map_err(|_| ExportError::Write)?;
    target.sync_all().map_err(|_| ExportError::Write)?;
    drop(target);
    fs::rename(temporary_path, target_path).map_err(|_| ExportError::Write)
}

fn temporary_path(path: &Path) -> Result<PathBuf, ExportError> {
    let parent = path.parent().ok_or(ExportError::Write)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(ExportError::Write)?;
    Ok(parent.join(format!(".{name}.{}.tmp", Uuid::new_v4())))
}

fn sanitize_file_name(value: &str, identifier: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .filter_map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => Some(' '),
            character if character.is_control() => None,
            character => Some(character),
        })
        .collect::<String>();
    let collapsed = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = collapsed
        .trim_end_matches(['.', ' '])
        .chars()
        .take(96)
        .collect::<String>();
    let base = if truncated.is_empty() || truncated == "." || truncated == ".." {
        format!("无标题笔记-{}", short_identifier(identifier))
    } else {
        truncated
    };
    if is_windows_reserved_name(&base) {
        format!("{base}-{}", short_identifier(identifier))
    } else {
        base
    }
}

fn unique_name(
    names: &mut HashSet<String>,
    base: &str,
    identifier: &str,
    extension: &str,
) -> String {
    let initial = format!("{base}{extension}");
    if names.insert(initial.clone()) {
        return initial;
    }
    for suffix in 2..=10_000 {
        let candidate = format!("{base}-{suffix}{extension}");
        if names.insert(candidate.clone()) {
            return candidate;
        }
    }
    format!("{base}-{}{extension}", short_identifier(identifier))
}

fn is_windows_reserved_name(value: &str) -> bool {
    let normalized = value
        .trim_end_matches(['.', ' '])
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        normalized.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn short_identifier(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect()
}

fn display_title(title: &str, note_id: &str) -> String {
    let value = title.trim();
    if value.is_empty() {
        return format!("无标题笔记-{}", short_identifier(note_id));
    }
    value.chars().take(120).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::database::connection::open_database;
    use crate::domain::export::{ExportRequest, ExportScope, ExportScopeKind};
    use crate::repositories::bootstrap::BootstrapRepository;

    use super::{ExportService, ExportTaskRegistry, replace_asset_reference, sanitize_file_name};

    fn data_directory() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos());
        let directory = std::env::temp_dir().join(format!("notex-export-{timestamp}"));
        let _ = fs::create_dir_all(directory.join("database"));
        let _ = fs::create_dir_all(directory.join("assets"));
        directory
    }

    fn request(
        scope: ExportScopeKind,
        id: &str,
        target_directory: &std::path::Path,
    ) -> ExportRequest {
        ExportRequest {
            job_id: uuid::Uuid::new_v4().to_string(),
            scope: ExportScope {
                kind: scope,
                id: id.to_owned(),
            },
            target_directory: target_directory.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn export_paths_rewrite_assets_at_category_depth() -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        let database_path = directory.join("database").join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let connection = open_database(&database_path)?;
        connection.execute("INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at) VALUES ('root', '工作', NULL, 1, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at) VALUES ('child', '项目 A', 'root', 2, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO notes (id, title, content, category_id, created_at, updated_at) VALUES ('note', '接口说明', '![图片](./assets/image.png)', 'child', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO assets (id, file_name, extension, relative_path, mime_type, size, width, height, hash, created_at) VALUES ('asset', 'image.png', 'png', 'assets/image.png', 'image/png', 3, 1, 1, 'export-path-hash', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO note_assets (note_id, asset_id, created_at) VALUES ('note', 'asset', '2026-07-24T00:00:00Z')", [])?;
        fs::write(directory.join("assets").join("image.png"), b"png")?;
        let target_directory = directory.join("target");
        fs::create_dir(&target_directory)?;

        let result = ExportService::new(&directory).export(
            &request(
                ExportScopeKind::CategoryWithDescendants,
                "root",
                &target_directory,
            ),
            &ExportTaskRegistry::default(),
            |_| Ok(()),
        )?;
        let markdown = fs::read_to_string(
            target_directory
                .join(&result.directory_label)
                .join("工作")
                .join("项目 A")
                .join("接口说明.md"),
        )?;
        assert!(markdown.contains("../../assets/image.png"));
        assert_eq!(
            fs::read(
                target_directory
                    .join(&result.directory_label)
                    .join("assets")
                    .join("image.png"),
            )?,
            b"png"
        );
        Ok(())
    }

    #[test]
    fn exports_all_direct_category_notes_including_uncategorized()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        let database_path = directory.join("database").join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let mut connection = open_database(&database_path)?;
        let transaction = connection.transaction()?;
        transaction.execute("INSERT INTO categories (id, name, parent_id, level, sort_order, created_at, updated_at) VALUES ('root', '工作', NULL, 1, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z'), ('child', '项目', 'root', 2, 0, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z'), ('other', '其他', NULL, 1, 1, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        for (id, title, category_id, is_deleted) in [
            ("first", "笔记一", Some("root"), false),
            ("second", "笔记二", Some("root"), false),
            ("child-note", "子分类笔记", Some("child"), false),
            ("other-note", "其他分类笔记", Some("other"), false),
            ("deleted", "回收站笔记", Some("root"), true),
            ("uncategorized-first", "未分类一", None, false),
            ("uncategorized-second", "未分类二", None, false),
            ("uncategorized-deleted", "未分类回收站笔记", None, true),
        ] {
            transaction.execute(
                "INSERT INTO notes (id, title, content, category_id, is_deleted, created_at, updated_at)
                 VALUES (?1, ?2, '导出正文', ?3, ?4, '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')",
                rusqlite::params![id, title, category_id, is_deleted],
            )?;
        }
        transaction.commit()?;
        let target_directory = directory.join("target");
        fs::create_dir(&target_directory)?;

        for (scope_id, category_directory, expected_names) in [
            ("root", "工作", ["笔记一.md", "笔记二.md"]),
            ("uncategorized", "", ["未分类一.md", "未分类二.md"]),
        ] {
            let result = ExportService::new(&directory).export(
                &request(ExportScopeKind::Category, scope_id, &target_directory),
                &ExportTaskRegistry::default(),
                |_| Ok(()),
            )?;
            assert_eq!(result.exported_count, 2);
            assert_eq!(result.failed_count, 0);
            let output = target_directory.join(&result.directory_label);
            let markdown_directory = output.join(category_directory);
            let mut names = Vec::new();
            for entry in fs::read_dir(markdown_directory)? {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    assert!(fs::read_to_string(entry.path())?.contains("导出正文"));
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            names.sort();
            assert_eq!(names, expected_names);
            assert!(!output.join("其他").exists());
            assert!(!output.join("工作").join("项目").exists());
        }
        Ok(())
    }

    #[test]
    fn export_partial_failure_keeps_successful_notes() -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        let database_path = directory.join("database").join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let connection = open_database(&database_path)?;
        connection.execute("INSERT INTO tags (id, name, created_at, updated_at) VALUES ('tag', '资料', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO notes (id, title, content, created_at, updated_at) VALUES ('bad', '失败项', '', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO notes (id, title, content, created_at, updated_at) VALUES ('good', '成功项', '正文', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO note_tags (note_id, tag_id, created_at) VALUES ('bad', 'tag', '2026-07-24T00:00:00Z'), ('good', 'tag', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO assets (id, file_name, extension, relative_path, mime_type, size, width, height, hash, created_at) VALUES ('bad-asset', 'bad.png', 'png', 'unexpected/bad.png', 'image/png', 1, 1, 1, 'partial-hash', '2026-07-24T00:00:00Z')", [])?;
        connection.execute("INSERT INTO note_assets (note_id, asset_id, created_at) VALUES ('bad', 'bad-asset', '2026-07-24T00:00:00Z')", [])?;
        let target_directory = directory.join("target");
        fs::create_dir(&target_directory)?;

        let result = ExportService::new(&directory).export(
            &request(ExportScopeKind::Tag, "tag", &target_directory),
            &ExportTaskRegistry::default(),
            |_| Ok(()),
        )?;
        assert_eq!(result.exported_count, 1);
        assert_eq!(result.failed_count, 1);
        assert!(
            target_directory
                .join(result.directory_label)
                .join("资料")
                .join("成功项.md")
                .is_file()
        );
        Ok(())
    }

    #[test]
    fn export_cancellation_stops_future_writes() -> Result<(), Box<dyn std::error::Error>> {
        let directory = data_directory();
        let database_path = directory.join("database").join("notex.db");
        BootstrapRepository::initialize(&database_path)?;
        let connection = open_database(&database_path)?;
        connection.execute("INSERT INTO notes (id, title, content, created_at, updated_at) VALUES ('note', '待取消笔记', '正文', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z')", [])?;
        let target_directory = directory.join("target");
        fs::create_dir(&target_directory)?;
        let request = request(ExportScopeKind::Note, "note", &target_directory);
        let job_id = request.job_id.clone();
        let registry = ExportTaskRegistry::default();
        let cancellation_registry = registry.clone();

        let result = ExportService::new(&directory).export(&request, &registry, move |_| {
            cancellation_registry.cancel(&job_id)
        })?;

        assert!(result.cancelled);
        assert_eq!(result.exported_count, 0);
        assert!(
            !target_directory
                .join(result.directory_label)
                .join("待取消笔记.md")
                .exists()
        );
        Ok(())
    }

    #[test]
    fn sanitizes_invalid_names_and_only_rewrites_markdown_targets() {
        assert_eq!(sanitize_file_name("  CON  ", "abcd1234"), "CON-abcd1234");
        assert_eq!(
            replace_asset_reference(
                "x assets/a.png ![x](./assets/a.png)",
                "assets/a.png",
                "./assets/b.png"
            ),
            "x assets/a.png ![x](./assets/b.png)",
        );
    }
}

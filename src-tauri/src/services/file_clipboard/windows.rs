use std::ffi::{OsString, c_void};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr;
use std::thread;
use std::time::Duration;

use super::MAX_CLIPBOARD_FILES;
use crate::domain::assets::AssetError;

type Handle = *mut c_void;
const CF_HDROP: u32 = 15;
const GMEM_MOVEABLE: u32 = 0x0002;

#[link(name = "user32")]
unsafe extern "system" {
    fn OpenClipboard(owner: Handle) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn GetClipboardData(format: u32) -> Handle;
    fn IsClipboardFormatAvailable(format: u32) -> i32;
    fn SetClipboardData(format: u32, memory: Handle) -> Handle;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
    fn GlobalLock(memory: Handle) -> *mut c_void;
    fn GlobalUnlock(memory: Handle) -> i32;
    fn GlobalFree(memory: Handle) -> Handle;
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn DragQueryFileW(drop: Handle, index: u32, name: *mut u16, capacity: u32) -> u32;
}

struct Clipboard;

impl Clipboard {
    fn open(owner: Handle) -> Option<Self> {
        // Clipboard managers may hold the clipboard briefly while handling an update.
        for _ in 0..5 {
            // SAFETY: owner is null for reading, or a live application window for writing.
            if unsafe { OpenClipboard(owner) } != 0 {
                return Some(Self);
            }
            thread::sleep(Duration::from_millis(5));
        }
        None
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        // SAFETY: this guard is created only after opening on the current thread.
        unsafe { CloseClipboard() };
    }
}

#[repr(C)]
struct DropFiles {
    path_offset: u32,
    point: [i32; 2],
    non_client: i32,
    wide: i32,
}

struct ClipboardMemory(Handle);

impl ClipboardMemory {
    fn for_file(path: &Path) -> Result<Self, AssetError> {
        let mut path = shell_path(path);
        path.extend([0, 0]);
        let path_offset = size_of::<DropFiles>();
        // SAFETY: movable global storage can be transferred to the clipboard. The guard
        // owns it until that transfer succeeds and frees it if preparation fails.
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, path_offset + size_of_val(path.as_slice()));
            if handle.is_null() {
                return Err(AssetError::ClipboardWriteFailed);
            }
            let memory = Self(handle);
            let buffer = GlobalLock(handle).cast::<u8>();
            if buffer.is_null() {
                return Err(AssetError::ClipboardWriteFailed);
            }
            buffer.cast::<DropFiles>().write(DropFiles {
                path_offset: path_offset as u32,
                point: [0, 0],
                non_client: 0,
                wide: 1,
            });
            ptr::copy_nonoverlapping(
                path.as_ptr(),
                buffer.add(path_offset).cast::<u16>(),
                path.len(),
            );
            GlobalUnlock(handle);
            Ok(memory)
        }
    }
}

impl Drop for ClipboardMemory {
    fn drop(&mut self) {
        // SAFETY: this guard owns an unlocked allocation that has not been transferred.
        unsafe { GlobalFree(self.0) };
    }
}

fn shell_path(path: &Path) -> Vec<u16> {
    let mut wide: Vec<_> = path.as_os_str().encode_wide().collect();
    let verbatim_prefix: Vec<_> = r"\\?\".encode_utf16().collect();
    let unc_prefix: Vec<_> = r"UNC\".encode_utf16().collect();
    // Canonical Windows paths use verbatim prefixes. Use the equivalent ordinary
    // paths for the Shell, while retaining extended paths that require the prefix.
    if let Some(rest) = wide.strip_prefix(verbatim_prefix.as_slice()) {
        if rest.len() < 260 && rest.get(1) == Some(&u16::from(b':')) {
            wide.drain(..verbatim_prefix.len());
        } else if rest.len() < 261 && rest.starts_with(&unc_prefix) {
            wide.drain(2..verbatim_prefix.len() + unc_prefix.len());
        }
    }
    wide
}

pub(super) fn write_file(window: &tauri::WebviewWindow, path: &Path) -> Result<(), AssetError> {
    let owner = window
        .hwnd()
        .map_err(|_| AssetError::ClipboardWriteFailed)?;
    let memory = ClipboardMemory::for_file(path)?;
    let _clipboard = Clipboard::open(owner.0).ok_or(AssetError::ClipboardWriteFailed)?;
    // SAFETY: the clipboard is open with a window owner, and memory contains unlocked CF_HDROP data.
    if unsafe { EmptyClipboard() == 0 || SetClipboardData(CF_HDROP, memory.0).is_null() } {
        return Err(AssetError::ClipboardWriteFailed);
    }
    std::mem::forget(memory); // Windows now owns the allocation.
    Ok(())
}

pub(super) fn files() -> Result<Vec<PathBuf>, AssetError> {
    // SAFETY: format availability can be queried without opening the clipboard.
    if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
        return Ok(Vec::new());
    }
    let _clipboard = Clipboard::open(ptr::null_mut()).ok_or(AssetError::ClipboardFailed)?;
    // SAFETY: the opened clipboard keeps its handle valid while reading the file list.
    unsafe {
        let drop = GetClipboardData(CF_HDROP);
        if drop.is_null() {
            return Ok(Vec::new());
        }
        read_file_list(drop)
    }
}

unsafe fn read_file_list(drop: Handle) -> Result<Vec<PathBuf>, AssetError> {
    // SAFETY: the caller holds the clipboard or owns this CF_HDROP allocation. Each
    // buffer passed to DragQueryFileW has room for the reported UTF-16 name and NUL.
    unsafe {
        let count = DragQueryFileW(drop, u32::MAX, ptr::null_mut(), 0);
        if count as usize > MAX_CLIPBOARD_FILES {
            return Err(AssetError::ClipboardFailed);
        }
        (0..count)
            .map(|index| {
                let len = DragQueryFileW(drop, index, ptr::null_mut(), 0);
                if len == 0 || len >= 32_767 {
                    return Err(AssetError::ClipboardFailed);
                }
                let mut name = vec![0; (len + 1) as usize];
                if DragQueryFileW(drop, index, name.as_mut_ptr(), len + 1) != len {
                    return Err(AssetError::ClipboardFailed);
                }
                name.truncate(len as usize);
                Ok(PathBuf::from(OsString::from_wide(&name)))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_drop_preserves_unicode_and_uses_shell_paths() -> Result<(), AssetError> {
        for (source, expected) in [
            (r"\\?\C:\NoteX 附件\[验收].pdf", r"C:\NoteX 附件\[验收].pdf"),
            (r"\\?\UNC\server\share\图片.png", r"\\server\share\图片.png"),
        ] {
            let memory = ClipboardMemory::for_file(Path::new(source))?;
            // SAFETY: memory owns a live, unlocked CF_HDROP allocation.
            assert_eq!(
                unsafe { read_file_list(memory.0)? },
                [PathBuf::from(expected)]
            );
        }
        Ok(())
    }
}

use std::path::{Path, PathBuf};

use crate::domain::assets::AssetError;

#[cfg(any(target_os = "macos", target_os = "windows"))]
const MAX_CLIPBOARD_FILES: usize = 100;

pub(crate) fn files() -> Result<Vec<PathBuf>, AssetError> {
    platform::files()
}

pub(crate) fn write_file(window: &tauri::WebviewWindow, path: &Path) -> Result<(), AssetError> {
    platform::write_file(window, path)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CStr, CString, c_char, c_void};
    use std::path::{Path, PathBuf};

    use super::MAX_CLIPBOARD_FILES;
    use crate::domain::assets::AssetError;

    type Object = *mut c_void;

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Object;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> Object;
        fn objc_autoreleasePoolPop(pool: Object);
    }

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        static NSPasteboardURLReadingFileURLsOnlyKey: Object;
    }

    struct Pool(Object);

    impl Drop for Pool {
        fn drop(&mut self) {
            // SAFETY: the pool token was created on this same blocking thread.
            unsafe {
                objc_autoreleasePoolPop(self.0);
            }
        }
    }

    pub(super) fn files() -> Result<Vec<PathBuf>, AssetError> {
        // SAFETY: all Objective-C objects stay in this pool and on this thread;
        // selectors use the documented AppKit/Foundation method signatures.
        unsafe {
            let _pool = Pool(objc_autoreleasePoolPush());
            let board = send(
                objc_getClass(c"NSPasteboard".as_ptr()),
                c"generalPasteboard",
            );
            read_files(board)
        }
    }

    pub(super) fn write_file(
        _window: &tauri::WebviewWindow,
        path: &Path,
    ) -> Result<(), AssetError> {
        // SAFETY: all Objective-C objects remain within this thread's pool.
        unsafe {
            let _pool = Pool(objc_autoreleasePoolPush());
            let board = send(
                objc_getClass(c"NSPasteboard".as_ptr()),
                c"generalPasteboard",
            );
            write_file_to(board, path)
        }
    }

    unsafe fn write_file_to(board: Object, path: &Path) -> Result<(), AssetError> {
        if board.is_null() {
            return Err(AssetError::ClipboardWriteFailed);
        }
        let path = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| AssetError::ClipboardWriteFailed)?;
        // SAFETY: board is a live NSPasteboard, path is a NUL-terminated file-system path,
        // and each message sender matches the selected AppKit/Foundation method's ABI.
        unsafe {
            let file_url: unsafe extern "C" fn(
                Object,
                Object,
                *const c_char,
                i8,
                Object,
            ) -> Object = std::mem::transmute(objc_msgSend as *const ());
            let url = file_url(
                objc_getClass(c"NSURL".as_ptr()),
                sel_registerName(
                    c"fileURLWithFileSystemRepresentation:isDirectory:relativeToURL:".as_ptr(),
                ),
                path.as_ptr(),
                0,
                std::ptr::null_mut(),
            );
            if url.is_null() {
                return Err(AssetError::ClipboardWriteFailed);
            }
            let list = send_arg(objc_getClass(c"NSArray".as_ptr()), c"arrayWithObject:", url);
            let clear: unsafe extern "C" fn(Object, Object) -> isize =
                std::mem::transmute(objc_msgSend as *const ());
            let write: unsafe extern "C" fn(Object, Object, Object) -> i8 =
                std::mem::transmute(objc_msgSend as *const ());
            clear(board, sel_registerName(c"clearContents".as_ptr()));
            if write(board, sel_registerName(c"writeObjects:".as_ptr()), list) == 0 {
                return Err(AssetError::ClipboardWriteFailed);
            }
        }
        Ok(())
    }

    unsafe fn read_files(board: Object) -> Result<Vec<PathBuf>, AssetError> {
        // SAFETY: board is a live NSPasteboard. NSURL restricts reading to URLs,
        // and the reading option excludes non-file URLs and plain text paths.
        unsafe {
            if board.is_null() {
                return Err(AssetError::ClipboardFailed);
            }
            let classes = send_arg(
                objc_getClass(c"NSArray".as_ptr()),
                c"arrayWithObject:",
                objc_getClass(c"NSURL".as_ptr()),
            );
            let bool_send: unsafe extern "C" fn(Object, Object, i8) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            let yes = bool_send(
                objc_getClass(c"NSNumber".as_ptr()),
                sel_registerName(c"numberWithBool:".as_ptr()),
                1,
            );
            let options = send_two(
                objc_getClass(c"NSDictionary".as_ptr()),
                c"dictionaryWithObject:forKey:",
                yes,
                NSPasteboardURLReadingFileURLsOnlyKey,
            );
            let urls = send_two(board, c"readObjectsForClasses:options:", classes, options);
            if urls.is_null() {
                return Ok(Vec::new());
            }
            let count_send: unsafe extern "C" fn(Object, Object) -> usize =
                std::mem::transmute(objc_msgSend as *const ());
            let count = count_send(urls, sel_registerName(c"count".as_ptr()));
            if count > MAX_CLIPBOARD_FILES {
                return Err(AssetError::ClipboardFailed);
            }
            let indexed: unsafe extern "C" fn(Object, Object, usize) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            let mut paths = Vec::new();
            for index in 0..count {
                let url = indexed(urls, sel_registerName(c"objectAtIndex:".as_ptr()), index);
                let path = send(url, c"path");
                let text = send(path, c"UTF8String").cast::<c_char>();
                if text.is_null() {
                    return Err(AssetError::ClipboardFailed);
                }
                paths.push(PathBuf::from(
                    CStr::from_ptr(text)
                        .to_str()
                        .map_err(|_| AssetError::ClipboardFailed)?,
                ));
            }
            Ok(paths)
        }
    }

    unsafe fn send(receiver: Object, selector: &CStr) -> Object {
        // SAFETY: callers select only documented methods returning object pointers.
        unsafe {
            let method: unsafe extern "C" fn(Object, Object) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            method(receiver, sel_registerName(selector.as_ptr()))
        }
    }

    unsafe fn send_arg(receiver: Object, selector: &CStr, value: Object) -> Object {
        // SAFETY: callers provide the one object argument required by the selector.
        unsafe {
            let method: unsafe extern "C" fn(Object, Object, Object) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            method(receiver, sel_registerName(selector.as_ptr()), value)
        }
    }

    unsafe fn send_two(receiver: Object, selector: &CStr, first: Object, second: Object) -> Object {
        // SAFETY: callers provide the two object arguments required by the selector.
        unsafe {
            let method: unsafe extern "C" fn(Object, Object, Object, Object) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            method(receiver, sel_registerName(selector.as_ptr()), first, second)
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn copies_file_urls_via_an_isolated_pasteboard_without_touching_the_users_clipboard()
        -> Result<(), Box<dyn std::error::Error>> {
            // SAFETY: test objects live until the local pool drops, and each typed
            // function pointer matches the invoked Foundation/AppKit selector.
            unsafe {
                let _pool = Pool(objc_autoreleasePoolPush());
                let board = send(
                    objc_getClass(c"NSPasteboard".as_ptr()),
                    c"pasteboardWithUniqueName",
                );
                assert!(!board.is_null(), "macOS 未返回隔离剪贴板");
                let path = std::env::temp_dir().join("NoteX 附件 # [验收].pdf");
                write_file_to(board, &path)?;
                assert_eq!(read_files(board)?, [path]);
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use crate::domain::assets::AssetError;
    use std::path::{Path, PathBuf};

    pub(super) fn files() -> Result<Vec<PathBuf>, AssetError> {
        Ok(Vec::new())
    }

    pub(super) fn write_file(
        _window: &tauri::WebviewWindow,
        _path: &Path,
    ) -> Result<(), AssetError> {
        Err(AssetError::ClipboardWriteFailed)
    }
}

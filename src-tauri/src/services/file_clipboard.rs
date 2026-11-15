use std::path::PathBuf;

use crate::domain::assets::AssetError;

pub(crate) fn files() -> Result<Vec<PathBuf>, AssetError> {
    platform::files()
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CStr, c_char, c_void};
    use std::path::PathBuf;

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
            if count > 100 {
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
        fn reads_file_urls_from_an_isolated_pasteboard_without_touching_the_users_clipboard()
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
                let clear: unsafe extern "C" fn(Object, Object) -> isize =
                    std::mem::transmute(objc_msgSend as *const ());
                clear(board, sel_registerName(c"clearContents".as_ptr()));
                let path = std::env::temp_dir().join("NoteX 附件 [验收].pdf");
                let encoded = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
                let name = send_arg(
                    objc_getClass(c"NSString".as_ptr()),
                    c"stringWithUTF8String:",
                    encoded.as_ptr().cast_mut().cast(),
                );
                let url = send_arg(objc_getClass(c"NSURL".as_ptr()), c"fileURLWithPath:", name);
                let list = send_arg(objc_getClass(c"NSArray".as_ptr()), c"arrayWithObject:", url);
                let write: unsafe extern "C" fn(Object, Object, Object) -> i8 =
                    std::mem::transmute(objc_msgSend as *const ());
                assert_ne!(
                    write(board, sel_registerName(c"writeObjects:".as_ptr()), list),
                    0
                );
                assert_eq!(read_files(board)?, [path]);
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use crate::domain::assets::AssetError;
    use std::path::PathBuf;

    pub(super) fn files() -> Result<Vec<PathBuf>, AssetError> {
        Ok(Vec::new())
    }
}

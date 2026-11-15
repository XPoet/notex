use std::ops::Range;

pub struct AssetReference<'a> {
    pub path: &'a str,
    pub target: Range<usize>,
}

/// Find application-managed inline link targets, excluding fenced/inline code.
pub fn references(content: &str) -> Vec<AssetReference<'_>> {
    let bytes = content.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    let mut fence = None;
    let mut inline_ticks = 0;
    let mut brackets = Vec::new();
    while index < bytes.len() {
        if index == 0 || bytes[index - 1] == b'\n' {
            let start = index;
            while bytes.get(index) == Some(&b' ') && index - start < 3 {
                index += 1;
            }
            if index == bytes.len() {
                break;
            }
            let marker = bytes.get(index).copied().unwrap_or_default();
            let run = bytes[index..]
                .iter()
                .take_while(|value| **value == marker)
                .count();
            if matches!(marker, b'`' | b'~') && run >= 3 {
                match fence {
                    None => fence = Some((marker, run)),
                    Some((kind, length)) if kind == marker && run >= length => fence = None,
                    _ => {}
                }
                index = bytes[index..]
                    .iter()
                    .position(|value| *value == b'\n')
                    .map_or(bytes.len(), |offset| index + offset + 1);
                inline_ticks = 0;
                brackets.clear();
                continue;
            }
        }
        if fence.is_some() {
            index += 1;
            continue;
        }
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == b'`' {
            let run = bytes[index..]
                .iter()
                .take_while(|value| **value == b'`')
                .count();
            if inline_ticks == 0 {
                inline_ticks = run;
            } else if inline_ticks == run {
                inline_ticks = 0;
            }
            index += run;
            continue;
        }
        if inline_ticks == 0 && bytes[index] == b'[' {
            brackets.push(index);
        }
        if bytes[index] == b'\n' {
            brackets.clear();
        }
        let closes_label = inline_ticks == 0 && bytes[index] == b']' && brackets.pop().is_some();
        if closes_label && bytes.get(index + 1) == Some(&b'(') {
            let start = index + 2;
            if let Some(end) = bytes[start..]
                .iter()
                .position(|value| *value == b')')
                .map(|offset| start + offset)
            {
                if let Some(target) = content.get(start..end) {
                    let path = target.strip_prefix("./").unwrap_or(target);
                    if is_managed_path(path) {
                        result.push(AssetReference {
                            path,
                            target: start..end,
                        });
                        index = end + 1;
                        continue;
                    }
                }
            }
        }
        index += 1;
    }
    result
}

pub fn is_managed_path(path: &str) -> bool {
    let Some(relative) = path.strip_prefix("assets/") else {
        return false;
    };
    let parts: Vec<_> = relative.split('/').collect();
    if !(1..=2).contains(&parts.len()) {
        return false;
    }
    if parts.len() == 2 && !is_identifier(parts[0]) {
        return false;
    }
    let Some(file_name) = parts.last() else {
        return false;
    };
    let Some((name, extension)) = file_name.rsplit_once('.') else {
        return false;
    };
    is_identifier(name)
        && !extension.is_empty()
        && extension.bytes().all(|value| value.is_ascii_alphanumeric())
}

pub fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn replace(content: &str, source: &str, target: &str) -> String {
    let mut result = content.to_owned();
    for reference in references(content)
        .into_iter()
        .rev()
        .filter(|reference| reference.path == source)
    {
        result.replace_range(reference.target, target);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{is_managed_path, references, replace};

    #[test]
    fn excludes_code_and_unsafe_paths_and_preserves_unicode_offsets() {
        let source = "中文 [报告](./assets/note/file.pdf)\n`![图](./assets/code.png)`\n````md\n![图](./assets/fenced.png)\n````\n![图](./assets/old.png)\n[x](./assets/../secret.pdf)";
        let paths: Vec<_> = references(source).iter().map(|item| item.path).collect();
        assert_eq!(paths, ["assets/note/file.pdf", "assets/old.png"]);
        assert!(
            replace(source, "assets/note/file.pdf", "./报告.pdf")
                .starts_with("中文 [报告](./报告.pdf)")
        );
        assert!(!is_managed_path("assets/note/../../secret.pdf"));
    }
}

use crate::graph::types::{ParsedCall, ParsedSymbol};

const CALL_SKIP: &[&str] = &[
    "if",
    "for",
    "while",
    "do",
    "switch",
    "catch",
    "function",
    "return",
    "new",
    "delete",
    "typeof",
    "void",
    "throw",
    "case",
    "else",
    "try",
    "finally",
    "class",
    "import",
    "export",
    "await",
    "super",
    "instanceof",
    "in",
    "of",
    "const",
    "let",
    "var",
    "async",
    "yield",
];

pub fn extract_symbols(source: &str) -> Vec<ParsedSymbol> {
    let mut out = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("*") {
            continue;
        }
        let line_no = (idx + 1) as i64;
        if let Some(name) = parse_function_decl(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "function".to_string(),
                line: line_no,
                end_line: line_no,
            });
            continue;
        }
        if let Some(name) = parse_class_decl(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "class".to_string(),
                line: line_no,
                end_line: line_no,
            });
            continue;
        }
        if let Some(name) = parse_const_fn(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "function".to_string(),
                line: line_no,
                end_line: line_no,
            });
        }
    }
    out
}

pub fn extract_calls(source: &str) -> Vec<ParsedCall> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (idx, line) in source.lines().enumerate() {
        let line_no = (idx + 1) as i64;
        for callee in scan_call_targets(line) {
            let key = format!("{callee}@{line_no}");
            if seen.insert(key) {
                out.push(ParsedCall {
                    callee,
                    line: line_no,
                });
            }
        }
    }
    out
}

fn parse_function_decl(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("export ")
        .or_else(|| line.strip_prefix("public "))
        .or_else(|| line.strip_prefix("private "))
        .or_else(|| line.strip_prefix("protected "))
        .unwrap_or(line);
    let rest = rest.strip_prefix("async ").unwrap_or(rest);
    let rest = rest.strip_prefix("function ")?;
    let name = take_ident(rest)?;
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn parse_class_decl(line: &str) -> Option<String> {
    let rest = line.strip_prefix("export ").unwrap_or(line);
    let rest = rest.strip_prefix("abstract ").unwrap_or(rest);
    let rest = rest.strip_prefix("class ")?;
    take_ident(rest)
}

fn parse_const_fn(line: &str) -> Option<String> {
    let rest = line.strip_prefix("export ").unwrap_or(line);
    let rest = rest.strip_prefix("const ")?;
    let name = take_ident(rest)?;
    let after = rest[name.len()..].trim();
    if after.starts_with('=')
        && (after.contains("function") || after.contains("=>") || after.contains("async"))
    {
        return Some(name);
    }
    None
}

fn take_ident(text: &str) -> Option<String> {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
            out.push(ch);
        } else {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn scan_call_targets(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' || bytes[i] == b'$' {
            let start = i;
            i += 1;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$')
            {
                i += 1;
            }
            let ident = &line[start..i];
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'(' && !CALL_SKIP.contains(&ident) {
                out.push(ident.to_string());
            }
            continue;
        }
        if bytes[i] == b'.' {
            i += 1;
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$')
            {
                i += 1;
            }
            if start < i {
                let method = &line[start..i];
                let mut j = i;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'(' && !CALL_SKIP.contains(&method) {
                    out.push(method.to_string());
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_symbols_and_calls() {
        let src = r#"
function alpha() {}
export async function beta() {}
class Gamma {}
const delta = () => foo();
function run() {
  beta();
  helper.process();
}
"#;
        let symbols: Vec<_> = extract_symbols(src).into_iter().map(|s| s.name).collect();
        assert!(symbols.contains(&"alpha".to_string()));
        assert!(symbols.contains(&"beta".to_string()));
        assert!(symbols.contains(&"Gamma".to_string()));
        assert!(symbols.contains(&"delta".to_string()));
        assert!(symbols.contains(&"run".to_string()));

        let calls: Vec<_> = extract_calls(src).into_iter().map(|c| c.callee).collect();
        assert!(calls.contains(&"beta".to_string()));
        assert!(calls.contains(&"process".to_string()));
        assert!(calls.contains(&"foo".to_string()));
    }
}

use crate::index::{CHUNK_CONTENT_MAX_CHARS, CHUNK_LINES, CHUNK_OVERLAP};
use crate::treesitter::lang::{parse_source, SourceLang};

/// Inclusive 1-based line ranges for functions / classes / methods.
pub fn structural_chunk_ranges(rel_path: &str, source: &str) -> Option<Vec<(usize, usize)>> {
    let lang = SourceLang::from_path(rel_path)?;
    let tree = parse_source(lang, source)?;
    let root = tree.root_node();
    let mut ranges = Vec::new();
    walk_defs(root, source.as_bytes(), lang, &mut ranges);
    if ranges.is_empty() {
        return None;
    }
    ranges.sort_by_key(|(s, _)| *s);
    // Merge overlaps
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 + 1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    Some(merged)
}

fn walk_defs(
    node: tree_sitter::Node,
    src: &[u8],
    lang: SourceLang,
    out: &mut Vec<(usize, usize)>,
) {
    let kind = node.kind();
    let is_def = match lang {
        SourceLang::JavaScript | SourceLang::TypeScript | SourceLang::Tsx => matches!(
            kind,
            "function_declaration"
                | "generator_function_declaration"
                | "class_declaration"
                | "method_definition"
                | "abstract_class_declaration"
                | "function_expression"
                | "arrow_function"
        ),
        SourceLang::Python => matches!(kind, "function_definition" | "class_definition"),
        SourceLang::Go => matches!(
            kind,
            "function_declaration" | "method_declaration" | "type_declaration"
        ),
        SourceLang::Rust => matches!(
            kind,
            "function_item" | "impl_item" | "struct_item" | "enum_item" | "trait_item" | "mod_item"
        ),
    };

    // Prefer named declarations; skip tiny arrow callbacks inside other defs
    if is_def {
        let start = node.start_position().row + 1;
        let end = node.end_position().row + 1;
        if end >= start {
            // Skip anonymous bare arrows shorter than 3 lines unless top-level-ish
            let skip_tiny_arrow = matches!(kind, "arrow_function" | "function_expression")
                && (end - start) < 2
                && node.parent().map(|p| p.kind() != "program" && p.kind() != "export_statement")
                    .unwrap_or(true);
            if !skip_tiny_arrow {
                let _ = src; // keep signature parity for future text checks
                out.push((start, end));
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_defs(child, src, lang, out);
    }
}

/// Produce chunk slices: `(start_line, end_line, content)` using AST ranges when possible.
pub fn iter_chunk_slices(rel_path: &str, text: &str) -> Vec<(i64, i64, String)> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let mut ranges = structural_chunk_ranges(rel_path, text).unwrap_or_default();
    if ranges.is_empty() {
        return line_window_chunks(&lines);
    }

    // Preamble before first symbol
    if ranges[0].0 > 5 {
        ranges.insert(0, (1, ranges[0].0.saturating_sub(1)));
    }

    let mut out = Vec::new();
    for (s, e) in ranges {
        push_range_chunks(&lines, s, e, &mut out);
    }

    // If AST coverage is thin, fill remainder with line windows for uncovered regions
    let covered = covered_line_set(&out, lines.len());
    let uncovered = uncovered_windows(&covered, lines.len());
    for (s, e) in uncovered {
        push_range_chunks(&lines, s, e, &mut out);
    }

    if out.is_empty() {
        return line_window_chunks(&lines);
    }
    out.sort_by_key(|(s, _, _)| *s);
    out
}

fn covered_line_set(chunks: &[(i64, i64, String)], total: usize) -> Vec<bool> {
    let mut covered = vec![false; total + 1];
    for (s, e, _) in chunks {
        let s = (*s as usize).clamp(1, total);
        let e = (*e as usize).clamp(1, total);
        for i in s..=e {
            covered[i] = true;
        }
    }
    covered
}

fn uncovered_windows(covered: &[bool], total: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 1usize;
    while i <= total {
        if covered[i] {
            i += 1;
            continue;
        }
        let start = i;
        while i <= total && !covered[i] {
            i += 1;
        }
        let end = i - 1;
        if end >= start && (end - start + 1) >= (CHUNK_LINES / 2).max(8) {
            out.push((start, end));
        }
    }
    out
}

fn push_range_chunks(lines: &[&str], start: usize, end: usize, out: &mut Vec<(i64, i64, String)>) {
    let total = lines.len();
    if total == 0 || start > end {
        return;
    }
    let s0 = start.clamp(1, total);
    let e0 = end.clamp(1, total);
    if e0 < s0 {
        return;
    }
    let span = e0 - s0 + 1;
    if span <= CHUNK_LINES {
        let slice = lines[(s0 - 1)..e0].join("\n");
        if !slice.trim().is_empty() {
            let content = truncate(slice);
            out.push((s0 as i64, e0 as i64, content));
        }
        return;
    }
    let mut start_idx = s0 - 1;
    let end_idx = e0;
    loop {
        let end = (start_idx + CHUNK_LINES).min(end_idx);
        let slice = lines[start_idx..end].join("\n");
        if !slice.trim().is_empty() {
            out.push((
                (start_idx + 1) as i64,
                end as i64,
                truncate(slice),
            ));
        }
        if end >= end_idx {
            break;
        }
        start_idx += CHUNK_LINES - CHUNK_OVERLAP;
    }
}

fn line_window_chunks(lines: &[&str]) -> Vec<(i64, i64, String)> {
    let mut out = Vec::new();
    if lines.len() <= CHUNK_LINES {
        let slice = lines.join("\n");
        if !slice.trim().is_empty() {
            out.push((1, lines.len() as i64, truncate(slice)));
        }
        return out;
    }
    let mut start = 0usize;
    loop {
        let end = (start + CHUNK_LINES).min(lines.len());
        let slice = lines[start..end].join("\n");
        if !slice.trim().is_empty() {
            out.push((
                start as i64 + 1,
                end as i64,
                truncate(slice),
            ));
        }
        if end >= lines.len() {
            break;
        }
        start += CHUNK_LINES - CHUNK_OVERLAP;
    }
    out
}

fn truncate(s: String) -> String {
    if s.chars().count() <= CHUNK_CONTENT_MAX_CHARS {
        return s;
    }
    s.chars().take(CHUNK_CONTENT_MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_js_by_function() {
        let src = r#"
const x = 1;

function foo() {
  return 1;
}

function bar() {
  return 2;
}
"#;
        let ranges = structural_chunk_ranges("a.js", src).expect("ranges");
        assert!(ranges.len() >= 2, "expected >=2 function ranges, got {ranges:?}");
        let slices = iter_chunk_slices("a.js", src);
        assert!(slices.len() >= 2);
        assert!(slices.iter().any(|(_, _, c)| c.contains("function foo")));
    }

    #[test]
    fn falls_back_for_unknown_ext() {
        let src = "line1\nline2\nline3\n";
        let slices = iter_chunk_slices("readme.txt", src);
        assert_eq!(slices.len(), 1);
    }
}

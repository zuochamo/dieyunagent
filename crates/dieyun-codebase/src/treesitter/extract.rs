use crate::graph::types::{ParsedCall, ParsedImport, ParsedSymbol};
use crate::treesitter::lang::{parse_source, SourceLang};

#[derive(Debug, Default)]
pub struct AstGraphExtract {
    pub imports: Vec<ParsedImport>,
    pub symbols: Vec<ParsedSymbol>,
    pub calls: Vec<ParsedCall>,
}

/// Tree-sitter 抽取；失败（语法有错 / 不是这四种语言）返回 None，调用方**跳过该文件**
/// （不退回任何第二套抽取器：那套启发式实现已于 2026-11-18 删除）。
pub fn extract_graph_ast(rel_path: &str, source: &str) -> Option<AstGraphExtract> {
    let lang = SourceLang::from_path(rel_path)?;
    let tree = parse_source(lang, source)?;
    // 语法有错的文件（半保存 / 混合语法 / 生成物）：AST 只覆盖了错误区**之前**的部分，
    // 之后的 import / call 全丢，而且丢掉的东西会被当成「这里没有依赖、没人调用」。
    // 返回 None 表示「这一轮不贡献任何边」：调用方既不记 mtime 也不写行，下次保存再试。
    // 用半棵 AST 硬抽会更糟 —— 错误区之后的 import / call 会整段消失，而模型会把
    // 「没解析出来」当成「没有依赖、没人调用」。
    if tree.root_node().has_error() {
        return None;
    }
    let root = tree.root_node();
    let mut out = AstGraphExtract::default();
    walk(root, source.as_bytes(), lang, &mut out);
    if out.imports.is_empty() && out.symbols.is_empty() && out.calls.is_empty() {
        return None;
    }
    Some(out)
}

fn walk(node: tree_sitter::Node, src: &[u8], lang: SourceLang, out: &mut AstGraphExtract) {
    match lang {
        SourceLang::JavaScript | SourceLang::TypeScript | SourceLang::Tsx => {
            collect_js_like(node, src, out);
        }
        SourceLang::Python => collect_python(node, src, out),
        SourceLang::Go => collect_go(node, src, out),
        SourceLang::Rust => collect_rust(node, src, out),
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, src, lang, out);
    }
}

/// `s` 是不是一个可以用作「调用目标 / 符号名」的标识符。
///
/// 判据只有这一份（原来是启发式抽取器里的 `is_ident`，那套抽取器已整体删除）：
/// ASCII 标识符，首字符非数字。中文标识符在这里一律返回 false —— 图上的边只认 ASCII 名，
/// 与 `graph_queries` 的 `callee_name` 匹配口径一致。
fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn node_text<'a>(node: tree_sitter::Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

fn line_of(node: tree_sitter::Node) -> i64 {
    (node.start_position().row + 1) as i64
}

/// 去掉字符串字面量两端的引号（`'x'` / `"x"` / `` `x` ``）。
fn unquote(text: &str) -> String {
    text.trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string()
}

fn end_line_of(node: tree_sitter::Node) -> i64 {
    (node.end_position().row + 1) as i64
}

fn collect_js_like(node: tree_sitter::Node, src: &[u8], out: &mut AstGraphExtract) {
    match node.kind() {
        "import_statement" | "export_statement" => {
            // 模块名只认 AST 的 `source` 字段：`import ... from 'x'`、`export ... from 'x'`
            // 才有它。不能扫「节点文本里的第一个字符串」—— `export const MODE = "foo"`
            // 会把 "foo" 当模块名，凭空造出一条外部依赖；`export function f() { return "a" }`
            // 同理（require('x') 的旁支在 call_expression 处理）。
            if let Some(source) = node.child_by_field_name("source") {
                let spec = unquote(node_text(source, src));
                if !spec.is_empty() {
                    out.imports.push(ParsedImport {
                        spec,
                        line: line_of(node),
                    });
                }
            }
        }
        "call_expression" => {
            if let Some(func) = node.child_by_field_name("function") {
                let fname = node_text(func, src);
                if fname == "require" {
                    if let Some(args) = node.child_by_field_name("arguments") {
                        let t = node_text(args, src);
                        if let Some(spec) = extract_quoted_module(t) {
                            out.imports.push(ParsedImport {
                                spec,
                                line: line_of(node),
                            });
                        }
                    }
                } else {
                    let callee = leaf_callee_name(func, src);
                    if !callee.is_empty() && is_ident(&callee) {
                        out.calls.push(ParsedCall {
                            callee,
                            line: line_of(node),
                        });
                    }
                }
            }
        }
        "function_declaration" | "generator_function_declaration" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "function", node_text(name, src), node);
            }
        }
        "class_declaration" | "abstract_class_declaration" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "class", node_text(name, src), node);
            }
        }
        "method_definition" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "method", node_text(name, src), node);
            }
        }
        "lexical_declaration" | "variable_declaration" => {
            // const foo = () => {} / function expr
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() != "variable_declarator" {
                    continue;
                }
                let Some(name) = child.child_by_field_name("name") else {
                    continue;
                };
                let Some(value) = child.child_by_field_name("value") else {
                    continue;
                };
                if matches!(
                    value.kind(),
                    "arrow_function" | "function_expression" | "generator_function"
                ) {
                    push_symbol(out, "function", node_text(name, src), value);
                }
            }
        }
        _ => {}
    }
}

fn collect_python(node: tree_sitter::Node, src: &[u8], out: &mut AstGraphExtract) {
    match node.kind() {
        "import_statement" | "import_from_statement" => {
            let text = node_text(node, src);
            for spec in python_import_specs(text) {
                out.imports.push(ParsedImport {
                    spec,
                    line: line_of(node),
                });
            }
        }
        "function_definition" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "function", node_text(name, src), node);
            }
        }
        "class_definition" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "class", node_text(name, src), node);
            }
        }
        "call" => {
            if let Some(func) = node.child_by_field_name("function") {
                let callee = leaf_callee_name(func, src);
                if !callee.is_empty() && is_ident(&callee) {
                    out.calls.push(ParsedCall {
                        callee,
                        line: line_of(node),
                    });
                }
            }
        }
        _ => {}
    }
}

fn collect_go(node: tree_sitter::Node, src: &[u8], out: &mut AstGraphExtract) {
    match node.kind() {
        "import_declaration" => {
            let text = node_text(node, src);
            for spec in go_import_specs(text) {
                out.imports.push(ParsedImport {
                    spec,
                    line: line_of(node),
                });
            }
        }
        "function_declaration" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "function", node_text(name, src), node);
            }
        }
        "method_declaration" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "method", node_text(name, src), node);
            }
        }
        "type_declaration" => {
            // type Foo struct …
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "type_spec" {
                    if let Some(name) = child.child_by_field_name("name") {
                        let kind = child
                            .child_by_field_name("type")
                            .map(|t| t.kind())
                            .unwrap_or("type");
                        let k = if kind.contains("struct") {
                            "struct"
                        } else if kind.contains("interface") {
                            "interface"
                        } else {
                            "type"
                        };
                        push_symbol(out, k, node_text(name, src), child);
                    }
                }
            }
        }
        "call_expression" => {
            if let Some(func) = node.child_by_field_name("function") {
                let callee = leaf_callee_name(func, src);
                if !callee.is_empty() && is_ident(&callee) {
                    out.calls.push(ParsedCall {
                        callee,
                        line: line_of(node),
                    });
                }
            }
        }
        _ => {}
    }
}

fn collect_rust(node: tree_sitter::Node, src: &[u8], out: &mut AstGraphExtract) {
    match node.kind() {
        "use_declaration" => {
            let text = node_text(node, src);
            if let Some(spec) = rust_use_spec(text) {
                out.imports.push(ParsedImport {
                    spec,
                    line: line_of(node),
                });
            }
        }
        "function_item" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "function", node_text(name, src), node);
            }
        }
        "struct_item" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "struct", node_text(name, src), node);
            }
        }
        "enum_item" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "enum", node_text(name, src), node);
            }
        }
        "trait_item" => {
            if let Some(name) = node.child_by_field_name("name") {
                push_symbol(out, "trait", node_text(name, src), node);
            }
        }
        "mod_item" => {
            if let Some(name) = node.child_by_field_name("name") {
                let mod_name = node_text(name, src);
                push_symbol(out, "mod", mod_name, node);
                // `mod util;`（没有 body）是**跨文件**依赖；`mod x { … }` 是文件内联
                // 模块，不产生文件边。spec 沿用统一的 `mod:` 约定 ——
                // 「spec → 哪个文件」只在 `resolve_rust_import` 一处解算。
                if node.child_by_field_name("body").is_none() && is_ident(mod_name) {
                    out.imports.push(ParsedImport {
                        spec: format!("mod:{mod_name}"),
                        line: line_of(node),
                    });
                }
            }
        }
        "impl_item" => {
            // Use type name as symbol when present
            if let Some(ty) = node.child_by_field_name("type") {
                let name = node_text(ty, src);
                let short = name.split("::").last().unwrap_or(name).trim();
                if !short.is_empty() {
                    push_symbol(out, "impl", short, node);
                }
            }
        }
        "call_expression" => {
            if let Some(func) = node.child_by_field_name("function") {
                let callee = leaf_callee_name(func, src);
                if !callee.is_empty() && is_ident(&callee) {
                    out.calls.push(ParsedCall {
                        callee,
                        line: line_of(node),
                    });
                }
            }
        }
        _ => {}
    }
}

fn push_symbol(out: &mut AstGraphExtract, kind: &str, name: &str, node: tree_sitter::Node) {
    let name = name.trim();
    if name.is_empty() || !is_ident(name) {
        return;
    }
    out.symbols.push(ParsedSymbol {
        name: name.to_string(),
        kind: kind.to_string(),
        line: line_of(node),
        end_line: end_line_of(node),
    });
}

fn leaf_callee_name(node: tree_sitter::Node, src: &[u8]) -> String {
    match node.kind() {
        "identifier" | "property_identifier" | "field_identifier" | "type_identifier" => {
            node_text(node, src).to_string()
        }
        "member_expression" | "field_expression" => {
            if let Some(prop) = node.child_by_field_name("property").or_else(|| {
                node.child_by_field_name("field")
            }) {
                return node_text(prop, src).to_string();
            }
            node_text(node, src)
                .rsplit(['.', ':'])
                .next()
                .unwrap_or("")
                .to_string()
        }
        "scoped_identifier" | "scoped_type_identifier" => node_text(node, src)
            .rsplit("::")
            .next()
            .unwrap_or("")
            .to_string(),
        _ => {
            let t = node_text(node, src);
            t.rsplit(['.', ':'])
                .next()
                .unwrap_or(t)
                .trim()
                .to_string()
        }
    }
}


fn extract_quoted_module(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\'' || b == b'"' || b == b'`' {
            let quote = b;
            if let Some(j) = bytes[i + 1..].iter().position(|&c| c == quote) {
                let s = &text[i + 1..i + 1 + j];
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn python_import_specs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("from ") {
        let mod_name = rest.split_whitespace().next().unwrap_or("").trim();
        if !mod_name.is_empty() {
            out.push(mod_name.to_string());
        }
    } else if let Some(rest) = t.strip_prefix("import ") {
        for part in rest.split(',') {
            let name = part
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches(['(', ')']);
            if !name.is_empty() {
                out.push(name.to_string());
            }
        }
    }
    out
}

fn go_import_specs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(spec) = extract_quoted_module(line) {
            out.push(spec);
        }
    }
    out
}

fn rust_use_spec(text: &str) -> Option<String> {
    let t = text.trim().trim_end_matches(';');
    let rest = t.strip_prefix("use ")?.trim();
    let spec = rest
        .split(['{', ';'])
        .next()
        .unwrap_or(rest)
        .trim()
        .trim_end_matches("::")
        .to_string();
    if spec.is_empty() {
        None
    } else {
        Some(spec)
    }
}

#[cfg(test)]
mod tests {

    /// 语法有错的文件返回 None（调用方据此跳过，不记 mtime）：
    /// 用半棵 AST 硬抽会让错误区之后的 import / call 整段消失。
    #[test]
    fn syntax_error_files_are_skipped() {
        assert!(
            extract_graph_ast("broken.js", "function a( { b(); }").is_none(),
            "带 ERROR 节点的文件应返回 None（这一轮不贡献边）"
        );
        assert!(
            extract_graph_ast("ok.js", "function a() { b(); }").is_some(),
            "合法源码仍走 AST"
        );
    }
    use super::*;

    #[test]
    fn extracts_js_symbols_and_imports() {
        let src = r#"
import { x } from './lib';
const b = require('./b');
function caller() { helper(); }
class Foo { bar() { caller(); } }
"#;
        let r = extract_graph_ast("a.js", src).expect("ast");
        assert!(r.imports.iter().any(|i| i.spec.contains("./lib")));
        assert!(r.imports.iter().any(|i| i.spec.contains("./b")));
        assert!(r.symbols.iter().any(|s| s.name == "caller" && s.kind == "function"));
        assert!(r.symbols.iter().any(|s| s.name == "Foo" && s.kind == "class"));
        assert!(r.calls.iter().any(|c| c.callee == "helper" || c.callee == "caller"));
    }

    #[test]
    fn extracts_python_defs() {
        let src = "from .helper import work\n\ndef main():\n    work()\n";
        let r = extract_graph_ast("pkg/main.py", src).expect("ast");
        assert!(r.imports.iter().any(|i| i.spec.contains(".helper") || i.spec == ".helper"));
        assert!(r.symbols.iter().any(|s| s.name == "main"));
        assert!(r.calls.iter().any(|c| c.callee == "work"));
    }

    /// `export_statement` 里的普通字符串不是模块名：只有 `export ... from 'x'` 才算依赖。
    /// （曾把节点文本里第一个字符串当模块名，`export const MODE = "foo"` 会造出假依赖）
    #[test]
    fn export_statement_without_source_is_not_an_import() {
        let src = r#"
export const MODE = "foo";
export function f() { return "a"; }
export { x } from './real';
"#;
        let r = extract_graph_ast("a.js", src).expect("ast");
        let specs: Vec<&str> = r.imports.iter().map(|i| i.spec.as_str()).collect();
        assert_eq!(specs, vec!["./real"], "只应有 export ... from 那一条: {specs:?}");
    }

    /// `import` 的模块名取 AST 的 source 字段，不受语句里其它字符串影响。
    #[test]
    fn import_spec_comes_from_source_field() {
        let src = "import { a } from './lib';\nconst s = 'not-a-module';\n";
        let r = extract_graph_ast("a.js", src).expect("ast");
        let specs: Vec<&str> = r.imports.iter().map(|i| i.spec.as_str()).collect();
        assert_eq!(specs, vec!["./lib"], "不应把普通字符串当模块名: {specs:?}");
    }
}

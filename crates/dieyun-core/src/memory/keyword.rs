use std::collections::HashSet;

pub fn tokenize_memory(text: &str) -> HashSet<String> {
    let s = text.to_lowercase();
    let mut set = HashSet::new();

    for ch in s.chars().filter(|c| is_cjk(*c)) {
        set.insert(ch.to_string());
    }
    let cjk: Vec<char> = s.chars().filter(|c| is_cjk(*c)).collect();
    for i in 0..cjk.len().saturating_sub(1) {
        set.insert(format!("{}{}", cjk[i], cjk[i + 1]));
    }

    for word in extract_id_tokens(&s) {
        if word.len() >= 2 {
            set.insert(word.clone());
        }
        let parts = split_camel_snake(&word);
        for p in parts {
            if p.len() >= 2 {
                set.insert(p);
            }
        }
    }

    for w in s.split(|c: char| {
        c.is_whitespace()
            || c == '/'
            || c == '\\'
            || c == '.'
            || c == '_'
            || c == '-'
            || c == '+'
            || c == ':'
            || c == ','
            || c == ';'
            || c == '!'
            || c == '?'
            || c == '，'
            || c == '。'
            || c == '；'
            || c == '：'
            || c == '、'
    }) {
        let w = w.trim();
        if w.len() >= 2 && w.len() <= 64 {
            set.insert(w.to_string());
        }
    }

    set
}

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4e00}'..='\u{9fff}'
            | '\u{3400}'..='\u{4dbf}'
            | '\u{f900}'..='\u{faff}'
    )
}

fn extract_id_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_alphabetic() || c == '_' || (!cur.is_empty() && c.is_ascii_digit()) {
            cur.push(c);
        } else {
            if cur.len() >= 2 {
                out.push(cur.clone());
            }
            cur.clear();
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

fn split_camel_snake(id: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    for c in id.chars() {
        if c == '_' {
            if !cur.is_empty() {
                parts.push(cur.to_lowercase());
                cur.clear();
            }
        } else if c.is_ascii_uppercase() && !cur.is_empty() {
            parts.push(cur.to_lowercase());
            cur.clear();
            cur.push(c.to_ascii_lowercase());
        } else {
            cur.push(c.to_ascii_lowercase());
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

pub fn keyword_score_row(
    query_tokens: &HashSet<String>,
    query_lower: &str,
    content: &str,
    source: Option<&str>,
    scope: Option<&str>,
    kind: Option<&str>,
    importance: i64,
    status: &str,
    created_at: i64,
    now: i64,
) -> f64 {
    let text = format!(
        "{} {} {} {}",
        content,
        source.unwrap_or(""),
        scope.unwrap_or(""),
        kind.unwrap_or("")
    );
    let tokens = tokenize_memory(&text);
    let mut hits = 0usize;
    for token in query_tokens {
        if tokens.contains(token) {
            hits += 1;
        }
    }
    let literal = if content.to_lowercase().contains(query_lower) {
        1.0
    } else {
        0.0
    };
    let freshness = freshness_score(now, created_at);
    let status_penalty = if status == "stale" { -0.15 } else { 0.0 };
    let denom = query_tokens.len().max(1) as f64;
    (hits as f64 / denom) * 0.65
        + literal * 0.25
        + (importance as f64) * 0.035
        + freshness * 0.08
        + status_penalty
}

fn freshness_score(now: i64, created_at: i64) -> f64 {
    let age_ms = (now - created_at).max(0) as f64;
    let max_age = 180.0 * 24.0 * 60.0 * 60.0 * 1000.0;
    (1.0 - (age_ms / max_age).min(1.0)).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_has_cjk_bigrams() {
        let t = tokenize_memory("用户登录 API_KEY");
        assert!(t.contains("用"));
        assert!(t.contains("用户"));
        assert!(t.contains("api_key") || t.contains("api") || t.contains("key"));
    }
}

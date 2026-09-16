//! Approximate vector scan helpers for large corpora.
//!
//! Below the byte-budget threshold we score every stored vector (exact cosine).
//! Above it we always score lexical (FTS / name) candidates, then a modular
//! stratified sample of the remaining vectors — no native ANN extension required.
//!
//! 阈值必须按**字节**而不是条数计算：向量以 f32 BLOB 存在 SQLite 里，
//! 4096 维模型单条就是 16KB，而 768 维只有 3KB，同样条数的读取成本差 5 倍。

/// 精确全量扫描的向量数据预算（字节）。含 BLOB 读取 + 反序列化 + 余弦。
/// 实测（4096 维）：31MB 约 54ms 读取 + 18ms 余弦（Node 上界，Rust 更快）。
/// 一次 LLM 往返是秒级，因此宁可多花几十毫秒也不漏召回。
pub const VECTOR_EXACT_MAX_BYTES: i64 = 32 * 1024 * 1024;

/// ANN 模式下抽样扫描的向量数据预算（字节）。
/// 与精确预算同量级：这样每次检索扫描的向量数据量恒定在预算内，
/// 不会出现「超阈值后召回率断崖下跌」——只扫 1/17 的语料基本等于随机。
pub const VECTOR_ANN_SAMPLE_MAX_BYTES: i64 = 32 * 1024 * 1024;

/// 单条向量的字节数（f32）。
pub fn vector_bytes(dims: i64) -> i64 {
    if dims <= 0 {
        4
    } else {
        dims * 4
    }
}

/// 精确扫描的条数阈值：由字节预算换算，并设下限避免低维模型退化为不精确。
pub fn exact_scan_threshold(dims: i64) -> i64 {
    (VECTOR_EXACT_MAX_BYTES / vector_bytes(dims)).max(256)
}

/// Stable seed from query text (used to rotate the sample residue class).
pub fn query_seed(query: &str) -> i64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in query.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    (h & 0x7fff_ffff) as i64
}

/// Modulus for stratified sampling: expect ~[`VECTOR_ANN_SAMPLE_MAX_BYTES`]
/// worth of vectors to be scored.
pub fn sample_modulus_for(vector_count: i64, dims: i64) -> i64 {
    if vector_count <= 0 {
        return 1;
    }
    let target = (VECTOR_ANN_SAMPLE_MAX_BYTES / vector_bytes(dims)).max(512);
    ((vector_count + target - 1) / target).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_scales_with_dimensions() {
        // 4096 维单条 16KB：32MB 预算约 2048 条（本项目实际使用的高维模型）
        let t4096 = exact_scan_threshold(4096);
        assert!((2048..=2100).contains(&t4096), "got {t4096}");
        // 768 维系单条 3KB：同样预算能精确扫描上万条
        assert!(exact_scan_threshold(768) > 10_000);
        // 极低维不会低于下限
        assert!(exact_scan_threshold(2) >= 256);
    }

    #[test]
    fn modulus_grows_with_corpus() {
        // 小仓库：不抽样
        assert_eq!(sample_modulus_for(500, 768), 1);
        // 高维大仓库：必须抽样，且随规模增长
        let small = sample_modulus_for(6000, 4096);
        let large = sample_modulus_for(60_000, 4096);
        assert!(small > 1, "got {small}");
        assert!(large > small, "{large} !> {small}");
        // 抽样后的实际扫描量仍应落在预算内（不会随语料无限增长）
        let scanned = (60_000 / large) * vector_bytes(4096);
        assert!(
            scanned <= VECTOR_ANN_SAMPLE_MAX_BYTES + vector_bytes(4096),
            "sampled bytes {scanned} exceeds budget"
        );
    }

    #[test]
    fn seed_is_stable() {
        assert_eq!(query_seed("hello"), query_seed("hello"));
        assert_ne!(query_seed("hello"), query_seed("world"));
    }
}

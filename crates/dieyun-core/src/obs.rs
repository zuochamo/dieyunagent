//! 观测出口：core 侧**只此一处**写「结构化的一行到 stderr」。
//!
//! 为什么要有这个模块：这些记录以前散在三个地方（`rpc/stdio.rs` 的 `[rpc-slow]`、
//! 折叠处临时加的 `eprintln!`、以及根本没有的 usage / 工具耗时）。宿主把 core 的 stderr
//! 收进 `main.log`，于是「一行前缀 + 几个字段」就是**唯一**能在生产里事后复盘的东西 ——
//! 前提是前缀和字段名稳定、且只有一处定义。
//!
//! 规矩：
//! - 前缀固定 `[rpc-*]`，字段一律 `k=v`（便于 `grep`/`awk`，不做 JSON 嵌套）；
//! - 格式化函数是**纯函数**（返回 `String` 或 `Option<String>`），只有 [`emit`] 碰 IO ——
//!   这样每一条都能被用例钉住格式，不需要真的去截获 stderr；
//! - 不做采样、不做聚合：core 是短生命周期请求驱动的，日志量由调用点控制（只记「慢/异常」）。

use std::fmt::Write as _;

/// 唯一写出口：一行一条，`\n` 结尾由 `eprintln!` 负责。
fn emit(line: &str) {
    eprintln!("{line}");
}

/// 一行慢 RPC；未达阈值返回 `None`（调用方据此决定要不要写）。
///
/// 阈值来自 `assets/agent-shared.json` 的 `rpc.slowLogMs`（Node 侧
/// `core-rpc-timeouts.js:SLOW_RPC_LOG_MS` 读同一份）：两侧都记才能分辨「core 内部慢」
/// 还是「RPC 堵在传输/宿主里」。
pub(crate) fn rpc_slow_line(method: &str, elapsed_ms: u64, threshold_ms: u64) -> Option<String> {
    if elapsed_ms < threshold_ms {
        return None;
    }
    Some(format!("[rpc-slow] {method} {elapsed_ms}ms"))
}

/// 一行折叠事实：**折叠是唯一压缩机制**，折了多少、折到第几档必须留痕。
pub(crate) fn fold_line(
    run_id: &str,
    level: u8,
    tokens_before: usize,
    tokens_before_estimated: usize,
    tokens_after: usize,
    trigger_source: &str,
    folded_tools: usize,
    folded_texts: usize,
) -> String {
    format!(
        "[rpc-fold] run={run_id} level={level} before={tokens_before} \
         before_est={tokens_before_estimated} after={tokens_after} \
         trigger={trigger_source} tools={folded_tools} texts={folded_texts}"
    )
}

/// 一行每轮 usage：`prompt_tokens` 是折叠触发的首选口径，缺了就说明上游没给。
pub(crate) fn usage_line(
    run_id: &str,
    round: u32,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
) -> Option<String> {
    let prompt = prompt_tokens?;
    let mut line = format!("[rpc-usage] run={run_id} round={round} prompt={prompt}");
    if let Some(c) = completion_tokens {
        let _ = write!(line, " completion={c}");
    }
    if let Some(t) = total_tokens {
        let _ = write!(line, " total={t}");
    }
    Some(line)
}

/// 一行工具段耗时：宿主在 `need_delegate` 与 `agent.run.tools` 之间跑的全部工具。
///
/// core 不执行工具，但它知道这段**墙钟**有多长 —— 「这一轮为什么慢」的答案有一半在这里。
pub(crate) fn tool_line(run_id: &str, count: usize, elapsed_ms: u64) -> String {
    format!("[rpc-tools] run={run_id} count={count} {elapsed_ms}ms")
}

pub(crate) fn rpc_slow(method: &str, elapsed_ms: u64, threshold_ms: u64) {
    if let Some(line) = rpc_slow_line(method, elapsed_ms, threshold_ms) {
        emit(&line);
    }
}

pub(crate) fn usage(run_id: &str, round: u32, usage: Option<&serde_json::Value>) {
    let num = |key: &str| usage.and_then(|u| u.get(key)).and_then(|v| v.as_u64());
    if let Some(line) = usage_line(
        run_id,
        round,
        num("prompt_tokens"),
        num("completion_tokens"),
        num("total_tokens"),
    ) {
        emit(&line);
    }
}

/// 折叠事实一行（`FoldFact` 是账本交给宿主的那份事实，这里只是把它写进日志）。
pub(crate) fn fold_fact(run_id: &str, fact: &crate::agent::FoldFact) {
    emit(&fold_line(
        run_id,
        fact.level,
        fact.tokens_before,
        fact.tokens_before_estimated,
        fact.tokens_after,
        &fact.trigger_source,
        fact.folded_tool_results,
        fact.folded_texts,
    ));
}

pub(crate) fn tool_round(run_id: &str, count: usize, elapsed_ms: u64) {
    emit(&tool_line(run_id, count, elapsed_ms));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 阈值以下不写：日志量由调用点控制，别每轮刷一行。
    #[test]
    fn slow_rpc_respects_the_shared_threshold() {
        assert!(rpc_slow_line("codebase.search", 1999, 2000).is_none());
        let line = rpc_slow_line("codebase.search", 2000, 2000).expect("到阈值就要写");
        assert_eq!(line, "[rpc-slow] codebase.search 2000ms");
    }

    /// 折叠事实必须带**两个口径的 before**（usage 与估值不同源，见 FoldResult 注释）。
    #[test]
    fn fold_line_carries_both_before_bases() {
        let line = fold_line("run-1", 2, 9000, 8800, 3000, "usage", 4, 1);
        assert!(line.starts_with("[rpc-fold] run=run-1 level=2"), "{line}");
        assert!(line.contains("before=9000"), "{line}");
        assert!(line.contains("before_est=8800"), "{line}");
        assert!(line.contains("trigger=usage"), "{line}");
    }

    /// 上游没给 `prompt_tokens` 就不写 usage 行（写一行 0 等于假数据）。
    #[test]
    fn usage_line_requires_prompt_tokens() {
        assert!(usage_line("run-1", 3, None, Some(10), Some(10)).is_none());
        assert!(usage("run-1", 3, Some(&json!({"completion_tokens": 5}))).eq(&()));
        let line = usage_line("run-1", 3, Some(1200), Some(80), Some(1280)).unwrap();
        assert_eq!(
            line,
            "[rpc-usage] run=run-1 round=3 prompt=1200 completion=80 total=1280"
        );
    }

    #[test]
    fn tool_line_reports_count_and_wall_clock() {
        assert_eq!(
            tool_line("run-9", 3, 1234),
            "[rpc-tools] run=run-9 count=3 1234ms"
        );
    }
}

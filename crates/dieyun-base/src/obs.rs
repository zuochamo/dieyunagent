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
/// 阈值来自 `src/agent/agent-shared.json` 的 `rpc.slowLogMs`（Node 侧
/// `core-rpc-timeouts.js:SLOW_RPC_LOG_MS` 读同一份）：两侧都记才能分辨「core 内部慢」
/// 还是「RPC 堵在传输/宿主里」。
pub fn rpc_slow_line(method: &str, elapsed_ms: u64, threshold_ms: u64) -> Option<String> {
    if elapsed_ms < threshold_ms {
        return None;
    }
    Some(format!("[rpc-slow] {method} {elapsed_ms}ms"))
}

/// 一行折叠事实：**折叠是唯一压缩机制**，折了多少、折到第几档必须留痕。
pub fn fold_line(
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
pub fn usage_line(
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
pub fn tool_line(run_id: &str, count: usize, elapsed_ms: u64) -> String {
    format!("[rpc-tools] run={run_id} count={count} {elapsed_ms}ms")
}

pub fn rpc_slow(method: &str, elapsed_ms: u64, threshold_ms: u64) {
    if let Some(line) = rpc_slow_line(method, elapsed_ms, threshold_ms) {
        emit(&line);
    }
}

pub fn usage(run_id: &str, round: u32, usage: Option<&serde_json::Value>) {
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

/// 折叠事实一行。
///
/// 参数刻意是**基本类型**而不是 `agent::FoldFact`：观测层不许反向依赖 agent ——
/// 那种「为了少写几个参数」的引用在拆 crate 之后就是编译错误（循环依赖）。
pub fn fold_fact(
    run_id: &str,
    level: u8,
    tokens_before: usize,
    tokens_before_estimated: usize,
    tokens_after: usize,
    trigger_source: &str,
    folded_tools: usize,
    folded_texts: usize,
) {
    emit(&fold_line(
        run_id,
        level,
        tokens_before,
        tokens_before_estimated,
        tokens_after,
        trigger_source,
        folded_tools,
        folded_texts,
    ));
}

pub fn tool_round(run_id: &str, count: usize, elapsed_ms: u64) {
    emit(&tool_line(run_id, count, elapsed_ms));
}

/// 一行 IO 故障：`stdout` 写不出去（宿主没了）、事件通道已关闭之类。
///
/// 这类记录**必须**有：它是「core 还在跑但结果没人收」的唯一痕迹，
/// 没有它排障只能看到宿主侧超时，永远查不出是谁先断的。
pub fn io_line(channel: &str, err: &str) -> String {
    format!("[rpc-io] channel={channel} err={err}")
}

pub fn io_error(channel: &str, err: &str) {
    emit(&io_line(channel, err));
}

/// 一行「降级」记录：某条次要路径失败了，但不该中断主流程。
///
/// 用它替代「`let _ =` 静默吞掉」：失败还在，只是不至于把整件事打断。
/// 没有这一行，失败最后会以「查不到 / 想不起来」的形状出现在用户面前。
pub fn degraded_line(area: &str, msg: &str) -> String {
    format!("[rpc-degraded] area={area} msg={msg}")
}

pub fn degraded(area: &str, msg: &str) {
    emit(&degraded_line(area, msg));
}

#[cfg(test)]
mod tests {

    /// 降级行要能被 `grep` 到：它是「失败还在，但没打断主流程」的唯一痕迹。
    #[test]
    fn degraded_line_names_area_and_message() {
        assert_eq!(
            degraded_line("memory.prune", "database is locked"),
            "[rpc-degraded] area=memory.prune msg=database is locked"
        );
    }
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

    /// IO 故障行要能被 `grep` 到，且带上「哪个通道 + 什么错」。
    #[test]
    fn io_line_names_the_channel_and_the_error() {
        assert_eq!(
            io_line("stdout", "broken pipe"),
            "[rpc-io] channel=stdout err=broken pipe"
        );
    }
}

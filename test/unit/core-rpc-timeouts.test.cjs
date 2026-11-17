'use strict';

/**
 * `llm.complete` 必须拿到「一次 LLM 调用」的预算，而不是默认 120s。
 *
 * 为什么值得一条单测：这张表里长期挂着**已被删除**的 `agent.llm.chat`，而真正在跑的
 * `llm.complete`（辅助任务：回合汇总 / 评审 / 计划 / 记忆提炼 + Renderer 流式对话）
 * 一路落到默认值。core 侧按 `STREAM_TIMEOUT_SECS=600s` 还在流，宿主 120s 就
 * `reject(CORE_RPC_TIMEOUT)` —— 用户侧的表现是「说到一半突然失败」，日志里只有一行
 * 通用超时。这类「方法名改了、超时表没跟」的漂移不会让任何测试变红，除非有这条断言。
 */

const {
  resolveCoreRpcTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  LLM_CHAT_TIMEOUT_MS,
  AGENT_RUN_TIMEOUT_MS
} = require('../../src/core-rpc-timeouts');

describe('core RPC 超时表', () => {
  it('llm.complete 拿到 LLM 预算（不是默认值）', () => {
    expect(resolveCoreRpcTimeoutMs('llm.complete')).toBe(LLM_CHAT_TIMEOUT_MS);
    expect(resolveCoreRpcTimeoutMs('llm.complete')).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });

  it('已删除的 agent.llm.chat 不再占着预算', () => {
    // 表里留一个不存在的方法，等于给「真方法」留下一个静默的 120s
    expect(resolveCoreRpcTimeoutMs('agent.llm.chat')).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('驱动循环的两条 RPC 仍在 LLM 预算档', () => {
    expect(resolveCoreRpcTimeoutMs('agent.run.start')).toBe(AGENT_RUN_TIMEOUT_MS);
    expect(resolveCoreRpcTimeoutMs('agent.run.tools')).toBe(AGENT_RUN_TIMEOUT_MS);
  });

  it('显式覆盖优先于表', () => {
    expect(resolveCoreRpcTimeoutMs('llm.complete', 5000)).toBe(5000);
  });
});

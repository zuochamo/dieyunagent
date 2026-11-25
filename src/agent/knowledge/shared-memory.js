'use strict';

/**
 * 共享记忆（跨机 PostgreSQL）的**提炼器**：抢锁 → 取候选 → 模型合并 → 落库 → 记台账。
 *
 * 为什么提炼在这里而不在 `src/memory-shared/`：数据层只管「谁抢到锁、候选是谁、结果怎么落库」，
 * 模型调用与提示词只有归纳器这一份实现（`knowledge/llm.js`）。输出格式复用归纳器同一套 JSON，
 * 所以解析也走 `signals.parseKnowledgeJson`，不写第二份。
 *
 * 抢不到锁（别的机器正在提炼）或还在冷却期就**直接返回**，不排队、不重试 —— 这是唯一需要的调度，
 * 没有 master/slave 模式，也没有「现在就提炼」的授权密码。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续再导出。
 */

const { resolveLlmCall, callLlm, extractContent } = require('./llm');
const { compactPlain, parseKnowledgeJson } = require('./signals');

// ---------------------------------------------------------------------------
// 共享记忆（跨机 PostgreSQL）的提炼
// ---------------------------------------------------------------------------

/**
 * 提炼用的提示词。输出格式**复用归纳器同一套 JSON**（`memories` / `archive_memory_ids`），
 * 因此解析不用第二份：`parseKnowledgeJson` 就是唯一实现。
 *
 * 为什么提炼放在这里而不是 `src/memory-shared`：记忆提炼本来就只有这一个实现
 * （模型调用、端点与请求头也在这个模块的 `resolveLlmCall`/`callLlm`）。数据层只管
 * 「谁抢到锁、候选是谁、结果怎么落库」，不重复写 prompt 与 LLM 传输。
 */
const SHARED_CONSOLIDATE_SYSTEM = [
  '你是局域网共享记忆库的整理员。多台机器的 Agent 会把各自的记忆条目上传到这里。',
  '你的任务：把下面这批条目里**重复 / 近重复 / 过度琐碎**的合并，其余保持原样。',
  '规则：',
  '1. 不编造原文没有的信息；合并后的一句话要能独立看懂（不依赖别的条目）。',
  '2. 只合并确实同义的条目；不确定就不要合并 —— 少合并远好于错合并。',
  '3. 保留具体的路径、命令、约定、版本号；删掉「已解决」「已完成」这类一次性过程信息。',
  '4. 被合并掉的原始条目 id 全部列进 archive_memory_ids；没有被合并的条目不要出现在里面。',
  '只输出 JSON，不要 Markdown 包裹或额外说明。格式：',
  '{"memories":[{"content":"合并后的知识点（一行，<=200 字）","kind":"normal","scope":"global","importance":1-5}],',
  ' "archive_memory_ids":[1,2,3]}',
  '如果这批条目里没有任何值得合并的内容，输出 {"memories":[],"archive_memory_ids":[]}。'
].join('\n');

/**
 * 共享记忆提炼：抢锁 → 取候选 → 模型合并 → 落库 → 记录台账。
 *
 * 抢不到锁（别的机器正在提炼）或还在冷却期就**直接返回**，不排队、不重试 ——
 * 这是唯一需要的调度，不再有 master/slave 模式与「现在就提炼」的授权密码。
 */
async function runSharedMemoryConsolidation(ctx, trigger) {
  const sm = ctx.sharedMemory;
  if (!sm || typeof sm.claimConsolidation !== 'function' || !sm.active()) {
    return { ok: false, reason: 'inactive' };
  }
  const limits = ctx.limits() || {};
  const claim = await sm.claimConsolidation(trigger || 'scheduled', {
    // 冷却期的缺省值只在 agent-limits 里有一份，这里不再写死 6 小时
    minIntervalMs: Number(limits.sharedMemoryConsolidateIntervalMs)
  });
  if (!claim) return { ok: false, reason: 'locked_or_cooldown' };

  let scanned = 0;
  let model = '';
  try {
    const rows = await sm.listConsolidationCandidates(claim);
    scanned = rows.length;
    // 少于 3 条没有合并意义（本次仍记台账，冷却期从这里起算）
    if (rows.length < 3) {
      await sm.releaseConsolidation(claim, { scanned });
      return { ok: true, scanned, merged: 0, created: 0 };
    }
    const llm = resolveLlmCall(ctx, {}, limits);
    if (!llm) throw new Error('未配置可用的文本模型');
    model = llm.model;
    const lines = rows.map(
      (r) =>
        `- id=${r.id} · 重要度${Number(r.importance).toFixed(2)} · 被召回${r.accessCount}次 · ${compactPlain(r.content, 400)}`
    );
    const body = {
      model: llm.model,
      temperature: 0.2,
      max_tokens: Number(limits.knowledgeMaxTokens) || 2800,
      messages: [
        { role: 'system', content: SHARED_CONSOLIDATE_SYSTEM },
        {
          role: 'user',
          content: `以下是共享记忆库里的 ${rows.length} 条条目（来自局域网多台机器）：\n\n${lines.join('\n')}`
        }
      ]
    };
    const text = extractContent(await callLlm(llm, body, ctx.fetchChatCompletion, ctx.coreBridge));
    const parsed = parseKnowledgeJson(text);
    // 只允许归档「本次候选里出现过的 id」：模型编不出库里没有的行
    const known = new Set(rows.map((r) => String(r.id)));
    const mergedIds = (parsed.archive_memory_ids || []).filter((id) => known.has(String(id)));
    const created = (parsed.memories || []).filter((m) => m && m.content);
    const applied = await sm.applyConsolidation(claim, { mergedIds, created });
    // 落库失败必须走失败分支：否则台账会记成「按时完成、无错误」（finished_at 有值、error 为空），
    // 跨机冷却把这一轮当成成功，设置页也会显示成「这批没有可合并的」。
    if (!applied.ok) throw new Error(applied.error || '共享记忆落库失败');
    await sm.releaseConsolidation(claim, {
      scanned,
      merged: applied.marked,
      created: applied.inserted,
      model
    });
    return { ok: true, scanned, merged: applied.marked, created: applied.inserted };
  } catch (err) {
    const msg = (err && (err.message || String(err))) || 'unknown';
    await sm.releaseConsolidation(claim, { scanned, model, error: msg });
    console.warn('[dieyun:memory] shared memory consolidation failed:', msg);
    return { ok: false, error: msg };
  }
}

module.exports = { SHARED_CONSOLIDATE_SYSTEM, runSharedMemoryConsolidation };

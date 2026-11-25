'use strict';

/**
 * 归纳的「落库」这一段：记忆写入（全局 / 项目）、共享镜像、归档、AGENTS.md 更新，
 * 以及项目记忆文件（`.dieyun/memory.md`）的读写与物化。
 *
 * 为什么单独一个文件：它只跟「写到哪儿、写什么形状」有关，与调度、LLM 调用、提示词无关；
 * 此前和那几件事一起住在 1600 行的 `agent/knowledge-maintainer.js` 里。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续再导出被外部用到的名字。
 */

const { executeAgentsMdProposeMain } = require('../propose-tools-main');
const { compactPlain } = require('./signals');

// ---------------------------------------------------------------------------
// 写入（全部经 Gateway → Rust memory.*）
// ---------------------------------------------------------------------------

function formatMemoryRowsForPrompt(rows, label) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `【${label}】\n无`;
  const lines = list.slice(0, 28).map((r) => `- id=${r.id != null ? r.id : r.memoryId} · ${compactPlain(r.content || '', 220)}`);
  return `【${label}】\n${lines.join('\n')}`;
}

/**
 * 写用户级记忆：一次批量（`memory.long_add_many`），逐条结果按入参顺序返回。
 *
 * 为什么要批量：逐条 `memory.long_add` 等于每条付一次 embedding 端点往返，端点串行时
 * 一次归纳（最多 8 条）就独占它几分钟，把同队列里的每轮召回与代码检索全拖到超时
 * （见 docs/VECTOR-SEARCH.md §1.4）。
 *
 * 唯一的例外是**版本兼容**：core 还是旧的（应用没跟着重编）时没有这个方法，会回
 * `UNKNOWN_METHOD` —— 这时退回逐条写入，语义完全一样（同一套 Rust 写入政策），
 * 只是慢。这不是重试层：换的是「调哪个方法」，不是「同一件事再试一次」。
 *
 * `null` 表示那条没写成功（调用失败），由调用方决定怎么计数。
 */
async function writeGlobalMemories(ctx, items, opts) {
  const source = opts.source || 'auto_consolidation';
  const sessionId = opts.sessionId || undefined;
  const metadata = opts.metadata;
  const payload = items.map((item) => ({
    content: item.content,
    kind: item.kind,
    importance: item.importance,
    metadata
  }));
  try {
    const res = await ctx.invokeRpc('memory.long_add_many', {
      items: payload,
      source,
      // 走到这里的只可能是用户级：项目级已经进文件，库里不再有第二种 scope 写法
      scope: 'global',
      sessionId
    });
    const results = Array.isArray(res && res.results) ? res.results : [];
    return payload.map((_, i) => results[i] || null);
  } catch (err) {
    if (!err || err.code !== 'UNKNOWN_METHOD') throw err;
    console.warn('[dieyun:memory] dieyun-core 还不支持 memory.long_add_many（旧版核心），本次逐条写入');
    const out = [];
    for (const item of payload) {
      try {
        out.push(
          await ctx.invokeRpc('memory.long_add', { ...item, source, scope: 'global', sessionId })
        );
      } catch (e) {
        console.warn('[dieyun:memory] memory add failed:', e && (e.message || e));
        out.push(null);
      }
    }
    return out;
  }
}

async function applyMemoryItems(ctx, items, opts = {}) {
  const wsPath = String(opts.workspacePath || '').trim();
  const source = opts.source || 'auto_consolidation';
  const max = Number(opts.maxItems) || 8;
  // 写入溯源：任务级归纳知道自己是哪个会话；定时归纳跨会话，用 jobId 记账（不编造 sessionId）。
  const sessionId = String(opts.sessionId || '').trim();
  const metadata = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : undefined;
  let saved = 0;
  let merged = 0;
  let skipped = 0;
  /** 本轮真正落进用户级库的条目 → 归纳结束后镜像到共享库（跨机） */
  const shareable = [];
  /** 用户级条目：攒起来一次写（见下方 memory.long_add_many 的理由） */
  const globalItems = [];
  for (const item of (items || []).slice(0, max)) {
    // 落点只由 scope 决定（scope 已在 parseKnowledgeJson 归一成 project / global），
    // importance 只是排序权重，不参与选通道。
    // 曾写成 `|| importance >= 4`：于是「scope=global 的密钥条」被抢进项目文件，
    // 又被 filterEntriesForFile 按「文件会进版本库」丢弃 —— 库里和文件里都没有，
    // 静默丢记忆且只记一次 skipped。泄露边界是不变式，重要性不能改写它。
    const useProject = !!wsPath && item.scope === 'project';
    if (!useProject) {
      globalItems.push(item);
      continue;
    }
    try {
      // 项目记忆写文件（唯一真相）。用户级记忆走下面的一次批量写入。
      const fileRes = await appendProjectMemoryToFile(ctx, [item], wsPath);
      if (fileRes.added) saved += 1;
      else if (fileRes.duplicate) merged += 1;
      else skipped += 1;
    } catch (err) {
      console.warn('[dieyun:memory] memory add failed:', err && (err.message || err));
    }
  }
  // 用户级记忆一次写完（原因见 docs/VECTOR-SEARCH.md §1.4 + writeGlobalMemories）。
  if (globalItems.length) {
    let results = [];
    try {
      results = await writeGlobalMemories(ctx, globalItems, { source, sessionId, metadata });
    } catch (err) {
      console.warn('[dieyun:memory] memory add failed:', err && (err.message || err));
      results = [];
    }
    globalItems.forEach((item, i) => {
      const out = results[i];
      // 没有对应结论就不计数（等价于「这条没写成」）—— 不能默认算进 saved，
      // 否则批量接口少回一条就会在统计里变成「凭空多写了一条」。
      if (!out) return;
      if (out.skipped) skipped += 1;
      else if (out.duplicate) merged += 1;
      else saved += 1;
      // 上传的是「这轮新写进库的正文」，与本地库同一条：不额外记 id，靠 content_hash 幂等
      if (!out.skipped) {
        shareable.push({ content: item.content, kind: item.kind, importance: item.importance, source });
      }
    });
  }
  const shared = await mirrorShareable(ctx, shareable);
  return { saved, merged, skipped, shared };
}

/**
 * 把本机新写入的用户级记忆**镜像**到共享库（跨机）。
 *
 * 三条边界：
 * 1. 只上传「能离开本机」的条目 —— 判定复用 `project-memory-file.js#isShareableKind`
 *    （与写 `.dieyun/memory.md` 同一口径：secret / private 永不出本机）；
 * 2. 只上传用户级（global）记忆：项目记忆的真相是仓库文件，跨机共享会变成「别人的项目结论」；
 * 3. 失败只记日志：共享库挂掉不该影响本地记忆与归纳结果（fail-open）。
 */
async function mirrorShareable(ctx, items) {
  const list = Array.isArray(items) ? items : [];
  const sm = ctx.sharedMemory;
  if (!list.length) return { ok: true, uploaded: 0, skipped: 0 };
  if (!sm || typeof sm.mirrorItems !== 'function' || !sm.active()) {
    return { ok: false, reason: 'inactive', uploaded: 0, skipped: list.length };
  }
  const kept = list.filter((it) => projectMemoryFile.isShareableKind(it.kind));
  const dropped = list.length - kept.length;
  if (!kept.length) return { ok: true, uploaded: 0, skipped: dropped };
  try {
    const res = await sm.mirrorItems(kept, { scope: 'global' });
    return { ...res, skipped: (Number(res && res.skipped) || 0) + dropped };
  } catch (err) {
    console.warn('[dieyun:memory] shared memory upload failed:', err && (err.message || err));
    return { ok: false, error: err && (err.message || String(err)), uploaded: 0, skipped: dropped };
  }
}

async function applyArchiveMemoryIds(ctx, ids, knownMemoryIds) {
  let n = 0;
  for (const id of ids || []) {
    const memoryId = Number(id);
    if (!Number.isFinite(memoryId) || memoryId <= 0) continue;
    // 只允许归档「本次语料里出现过的 id」，模型编不出库里没有的行
    if (knownMemoryIds && knownMemoryIds.size && !knownMemoryIds.has(String(memoryId))) continue;
    try {
      await ctx.invokeRpc('memory.long_status_set', { memoryId, status: 'archived' });
      n += 1;
    } catch {
      // 归档失败不影响其余写入
    }
  }
  return n;
}

/**
 * AGENTS.md 更新 → 走 Main 侧既有 propose 通道（唯一实现，含 off / draft-only / 预览三态）。
 * 预览态会写 `.dieyun/agents-pending.json`，Renderer 已有读取路径。
 */
async function applyAgentsUpdates(ctx, updates, workspacePath, source) {
  const prefs = ctx.readAgentsMdPrefs();
  if (!workspacePath || prefs.mode === 'off' || !Array.isArray(updates) || !updates.length) {
    return { applied: 0 };
  }
  let applied = 0;
  let pending = false;
  let draft = false;
  for (const u of updates.slice(0, 6)) {
    const section = String(u.section || '').trim();
    const content = String(u.content || '').trim();
    if (!section || !content) continue;
    try {
      const res = await executeAgentsMdProposeMain(
        ctx.gateway,
        {
          section,
          action: String(u.action || 'append').trim() || 'append',
          anchor: u.anchor ? String(u.anchor).trim() : undefined,
          content,
          confidence: Number(u.confidence),
          reason: '',
          workspaceRoot: workspacePath
        },
        { workspacePath, sessionId: ctx.sessionId || '' },
        ctx.userData
      );
      if (res && res.error) continue;
      applied += Number(res && res.applied) || 0;
      pending = pending || !!(res && res.pending);
      draft = draft || !!(res && res.draft);
      if (res && (res.pending || res.draft)) break; // 预览/草稿只做一次，别叠多个待采纳项
    } catch (err) {
      console.warn('[dieyun:memory] agents.md update failed:', err && (err.message || err));
    }
  }
  return { applied, pending, draft, source };
}

// ---------------------------------------------------------------------------
// 语料收集（定时归纳：不依赖任何 Renderer 状态）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 项目记忆文件（唯一真相）读写
// ---------------------------------------------------------------------------

const projectMemoryFile = require('../project-memory-file');
const { projectWorkspacePath } = require('../../workspace/target');

/**
 * 文件 IO 归属哪个工作空间：归纳语料带 `payload.workspacePath` 时以它为准。
 *
 * 必须先剥 worktree 后缀（`projectWorkspacePath` 与项目记忆 scope 同一口径）：
 * 多 agent 并行时 payload 里可能是临时 worktree，写进去的 memory.md 会随 worktree 删除而丢，
 * 而项目记忆本来就该落在项目根（换会话、换 worktree 都读同一份）。
 */
function projectFileCtx(ctx, workspacePath) {
  const root = projectWorkspacePath(workspacePath || ctx.workspacePath || '');
  if (!root || root === ctx.workspacePath) return ctx;
  return Object.assign({}, ctx, { workspacePath: root });
}

async function readProjectMemoryText(ctx) {
  return readWorkspaceText(ctx, projectMemoryFile.PROJECT_MEMORY_REL_PATH, 96000);
}

async function writeProjectMemoryText(ctx, text) {
  await ctx.invokeRpc('fs.write_file', {
    filePath: projectMemoryFile.PROJECT_MEMORY_REL_PATH,
    data: String(text || ''),
    encoding: 'utf8',
    ...(ctx.workspacePath ? { runWorkspaceRoot: ctx.workspacePath } : {})
  });
}

/**
 * 把条目并进 `<workspace>/.dieyun/memory.md`。
 *
 * 项目记忆的写入终点就是这里：不再往 SQLite 里塞项目行 —— 库里写进去的项目记忆没人看得见、
 * 改不动、也删不掉。secret / private 一律丢弃（文件会进版本库）。
 */
async function appendProjectMemoryToFile(ctx, items, workspacePath) {
  const target = projectFileCtx(ctx, workspacePath);
  const { kept, dropped } = projectMemoryFile.filterEntriesForFile(items);
  if (!kept.length) return { added: 0, duplicate: 0, dropped };
  const before = await readProjectMemoryText(target);
  const existing = projectMemoryFile.parseProjectMemoryEntries(before);
  const beforeKeys = new Set(existing.map(projectMemoryFile.entryKey));
  const merged = projectMemoryFile.mergeProjectMemoryEntries(existing, kept);
  const fresh = kept.filter((e) => !beforeKeys.has(projectMemoryFile.entryKey(e))).length;
  if (fresh) {
    await writeProjectMemoryText(target, projectMemoryFile.renderProjectMemoryFile(merged));
  }
  return { added: fresh, duplicate: kept.length - fresh, dropped };
}

/**
 * 一次性材料化：旧版本把项目记忆写在 SQLite 里（注入只给 8 条，等于藏起来）。
 * 文件还不存在时，把库里高价值的项目行搬进文件 —— 之后注入只读文件，库里的行退化为
 * 「历史残留」，由内存衰减自然归档。
 */
async function materializeProjectMemoryFile(ctx, limits) {
  if (!ctx.workspacePath) return { seeded: 0 };
  const target = projectFileCtx(ctx);
  const existingText = await readProjectMemoryText(target);
  if (projectMemoryFile.parseProjectMemoryEntries(existingText).length) return { seeded: 0 };
  let rows = [];
  try {
    // 用「scope + 最近」而不是语义召回：材料化要的是这个项目历史上写过的全部条目，
    // 不是与某句话最像的几条（语义召回还需要 embedding，冷启动时常常直接返回空）。
    const scopeRes = await ctx.invokeRpc('memory.project_scope', { workspacePath: target.workspacePath });
    const scope = scopeRes && scopeRes.scope;
    if (scope) {
      const res = await ctx.invokeRpc('memory.long_recent', {
        limit: Math.max(40, Number(limits && limits.knowledgeCorpusMemoryRows) || 24),
        scope
      });
      rows = Array.isArray(res) ? res : (res && res.results) || [];
    }
  } catch {
    rows = [];
  }
  const items = rows
    .filter((r) => String((r && r.kind) || 'normal').toLowerCase() === 'normal')
    .filter((r) => Number((r && r.importance) || 3) >= 3)
    .map((r) => ({ content: r.content, kind: r.kind }));
  if (!items.length) return { seeded: 0 };
  const res = await appendProjectMemoryToFile(ctx, items, target.workspacePath);
  return { seeded: res.added };
}

async function readWorkspaceText(ctx, relPath, maxBytes) {
  try {
    const r = await ctx.invokeRpc('fs.read_file', {
      filePath: relPath,
      encoding: 'utf8',
      maxBytes: Number(maxBytes) || 96000,
      ...(ctx.workspacePath ? { runWorkspaceRoot: ctx.workspacePath } : {})
    });
    if (!r || r.encoding === 'base64') return '';
    return String(r.data || '');
  } catch {
    return '';
  }
}

module.exports = {
  formatMemoryRowsForPrompt,
  writeGlobalMemories,
  applyMemoryItems,
  mirrorShareable,
  applyArchiveMemoryIds,
  applyAgentsUpdates,
  projectFileCtx,
  readProjectMemoryText,
  writeProjectMemoryText,
  appendProjectMemoryToFile,
  materializeProjectMemoryFile,
  readWorkspaceText
};

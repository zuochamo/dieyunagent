'use strict';

const { bindSessionWorkspace, isReusableSessionRow } = require('../agent/session-workspace-bind');

/**
 * 计划会话的工作空间绑定。
 *
 * 定时执行没有 Renderer 会话，工具调用的工作区只能由计划自己带：
 * 计划的 `workspace`（本地目录 / ssh:// 远端）必须同时落到会话行与进程内会话上下文 ——
 * 绑定实现本身是 `agent/session-workspace-bind.js` 的单一来源（频道运行也用它）。
 *
 * 「还能不能往里写」的判据同样在那边（`isReusableSessionRow`）：计划 / 心跳 / 频道三处
 * 以前各写一份，频道那份还漏了 `archived`。
 */

/**
 * 为定时计划绑定专用会话；若已有有效且未归档的 sessionId 则复用。
 *
 * 「失效」只有两个来源，判据在 `isReusableSessionRow` 一处：
 *   1. 会话被删除；
 *   2. 会话被用户归档 —— 归档是用户的决定（这里不去改那个位），但继续往里写就等于
 *      把报告丢进侧栏翻不到的地方：侧栏只拉 `archived = 0`（`renderer-chat-history`），
 *      界面也没有「已归档」入口。表现就是「计划天天弹完成通知，却一直没有会话」。
 *      与生命感心跳会话同口径（见 `main/alive-boot.js#ensureSession` 的注释与实测）。
 * 两种情况都另开一条会话，并把新 id 写回 `deliver`。
 *
 * **读取失败不是第三种失效**：`memory.session_get` 抛错（传输 / SQLite busy / core 未就绪）
 * 原样上抛，由调用方下一轮重试 —— 否则一次抖动就会把计划永久迁到新会话。
 *
 * 重建**不静默**：`rebuilt` / `staleSessionId` / `staleArchived` 一起返回，交由调用方
 * 记日志或提示 —— 否则报告会落到一条用户根本没在看的会话里。
 *
 * @returns {Promise<{ plan: object, sessionId: string, rebuilt: boolean, staleSessionId: string, staleArchived: boolean }>}
 */
async function ensurePlanSession(gateway, plansStore, plan) {
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪，无法绑定计划会话');
  }
  if (!plan || !plan.id) throw new Error('计划无效');
  if (!plansStore) throw new Error('计划存储未就绪');

  const planWorkspace = String(plan.workspace || '').trim();
  let sessionId = plan.deliver && plan.deliver.sessionId ? String(plan.deliver.sessionId).trim() : '';
  const staleSessionId = sessionId;
  let staleArchived = false;
  let rebuilt = false;
  if (sessionId) {
    /**
     * 读失败**不等于**会话不存在：`memory.session_get` 对「查不到」返回 null，
     * 对传输错误 / SQLite busy / core 未就绪是**抛错**。
     *
     * 以前这里 `catch {}` 把两者都当成「已删除」，然后重建并把新 id 覆盖进 `deliver` ——
     * 一次瞬时抖动就永久换掉计划会话：旧会话里的前半段报告成了孤儿，无人值守时还会
     * 堆出多条 `[计划] X`。所以这里不兜底：异常原样上抛，由调用方下一轮重试
     * （形状照 `main/alive-boot.js#ensureSession`，那边也没有 catch）。
     */
    const row = await gateway.invokeRpc('memory.session_get', { sessionId });
    if (isReusableSessionRow(row)) {
      // 计划改过工作空间（或旧会话还没绑）：这次运行前同步，避免「编辑了目录却还跑在旧目录」
      if (planWorkspace && String(row.workspacePath || '').trim() !== planWorkspace) {
        await bindSessionWorkspace(gateway, row.id, planWorkspace);
      }
      return {
        plan: plansStore.get(plan.id) || plan,
        sessionId: row.id,
        rebuilt: false,
        staleSessionId: '',
        staleArchived: false
      };
    }
    // 走到这里只有两种：row 为 null（会话已被删除）或 row 存在但被归档
    staleArchived = !!(row && row.id);
    rebuilt = true;
  }

  const created = await gateway.invokeRpc('memory.session_create', {
    title: `[计划] ${plan.name || '未命名计划'}`,
    workspacePath: planWorkspace || null
  });
  if (!created || !created.id) throw new Error('创建计划专用会话失败');
  sessionId = created.id;
  if (planWorkspace) await bindSessionWorkspace(gateway, sessionId, planWorkspace);

  const bound = plansStore.upsert({
    ...plan,
    deliver: {
      type: 'session',
      sessionId
    }
  });
  return { plan: bound, sessionId, rebuilt, staleSessionId: rebuilt ? staleSessionId : '', staleArchived };
}

module.exports = { ensurePlanSession };

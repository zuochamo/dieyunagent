'use strict';

/**
 * 回归：**迟到的批准**（用户离开超过 2 分钟才点「允许」）。
 *
 * 以前的 bug：`ask()` 超时后请求被删掉，界面再点「允许」→ Main 返回 false → 界面什么都不显示，
 * 用户看到的是「点了没反应」，AI 那头只收到「被拒绝」。现在分两层保证：
 * 1. `sandbox-approvals.resolveLater()` 在 `ask()` 超时之后仍然把批准记进本会话的 grant；
 * 2. `renderer-tool-delegate.completeSandboxApproval()` 返回 `delivered`，界面据此给出反馈。
 *
 * 不重放工具调用是刻意的：`rm` 跑两次会出事，所以迟到批准只落 grant，下一轮由模型自己重发。
 *
 *   node scripts/test-sandbox-approvals-late.cjs
 */

const assert = require('assert');
const { createSandboxApprovals } = require('../src/gateway/sandbox-approvals');
const {
  requestSandboxApproval,
  completeSandboxApproval,
  setLateSandboxApprovalHandler
} = require('../src/agent/renderer-tool-delegate');

const OUT_FILE = 'C:\\work\\out\\a.txt';
const OUT_DIR = 'C:\\work\\out';

function decision() {
  return {
    action: 'ask',
    mode: 'workspace-write',
    category: 'write',
    reason: '写入工作区外的路径',
    detail: OUT_FILE
  };
}

/** 一个永远不回话的审批通道 = 人去开会了。 */
function neverAnsweringApprovals(opts = {}) {
  const asks = [];
  let clock = 1000;
  const approvals = createSandboxApprovals({
    request: (payload) => {
      asks.push(payload);
      return new Promise(() => {});
    },
    timeoutMs: opts.timeoutMs || 20,
    grantTtlMs: opts.grantTtlMs || 60_000,
    now: () => clock,
    log: () => {}
  });
  return { approvals, asks, tick: (ms) => (clock += ms) };
}

async function testTimeoutThenLateGrant() {
  const { approvals, asks } = neverAnsweringApprovals();

  const first = await approvals.ask(decision(), { sessionId: 's1', path: OUT_FILE, tool: 'fs_write_file' });
  assert.strictEqual(first.granted, false, '超时必须是拒绝（fail-closed）');
  assert.strictEqual(first.expired, true, '超时要把 expired 报出来');
  assert.strictEqual(asks.length, 1, '越界写要问一次');
  assert.strictEqual(asks[0].path, OUT_FILE, 'payload 必须带路径，否则迟到批准只能退化成类别级授权');

  const requestId = asks[0].requestId;
  assert.ok(requestId, 'payload 必须带 requestId');

  // 20 分钟后回来点「允许」。
  const late = approvals.resolveLater(requestId, true);
  assert.strictEqual(late.ok, true, '迟到批准要成功');
  assert.strictEqual(late.granted, true, '迟到批准要落成 grant');
  assert.strictEqual(late.sessionId, 's1', 'grant 要落到原来的会话');
  assert.strictEqual(late.category, 'write', 'grant 要带类别');
  assert.strictEqual(late.scope, OUT_DIR, 'grant 粒度是目录，不是类别');
  assert.strictEqual(approvals.grantedFor('s1', 'write', OUT_DIR), true, 'grant 记忆生效');
  assert.ok(approvals.grantedPathsFor('s1').includes(OUT_DIR), '目录要并入写白名单');

  // 下一轮模型重发同一条命令：不该再问。
  const second = await approvals.ask(decision(), { sessionId: 's1', path: OUT_FILE, tool: 'fs_write_file' });
  assert.strictEqual(second.granted, true, 'grant 命中要直接放行');
  assert.strictEqual(asks.length, 1, 'grant 命中不能再问一次');
}

async function testUnknownRequestId() {
  const { approvals } = neverAnsweringApprovals();
  const r = approvals.resolveLater('sbx-不存在', true);
  assert.strictEqual(r.ok, false, '找不到的请求不能假装成功');
  assert.strictEqual(r.expired, true, '要明确告诉界面「已过期」');
  assert.ok(String(r.reason || '').length > 0, '要给用户一句能看懂的原因');
}

async function testLateDeclineDoesNotGrant() {
  const { approvals, asks } = neverAnsweringApprovals();
  await approvals.ask(decision(), { sessionId: 's2', path: OUT_FILE });
  const late = approvals.resolveLater(asks[0].requestId, false);
  assert.strictEqual(late.ok, true, '迟到拒绝也算已处理');
  assert.strictEqual(late.granted, false, '拒绝不能落 grant');
  assert.strictEqual(approvals.grantedFor('s2', 'write', OUT_DIR), false, '拒绝之后仍要问');

  await approvals.ask(decision(), { sessionId: 's2', path: OUT_FILE });
  assert.strictEqual(asks.length, 2, '拒绝之后同类操作要重新问');
}

async function testExpiredRequest() {
  const { approvals, asks, tick } = neverAnsweringApprovals({ grantTtlMs: 5_000 });
  await approvals.ask(decision(), { sessionId: 's3', path: OUT_FILE });
  tick(6_000);
  const late = approvals.resolveLater(asks[0].requestId, true);
  assert.strictEqual(late.ok, false, '超过批准寿命的按钮不能再算数');
  assert.strictEqual(late.expired, true, '要报 expired');
  assert.strictEqual(approvals.grantedFor('s3', 'write', OUT_DIR), false, '过期之后不能留下 grant');
}

async function testDelegateLivePath() {
  const sent = [];
  const fakeWebContents = { isDestroyed: () => false, send: (ch, payload) => sent.push({ ch, payload }) };

  const waiting = requestSandboxApproval(fakeWebContents, { requestId: 'sbx-live-1', category: 'write' }, 5_000);
  assert.strictEqual(sent.length, 1, '要向界面发一次弹窗');
  assert.strictEqual(sent[0].ch, 'agent:sandbox-approval', '事件名要对');

  const res = completeSandboxApproval('sbx-live-1', { granted: true });
  assert.strictEqual(res.delivered, 'live', '还在等回包的请求走 live');
  assert.strictEqual(res.ok, true, 'live 回包必须成功');

  const settled = await waiting;
  assert.strictEqual(settled.granted, true, '决定要传给等待中的工具调用');
}

async function testDelegateLatePath() {
  const { approvals, asks } = neverAnsweringApprovals();
  await approvals.ask(decision(), { sessionId: 's4', path: OUT_FILE });
  const requestId = asks[0].requestId;

  setLateSandboxApprovalHandler(null);
  const none = completeSandboxApproval(requestId, { granted: true });
  assert.strictEqual(none.ok, false, '没有通道时不能假装成功');
  assert.strictEqual(none.delivered, 'none', '要报 none');
  assert.strictEqual(none.expired, true, '要报 expired，界面才能提示用户');

  setLateSandboxApprovalHandler((id, d) => approvals.resolveLater(id, d && d.granted === true));
  const late = completeSandboxApproval(requestId, { granted: true });
  assert.strictEqual(late.ok, true, '有通道时迟到批准要成功');
  assert.strictEqual(late.delivered, 'late', '要报 late，界面才会提示「已记住」');
  assert.strictEqual(late.granted, true, 'granted 要回给界面');
  assert.strictEqual(approvals.grantedFor('s4', 'write', OUT_DIR), true, '迟到批准要落到同一个 grant 存储');

  setLateSandboxApprovalHandler(null);
}

(async () => {
  const cases = [
    ['超时后迟到批准 → 落 grant 并放行下次', testTimeoutThenLateGrant],
    ['未知 requestId → 明确报过期', testUnknownRequestId],
    ['迟到拒绝 → 不落 grant', testLateDeclineDoesNotGrant],
    ['超过批准寿命 → 不算数', testExpiredRequest],
    ['delegate live 路径不受影响', testDelegateLivePath],
    ['delegate 迟到路径有反馈', testDelegateLatePath]
  ];
  for (const [name, fn] of cases) {
    await fn();
    console.log(`  ok  ${name}`);
  }
  console.log('test-sandbox-approvals-late: 全部通过');
})().catch((e) => {
  console.error('test-sandbox-approvals-late 失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});

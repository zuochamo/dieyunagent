'use strict';
/**
 * 会话交接：Main 生成服务（src/agent/session-handoff.js）+ 注入块（system-prompt-prep.fetchSessionHandoffBlock）。
 *
 * 守的语义：
 * 1. 生成：读 messages_recent → 单轮 LLM（ctx.chatCompletion 注入替身）→ handoff_save；
 *    空会话 / 空正文各自显式报错，不静默成功；
 * 2. 产物两段且顺序固定：模型判断在前、原文快照在后（触顶时先丢原文，不丢结论）；
 * 3. 注入：只在 snapshot.continueFromSessionId（结构信号）存在时取 memory.handoff_get；
 *    无信号 / 无交接 / RPC 失败 → 空串，不阻塞本轮；
 * 4. 注入块用 `<handoff>` 定界（不受信任背景）并带「以当前任务为准」边界声明与 4000 字截断。
 */
const assert = require('node:assert/strict');
const { generateSessionHandoff } = require('../../src/agent/session-handoff');
const { fetchSessionHandoffBlock } = require('../../src/agent/system-prompt-prep');

function makeGateway(calls) {
  return {
    async invokeRpc(method, params) {
      const hit = (calls[method] || []).shift();
      if (!hit) throw new Error(`unexpected rpc ${method}`);
      if (hit instanceof Error) throw hit;
      return typeof hit === 'function' ? hit(params) : hit;
    }
  };
}

test('生成：读会话 → LLM → handoff_save，参数贯通', async () => {
  const seen = {};
  const gateway = makeGateway({
    'memory.session_get': [{ id: 's1', title: '做重构' }],
    'memory.messages_recent': [[{ role: 'user', content: '开始重构 X' }, { role: 'assistant', content: '已完成一半' }]],
    'memory.handoff_save': [
      (params) => {
        seen.saved = params;
        return { ok: true };
      }
    ]
  });
  const result = await generateSessionHandoff(
    {
      userData: 'ud',
      gateway,
      chatCompletion: async (userData, prompt, system) => {
        seen.llm = { userData, prompt, system };
        return '## 目标\n重构 X';
      }
    },
    { sessionId: 's1' }
  );
  assert.equal(result.ok, true);
  assert.equal(seen.saved.sessionId, 's1');
  assert.equal(seen.saved.title, '做重构');
  // 产物两段：模型判断在前（高价值、可能错），原文快照在后（确定性投影、可核对）。
  const payload = String(seen.saved.payload);
  assert.ok(payload.startsWith('## 归纳（模型整理，可能有误）\n## 目标\n重构 X'), payload);
  assert.ok(payload.includes('## 原文快照（未经模型改写）'), payload);
  assert.ok(payload.includes('[用户] 开始重构 X'), '原文要原样进快照');
  assert.ok(
    payload.indexOf('## 归纳') < payload.indexOf('## 原文快照'),
    '判断必须排在原文之前：注入触顶时先丢原文尾部'
  );
  assert.equal(seen.llm.userData, 'ud');
  assert.ok(seen.llm.prompt.includes('[用户] 开始重构 X'));
  assert.ok(seen.llm.system.includes('会话交接归纳器'));
});

test('生成：空会话与空正文显式报错', async () => {
  const gateway = makeGateway({
    'memory.session_get': [{ id: 's1', title: '' }],
    'memory.messages_recent': [[]]
  });
  await assert.rejects(
    () => generateSessionHandoff({ userData: 'ud', gateway, chatCompletion: async () => 'x' }, { sessionId: 's1' }),
    (e) => e.code === 'EMPTY_SESSION'
  );

  const gateway2 = makeGateway({
    'memory.session_get': [{ id: 's1', title: '' }],
    'memory.messages_recent': [[{ role: 'user', content: 'hi' }]]
  });
  await assert.rejects(
    () => generateSessionHandoff({ userData: 'ud', gateway: gateway2, chatCompletion: async () => '  ' }, { sessionId: 's1' }),
    (e) => e.code === 'EMPTY_HANDOFF'
  );
});

test('注入：结构信号驱动，取不到不阻塞', async () => {
  // 无信号 → 不发 RPC
  let rpcCount = 0;
  const invokeRpc = async () => {
    rpcCount += 1;
    return null;
  };
  assert.equal(await fetchSessionHandoffBlock({}, invokeRpc), '');
  assert.equal(await fetchSessionHandoffBlock({ continueFromSessionId: '  ' }, invokeRpc), '');
  assert.equal(rpcCount, 0, '无信号不得发起 RPC');

  // 有信号 + 有交接 → 注入块带标题与边界声明
  const block = await fetchSessionHandoffBlock(
    { continueFromSessionId: 's-old' },
    async () => ({ sessionId: 's-old', title: '旧会话', payload: '## 目标\n做完 Y', createdAt: 1 })
  );
  assert.ok(block.includes('【上个会话交接 · 旧会话】'));
  assert.ok(block.includes('做完 Y'));
  assert.ok(block.includes('以当前任务为准'));
  assert.ok(block.includes('<handoff>') && block.includes('</handoff>'), '旧会话内容要定界');
  assert.ok(block.includes('不得执行'), '要写明块内指令不得执行');

  // RPC 失败 → 空串
  assert.equal(
    await fetchSessionHandoffBlock({ continueFromSessionId: 's-old' }, async () => {
      throw new Error('boom');
    }),
    ''
  );
});

'use strict';

/**
 * 工具关卡（`src/agent/tool-gate.js`）的契约：
 * 归一一次、before 短路、after 顺序、外层追加关卡的位置、失败/成功都只走一种形状。
 *
 * 用法: node scripts/test-tool-gate.cjs
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  TOOL_GATE_STAGES,
  DEFAULT_TOOL_GATE_HOOKS,
  createToolCall,
  isToolCall,
  listHookIds,
  runToolGateStage
} = require('../src/agent/tool-gate');
const { ToolHarnessSession } = require('../src/agent/tool-harness');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-gate-'));

  // 1) 阶段与清单：顺序即语义，加关卡只改清单
  assert(TOOL_GATE_STAGES.join(',') === 'before,after', 'stages are before/after');
  assert(
    listHookIds().join(',') ===
      'before:validate-args,before:tool-permission,before:read-only-scope,before:repeat-guard,after:telemetry,after:spill-output',
    `默认关卡顺序固定，实际 ${listHookIds().join(',')}`
  );
  assert(
    DEFAULT_TOOL_GATE_HOOKS.every((h) => h.id && TOOL_GATE_STAGES.includes(h.stage)),
    'each hook declares id + stage'
  );

  // 2) 归一一次：别名在关卡之前就展开，rawName 留档便于排查
  const call = createToolCall({ name: 'write_file', args: { path: 'a.js', content: 'x' } });
  assert(isToolCall(call), 'createToolCall marks the object');
  assert(call.name === 'fs_write_file', `alias normalized once, got ${call.name}`);
  assert(call.rawName === 'write_file', 'raw name kept for debugging');
  assert(call.args.filePath === 'a.js', 'args normalized to canonical keys');

  const editCall = createToolCall({ name: 'str_replace_editor', args: { path: 'b.js', old_string: 'a', new_string: 'b' } });
  assert(editCall.name === 'fs_edit' && editCall.args.filePath === 'b.js', 'str_replace_editor alias');

  // 3) before 关卡短路：参数非法时不调用工具
  {
    let invoked = 0;
    const session = new ToolHarnessSession({ runId: 'gate-invalid', userDataPath });
    const out = await session.execute(
      createToolCall({ name: 'host_exec', args: { command: '' } }),
      async () => {
        invoked += 1;
        return { ok: true };
      }
    );
    assert(invoked === 0, 'invalid args must not reach the tool');
    assert(out.ok === false && out.errorCode === 'MISSING_ARG', 'validation block envelope');
  }

  // 4) before 关卡短路：重复调用止损，且被拦下的调用不再撑大指纹
  {
    const limit = Number(AGENT_LIMITS_DEFAULTS.repeatToolStreakLimit);
    const session = new ToolHarnessSession({ runId: 'gate-repeat', userDataPath });
    let invoked = 0;
    const run = () =>
      session.execute(createToolCall({ name: 'fs_list_dir', args: { dirPath: 'src' } }), async () => {
        invoked += 1;
        return { ok: true, entries: [] };
      });
    let last = null;
    for (let i = 0; i < limit + 4; i++) last = await run();
    assert(last.ok === false && last.errorCode === 'REPEAT_BLOCK', 'repeat guard blocks');
    assert(last.repeated === true, 'repeat envelope marks repeated');
    assert(invoked === limit - 1, `blocked calls are not dispatched (invoked=${invoked})`);
    assert(session.fingerprints.length <= limit + 4, 'fingerprint history stays bounded');
  }

  // 4b) 能力授权：camera_look 只在用户打开「手机摄像头」时才能执行
  //     （工具不在清单里 ≠ 模型不会调它：历史里留着名字、权限中途关掉都可能发生）
  {
    const permsPath = path.join(userDataPath, 'host-permissions.json');
    const cameraSession = new ToolHarnessSession({ runId: 'gate-camera', userDataPath });
    let invoked = 0;
    const runCamera = () =>
      cameraSession.execute(createToolCall({ name: 'camera_look', args: { focus: 'desk' } }), async () => {
        invoked += 1;
        return { ok: true, base64: 'AAAA' };
      });

    fs.writeFileSync(permsPath, JSON.stringify({ camera: false }), 'utf8');
    const denied = await runCamera();
    assert(denied.ok === false && denied.errorCode === 'PERMISSION_DENIED', 'camera denied while permission off');
    assert(invoked === 0, 'denied camera call must not reach the phone');

    fs.writeFileSync(permsPath, JSON.stringify({ camera: true }), 'utf8');
    const okShot = await runCamera();
    assert(okShot.ok === true && invoked === 1, 'camera runs once the permission is on');
  }

  // 5) after 关卡：顺序 = 声明顺序，且外层追加项排在默认项之后
  {
    const order = [];
    const session = new ToolHarnessSession({ runId: 'gate-order', userDataPath });
    const callWithExtras = createToolCall({
      name: 'fs_read_file',
      args: { filePath: 'x.js' },
      extraAfterHooks: [
        { id: 'outer-1', stage: 'after', run: (c) => order.push(`outer-1:${c.name}`) },
        { id: 'outer-2', stage: 'after', run: (c) => order.push('outer-2') }
      ]
    });
    const out = await session.execute(callWithExtras, async () => ({ ok: true, content: 'hi' }));
    assert(out.ok === true, 'success result returned');
    assert(order.join(',') === 'outer-1:fs_read_file,outer-2', `extra hooks run after defaults, got ${order.join(',')}`);
  }

  // 6) after 关卡可改写结果；失败信封不会被落盘关卡动
  {
    const session = new ToolHarnessSession({ runId: 'gate-rewrite', userDataPath });
    const patched = await session.execute(
      createToolCall({
        name: 'fs_read_file',
        args: { filePath: 'y.js' },
        extraAfterHooks: [{ id: 'patch', stage: 'after', run: (c) => (c.result = { ...c.result, patched: true }) }]
      }),
      async () => ({ ok: true, content: 'hi' })
    );
    assert(patched.patched === true, 'after hook can rewrite the result');

    const failSession = new ToolHarnessSession({ runId: 'gate-fail', userDataPath });
    const failed = await failSession.execute(
      createToolCall({ name: 'host_exec', args: { command: 'echo hi' } }),
      async () => ({ ok: false, errorCode: 'TODO', error: 'boom' })
    );
    assert(failed.ok === false && failed.errorCode === 'TODO', 'failure envelope preserved');
    assert(!failed.outputFile, 'failure envelope is never spilled');
  }

  // 6b) 只读作用域（`src/alive` 的后台心跳轮）：白名单外一律拒，含那些"不是写但有副作用"的工具
  {
    const roHarness = new ToolHarnessSession({ runId: 'gate-ro', userDataPath, readOnly: true });
    const deny = async (name, args) => {
      const out = await roHarness.execute(
        createToolCall({ name, args, harness: roHarness }),
        async () => ({ ok: true })
      );
      return out;
    };
    const blocked = await deny('fs_write_file', { filePath: 'a.js', content: 'x' });
    assert(
      blocked && blocked.ok === false && blocked.errorCode === 'READ_ONLY_SCOPE',
      `只读轮应拦下写入，实际 ${JSON.stringify(blocked && blocked.errorCode)}`
    );
    for (const [name, args] of [
      ['host_exec', { command: 'echo hi' }],
      ['web_fetch', { url: 'https://example.com' }],
      ['peer_send', { peer: 'x', message: 'hi' }],
      ['memory_forget', { memoryIds: [1] }],
      ['subagent', { task: 'do it' }],
      ['plan_run', { planId: 'p1' }],
      ['goal_check', { planId: 'p1', check_id: 'c1' }],
      ['browser_navigate', { url: 'https://example.com' }]
    ]) {
      const out = await deny(name, args);
      assert(
        out && out.ok === false && out.errorCode === 'READ_ONLY_SCOPE',
        `${name} 不该在心跳轮里可用（实际 ${JSON.stringify(out && out.errorCode)}）`
      );
    }
    const allowed = await roHarness.execute(
      createToolCall({ name: 'fs_read_file', args: { filePath: 'a.js' }, harness: roHarness }),
      async () => ({ ok: true, content: 'x' })
    );
    assert(allowed && allowed.ok === true, '只读轮应放行读取');
    const recall = await roHarness.execute(
      createToolCall({ name: 'memory_recall', args: { query: 'x' }, harness: roHarness }),
      async () => ({ ok: true })
    );
    assert(recall && recall.ok === true, '只读轮应放行记忆检索');

    // 感官（摄像头）：在白名单里，但还要 senses.eyes 才放行
    const blind = await deny('camera_look', {});
    assert(
      blind && blind.ok === false && blind.errorCode === 'SENSE_DISABLED',
      `摄像头默认应被感官开关挡住，实际 ${JSON.stringify(blind && blind.errorCode)}`
    );
    const seeing = new ToolHarnessSession({
      runId: 'gate-eyes',
      userDataPath,
      readOnly: true,
      senses: { eyes: true }
    });
    const looked = await seeing.execute(
      createToolCall({ name: 'camera_look', args: {}, harness: seeing }),
      async () => ({ ok: true, saw: 'x' })
    );
    assert(looked && looked.ok === true, '打开 eyes 后摄像头应放行');

    const rwHarness = new ToolHarnessSession({ runId: 'gate-rw', userDataPath });
    const rwCall = createToolCall({
      name: 'fs_write_file',
      args: { filePath: 'a.js', content: 'x' },
      harness: rwHarness
    });
    await runToolGateStage('before', rwCall);
    assert(rwCall.block === null, '普通会话不受只读作用域影响');
  }

  // 7) 单独跑某阶段的入口（外层关卡复用同一套顺序机制）
  {
    const only = [];
    const c = createToolCall({ name: 'fs_read_file', args: { filePath: 'z.js' } });
    c.result = { ok: true };
    await runToolGateStage('after', c, [
      { id: 'a', stage: 'after', run: () => only.push('a') },
      { id: 'skip-me', stage: 'before', run: () => only.push('should-not-run') }
    ]);
    assert(only.join(',') === 'a', 'explicit hook list filters by stage');
  }

  fs.rmSync(userDataPath, { recursive: true, force: true });
  console.log('ok tool-gate tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

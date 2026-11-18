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

  // 4c) 心跳轮的三档权力：清单换成另一套许可，且越界/超次/需审批一律拒
  //     （`readOnly` 只表达"能不能改"，档位、根目录、每轮次数是另外三件事）
  {
    const root = userDataPath;
    const make = (name, args, extra = {}) => {
      const c = createToolCall({ name, args });
      c.harness = {
        ctx: { sessionId: 's-wake', userDataPath, workspacePath: '', wakeRoot: root, ...extra }
      };
      return c;
    };
    const gate = (c) => runToolGateStage('before', c, DEFAULT_TOOL_GATE_HOOKS);

    // 只读档：改文件/跑命令/出网都拦
    {
      const write = make('fs_write_file', { filePath: path.join(root, 'a.txt'), content: 'x' }, { readOnly: true, wakePower: 'read' });
      await gate(write);
      assert(write.block && write.block.errorCode === 'READ_ONLY_SCOPE', 'read 档不许改文件');
      const exec = make('host_exec', { command: 'echo hi' }, { readOnly: true, wakePower: 'read' });
      await gate(exec);
      assert(exec.block && exec.block.errorCode === 'READ_ONLY_SCOPE', 'read 档不许跑命令');
      const web = make('web_fetch', { url: 'https://example.com' }, { readOnly: true, wakePower: 'read' });
      await gate(web);
      assert(web.block && web.block.errorCode === 'READ_ONLY_SCOPE', 'read 档不许出网');
      const browse = make('browser_navigate', { url: 'https://example.com' }, { readOnly: true, wakePower: 'read' });
      await gate(browse);
      assert(browse.block && browse.block.errorCode === 'READ_ONLY_SCOPE', 'read 档不许开浏览器');
    }

    // write 档：根目录内可写（并扣一次预算）；根外拒；超次拒；仍不许跑命令
    {
      const budget = { writes: 0, execs: 0, maxWrites: 2, maxExecs: 1 };
      const inside = make('fs_write_file', { filePath: path.join(root, 'sub', 'a.txt'), content: 'x' }, { wakePower: 'write', wakeBudget: budget });
      await gate(inside);
      assert(!inside.block, `根目录内应当放行：${inside.block && inside.block.errorCode}`);
      assert(budget.writes === 1, '放行后要扣一次写预算');

      const outside = make('fs_write_file', { filePath: path.join(path.dirname(root), 'evil.txt'), content: 'x' }, { wakePower: 'write', wakeBudget: budget });
      await gate(outside);
      assert(outside.block && outside.block.errorCode === 'WAKE_PATH_OUTSIDE', '根目录外必须拒');

      // 根内合法文件名不能因为以 `..` 开头被误判越界（`path.relative` 前缀比较的老坑）
      const dotted = make('fs_write_file', { filePath: path.join(root, '..eslintrc'), content: 'x' }, { wakePower: 'write', wakeBudget: budget });
      await gate(dotted);
      assert(!dotted.block, `根内以 .. 开头的合法文件名应当放行：${dotted.block && dotted.block.errorCode}`);

      // 没有声明可动的根时**必须 fail-closed**：绝不回退到 process.cwd()（应用安装目录）
      const noRoot = make('fs_write_file', { filePath: path.join(root, 'c.txt'), content: 'x' }, { wakePower: 'write', wakeBudget: budget, wakeRoot: '' });
      await gate(noRoot);
      assert(noRoot.block && noRoot.block.errorCode === 'WAKE_NO_ROOT', '没有根目录必须拒（不许用 cwd 兜底）');
      const noRootExec = make('host_exec', { command: 'echo hi' }, { wakePower: 'exec', wakeBudget: budget, wakeRoot: '' });
      await gate(noRootExec);
      assert(noRootExec.block && noRootExec.block.errorCode === 'WAKE_NO_ROOT', 'exec 档同样不许用 cwd 兜底');

      budget.writes = 2;
      const overBudget = make('fs_write_file', { filePath: path.join(root, 'b.txt'), content: 'y' }, { wakePower: 'write', wakeBudget: budget });
      await gate(overBudget);
      assert(overBudget.block && overBudget.block.errorCode === 'WAKE_BUDGET', '超次必须拒');

      const exec = make('host_exec', { command: 'echo hi' }, { wakePower: 'write', wakeBudget: budget });
      await gate(exec);
      assert(exec.block && exec.block.errorCode === 'READ_ONLY_SCOPE', 'write 档仍不许跑命令');
      const web = make('web_search', { query: 'x' }, { wakePower: 'write', wakeBudget: budget });
      await gate(web);
      assert(web.block && web.block.errorCode === 'READ_ONLY_SCOPE', 'write 档仍不许出网（出网跟着 exec 档走）');
    }

    // exec 档：根目录内良性命令放行；高危拒；需审批拒（后台不排队）；cwd 越界拒
    {
      const budget = { writes: 0, execs: 0, maxWrites: 1, maxExecs: 1 };
      const okCmd = make('host_exec', { command: 'echo hello' }, { wakePower: 'exec', wakeBudget: budget });
      await gate(okCmd);
      assert(!okCmd.block, `良性命令应当放行：${okCmd.block && okCmd.block.errorCode}`);
      assert(budget.execs === 1, '放行后要扣一次执行预算');

      const budget2 = { writes: 0, execs: 0, maxWrites: 1, maxExecs: 1 };
      const danger = make('host_exec', { command: 'diskpart /s x.txt' }, { wakePower: 'exec', wakeBudget: budget2 });
      await gate(danger);
      assert(danger.block, '高危命令必须被拦（哪一道关卡拦都行，拦下来才算）');

      // 需要人当场同意的写操作（工作区之外）：后台直接拒，绝不排队等审批
      const needAsk = make('host_exec', { command: 'del ..\\x.txt' }, { wakePower: 'exec', wakeBudget: budget2 });
      await gate(needAsk);
      assert(
        needAsk.block && needAsk.block.errorCode === 'WAKE_NEEDS_APPROVAL',
        `需要审批的操作必须直接拒：${needAsk.block && needAsk.block.errorCode}`
      );

      const badCwd = make('host_exec', { command: 'echo hi', cwd: path.dirname(root) }, { wakePower: 'exec', wakeBudget: budget2 });
      await gate(badCwd);
      assert(badCwd.block && badCwd.block.errorCode === 'WAKE_PATH_OUTSIDE', 'cwd 越界必须拒');

      // detach 一律拒（没人收尾的常驻进程）；超时按这一档上限夹住
      const budget3 = { writes: 0, execs: 0, maxWrites: 1, maxExecs: 2, timeoutMs: 5000 };
      const detach = make('host_exec', { command: 'pythonw main.py', detached: true }, { wakePower: 'exec', wakeBudget: budget3 });
      await gate(detach);
      assert(detach.block && detach.block.errorCode === 'WAKE_POLICY_DENIED', 'detached 必须拒');
      const longCmd = make('host_exec', { command: 'echo hi', timeoutMs: 600000 }, { wakePower: 'exec', wakeBudget: budget3 });
      await gate(longCmd);
      assert(!longCmd.block, `正常命令应放行：${longCmd.block && longCmd.block.errorCode}`);
      assert(longCmd.args.timeoutMs === 5000, `超时必须夹到上限，实际 ${longCmd.args.timeoutMs}`);

      // 出网：exec 档放开 web_search / web_fetch（同一档的 host_exec 本来就能 curl，
      // 挡白名单只会把它挤到没有 SSRF 校验的命令行上）；不占写/命令预算
      const budget4 = { writes: 0, execs: 0, maxWrites: 1, maxExecs: 1 };
      for (const [name, args] of [
        ['web_search', { query: 'dieyun' }],
        ['web_fetch', { url: 'https://example.com' }]
      ]) {
        const c = make(name, args, { wakePower: 'exec', wakeBudget: budget4 });
        await gate(c);
        assert(!c.block, `exec 档应放行 ${name}：${c.block && c.block.errorCode}`);
      }
      assert(budget4.writes === 0 && budget4.execs === 0, '出网不该扣写/命令预算');
      // 看一眼内网有谁在：只读，放行（派活/领活仍拒）
      const peerList = make('peer_list', {}, { wakePower: 'exec', wakeBudget: budget4 });
      await gate(peerList);
      assert(!peerList.block, `exec 档应放行 peer_list：${peerList.block && peerList.block.errorCode}`);

      // 占屏 / 键鼠：exec 档放行，但**只要有别的轮次在跑就让路**（WAKE_YIELD）
      const runner = require('../src/agent/rust-loop-runner');
      const realCount = runner.getActiveAgentLoopCount;
      try {
        runner.getActiveAgentLoopCount = () => 1; // 只有这一轮自己
        for (const [name, args] of [
          ['browser_navigate', { url: 'https://example.com' }],
          ['computer', { action: 'screenshot' }]
        ]) {
          const c = make(name, args, { wakePower: 'exec', wakeBudget: budget4 });
          await gate(c);
          assert(!c.block, `exec 档独占时 ${name} 应放行：${c.block && c.block.errorCode}`);
        }
        runner.getActiveAgentLoopCount = () => 2; // 还有一个别的轮次在跑
        for (const [name, args] of [
          ['browser_navigate', { url: 'https://example.com' }],
          ['computer', { action: 'screenshot' }]
        ]) {
          const c = make(name, args, { wakePower: 'exec', wakeBudget: budget4 });
          await gate(c);
          assert(c.block && c.block.errorCode === 'WAKE_YIELD', `有别的轮次在跑时 ${name} 必须让路：${c.block && c.block.errorCode}`);
        }
        // 让路只针对占屏 / 键鼠：读文件、跑命令不受影响
        const read = make('fs_read_file', { filePath: path.join(root, 'a.txt') }, { wakePower: 'exec', wakeBudget: budget4 });
        await gate(read);
        assert(!read.block, `别的轮次在跑不影响读文件：${read.block && read.block.errorCode}`);
      } finally {
        runner.getActiveAgentLoopCount = realCount;
      }

      // 跨机 / 子 loop / 计划 仍然一律不放（它们不是「看一眼网页」）
      // 入参必须是**schema 合法**的：这三条以前写的是不存在的字段名（message / peer / planId），
      // 靠「validateToolArgs 对这几个工具是 no-op」才走到 scope 检查；现在参数校验生效，
      // 非法入参会先在参数关卡被拒（那测的就不是「心跳轮不许跨机」这件事了）。
      for (const [name, args] of [
        ['peer_send', { peer: 'x', text: 'hi' }],
        ['peer_claim', { action: 'list' }],
        ['subagent', { task: 'x' }],
        ['plan_run', { id: 'p1' }]
      ]) {
        const c = make(name, args, { wakePower: 'exec', wakeBudget: { writes: 0, execs: 0, maxWrites: 1, maxExecs: 1 } });
        await gate(c);
        assert(c.block && c.block.errorCode === 'READ_ONLY_SCOPE', `exec 档也不许 ${name}`);
      }
    }
  }

  // 4d) 心跳轮的工具表 = 该档白名单 ∩ 感官开着的（单一来源：`aliveWakeToolNames`）
  //     以前工具表在 main-agent-tools 里另拼一份，于是「清单里有、模型看不见」与
  //     「工具表里有、每轮被拒」两种病同时存在。
  {
    const { aliveWakeToolNames, ALIVE_WAKE_POWER_TOOL_NAMES } = require('../src/agent/guardrails-shared');
    const { buildMainAgentTools } = require('../src/agent/main-agent-tools');
    const catalog = require('../src/agent/tool-catalog');
    const staticNames = new Set(catalog.ALL_STATIC_TOOLS.map((t) => t.function.name));
    const names = (list) => list.map((t) => t.function.name);

    for (const power of ['read', 'write', 'exec']) {
      const want = aliveWakeToolNames(power, { drawer: true });
      const dead = want.filter((n) => !staticNames.has(n));
      assert(!dead.length, `${power} 档清单里有静态工具表不存在的名字（死格）：${dead.join(', ')}`);
      const tools = names(await buildMainAgentTools(null, want));
      assert(
        tools.length === want.length && want.every((n) => tools.includes(n)),
        `${power} 档工具表必须与清单逐项一致：want ${want.join(',')} got ${tools.join(',')}`
      );
      // 看得见 = 调得动：每种注入的名字都必须过得了「作用域」这一关（只跑 read-only-scope，
      // 后面的参数校验与本断言无关）
      const budget = { writes: 0, execs: 0, maxWrites: 99, maxExecs: 99 };
      const scopeOnly = DEFAULT_TOOL_GATE_HOOKS.filter((h) => h.id === 'read-only-scope');
      /** 动作类工具给一组「根目录内的合法参数」，只想验证作用域这一关放不放它 */
      const okArgs = {
        fs_write_file: { filePath: path.join(userDataPath, 'w.txt'), content: 'x' },
        fs_edit: { filePath: path.join(userDataPath, 'w.txt'), oldString: 'a', newString: 'b' },
        host_exec: { command: 'echo hi' }
      };
      for (const name of want) {
        if (name === 'camera_look' || name === 'desktop_camera_look') continue;
        const c = createToolCall({ name, args: okArgs[name] || {} });
        c.harness = { ctx: { sessionId: 's-wake-table', userDataPath, wakePower: power, wakeRoot: userDataPath, wakeBudget: budget } };
        await runToolGateStage('before', c, scopeOnly);
        assert(!c.block, `${power} 档注入了 ${name} 却被 gate 拒（${c.block && c.block.errorCode}）`);
      }
    }
    // 感官关着：摄像头不注入（免得它每轮试一次再吃 SENSE_DISABLED）
    assert(!aliveWakeToolNames('exec', { drawer: true }).includes('camera_look'), '眼睛关着时不该注入摄像头');
    assert(aliveWakeToolNames('exec', { drawer: true, eyes: true }).includes('camera_look'), '眼睛开着就该注入摄像头');
    // read / write 档不许出网；exec 档才放
    assert(!aliveWakeToolNames('write', {}).includes('web_search'), 'write 档不该有 web_search');
    assert(aliveWakeToolNames('exec', {}).includes('web_search'), 'exec 档要有 web_search');
    // 占屏 / 键鼠（browser_* / computer）只在 exec 档，且要对应本机权限开着才注入
    {
      const execOn = aliveWakeToolNames('exec', { browserAutomation: true, osControl: true });
      assert(execOn.includes('browser_navigate') && execOn.includes('computer'), 'exec 档 + 权限开着要有浏览器与键鼠');
      const execOff = aliveWakeToolNames('exec', { browserAutomation: false, osControl: true });
      assert(!execOff.some((n) => n.startsWith('browser_')), '浏览器自动化关掉时不注入 browser_*');
      assert(!aliveWakeToolNames('exec', { browserAutomation: true, osControl: false }).includes('computer'), '电脑控制关掉时不注入 computer');
      assert(!aliveWakeToolNames('write', { browserAutomation: true, osControl: true }).includes('browser_navigate'), 'write 档不该有浏览器');
      // 注入的每一个都必须真能过作用域关（含避让闸：此时没有别的轮次在跑）
      const playback = execOn.filter((n) => n.startsWith('browser_') || n === 'computer');
      assert(playback.length >= 20, `exec 档应当有整批浏览器工具，实际 ${playback.length}`);
      for (const name of playback) {
        const c = createToolCall({ name, args: { url: 'https://example.com' } });
        c.harness = { ctx: { sessionId: 's-wake-playback', userDataPath, wakePower: 'exec', wakeRoot: userDataPath, wakeBudget: { writes: 0, execs: 0, maxWrites: 9, maxExecs: 9 } } };
        await runToolGateStage('before', c, DEFAULT_TOOL_GATE_HOOKS.filter((h) => h.id === 'read-only-scope'));
        assert(!c.block, `exec 档注入了 ${name} 却被作用域关拒（${c.block && c.block.errorCode}）`);
      }
    }
    // 显式清单不注入 MCP（名字是运行期才知道的，白名单按名字写，必然进不去）
    const fakeMcp = { listAgentTools: async () => ({ tools: [{ agentName: 'mcp_pg__query', serverId: 'pg' }] }) };
    const withMcp = names(await buildMainAgentTools(fakeMcp, [...ALIVE_WAKE_POWER_TOOL_NAMES.read]));
    assert(!withMcp.includes('mcp_pg__query'), '心跳轮工具表不该注入 MCP 工具');
    // 不传清单的调用方（计划 / 频道 / headless）行为不变：静态 PLAN_RUNTIME + PEER + MCP
    const plain = names(await buildMainAgentTools(fakeMcp));
    assert(plain.includes('subagent') === false && plain.includes('peer_send'), '默认档仍含 PEER_TOOLS');
    assert(plain.includes('mcp_pg__query'), '默认档仍注入 MCP');
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
      // 同上：入参按 schema 写（`text` 不是 `message`、`id` 不是 `planId`），
      // 否则测到的是参数校验而不是「只读轮不许这些工具」。
      ['peer_send', { peer: 'x', text: 'hi' }],
      ['memory_forget', { memoryIds: [1] }],
      ['subagent', { task: 'do it' }],
      ['plan_run', { id: 'p1' }],
      ['goal_check', { check_id: 'c1' }],
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

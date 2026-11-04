#!/usr/bin/env node
'use strict';

/**
 * 无界面入口（纯 Node）：终端 REPL / 一次性命令 / 浏览器 UI。
 *
 * 这里**只做前端**：装配在 `boot.js`（复用既有工厂），一轮对话在
 * `agent/main-turn-runner.js`（与频道、定时计划同一份）。本文件负责的是
 * 进程生命周期（信号、退出码）、把正文流到 stdout / NDJSON、以及会话的挑选与创建。
 */

const path = require('path');
const readline = require('readline');

const { parseCliArgs, USAGE } = require('./cli-args');
const { createLogger } = require('./log');
const { bootHeadless } = require('./boot');
const { generateKeyFile } = require('./secret-storage');
const { runMainTurn, resolveTurnModel } = require('../agent/main-turn-runner');

/** 退出码：0 成功 · 2 本轮失败/无交付 · 3 配置缺失（与 docs/HEADLESS.md 一致） */
const EXIT_OK = 0;
const EXIT_FAILED = 2;
const EXIT_CONFIG = 3;

/** 这些码代表「环境/配置没配好」，不是这一轮本身失败 */
const CONFIG_CODES = new Set(['CORE_UNAVAILABLE', 'NO_API_KEY', 'NO_MODEL', 'GATEWAY_UNAVAILABLE']);

function exitCodeFor(err) {
  const code = err && err.code;
  if (code && CONFIG_CODES.has(code)) return EXIT_CONFIG;
  return EXIT_FAILED;
}

/**
 * 终端 / NDJSON 共用的 sink：`llm_delta.content` 是**本轮累计**正文，直接写会把同一段反复打印。
 * 这里算「与上次的前缀差」。换轮（内容不再以旧值为前缀）时补一个换行当分隔。
 *
 * @param {{ write: (s: string) => any }|null} stream 为 null 时只回调、不直接写（NDJSON 用）
 * @param {((delta: string) => void)|null} onDelta
 */
function createTerminalSink(stream, onDelta) {
  let last = '';
  return {
    push(text) {
      const t = String(text || '');
      if (!t) return;
      const delta = t.startsWith(last) ? t.slice(last.length) : `${last ? '\n' : ''}${t}`;
      last = t;
      if (!delta) return;
      if (typeof onDelta === 'function') onDelta(delta);
      if (stream) stream.write(delta);
    },
    reset() {
      last = '';
    }
  };
}

/** NDJSON 里只留可消费的小字段：`start` 阶段带着整份 system prompt 与工具表，不能原样吐 */
function leanPhaseData(data) {  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of ['runId', 'round', 'model', 'name', 'ok', 'error', 'errorCode', 'status']) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  if (Array.isArray(data.toolCalls)) out.toolCalls = data.toolCalls.length;
  if (Array.isArray(data.tools)) out.toolCount = data.tools.length;
  return out;
}

/** 正文增量已经走 `delta` 事件，这两个 phase 再吐一次是纯噪声 */
const DELTA_PHASES = new Set(['llm_delta', 'synthesis_delta']);

/** 会话解析：`--session` 指定就续用（不存在则明确报错），否则新建并带上工作空间 */
async function ensureSession(gateway, { sessionId, workspacePath, title }) {
  const wanted = String(sessionId || '').trim();
  if (wanted) {
    const row = await gateway.invokeRpc('memory.session_get', { sessionId: wanted });
    if (!row || !row.id) {
      const e = new Error(`会话不存在：${wanted}`);
      e.code = 'SESSION_NOT_FOUND';
      throw e;
    }
    return row.id;
  }
  const created = await gateway.invokeRpc('memory.session_create', {
    title: String(title || '无界面终端'),
    workspacePath: workspacePath || null
  });
  if (!created || !created.id) throw new Error('创建会话失败');
  return created.id;
}

async function cmdSelfTest(opts, log) {
  const boot = await bootHeadless({ ...opts, log });
  try {
    // 1) 账本可写：建会话 + 读回
    const sessionId = await ensureSession(boot.gateway, {
      workspacePath: boot.workspacePath,
      title: 'self-test'
    });
    const rows = await boot.gateway.invokeRpc('memory.messages_recent', { sessionId, limit: 5 });
    if (!Array.isArray(rows)) throw new Error('memory.messages_recent 返回异常');

    // 2) 工具面可用：走真实工具桥列一次目录
    const tool = boot.createToolBridge();
    const listed = await tool.executeAgentTool(
      'fs_list_dir',
      { dirPath: boot.workspacePath },
      { workspacePath: boot.workspacePath, sessionId, model: '' }
    );
    if (!listed || listed.ok === false) {
      throw new Error(`fs_list_dir 失败：${(listed && (listed.error || listed.message)) || '未知原因'}`);
    }

    // 3) 沙箱档位可读（无审批通道时必须能报出 fail-closed 的那个档）
    const mode = boot.gateway.getSandboxMode();
    process.stdout.write(
      `self-test: OK\n  core=${boot.coreBridge ? 'ready' : 'missing'}\n  workspace=${boot.workspacePath}\n  sandbox=${mode}\n  session=${sessionId}\n`
    );
    return EXIT_OK;
  } finally {
    await boot.stop();
  }
}

async function cmdRun(opts, log) {
  const boot = await bootHeadless({ ...opts, log });
  try {
    // 先确认模型配置（纯读配置、不出网）：否则会在账本里留下一条空会话，
    // 而这一轮注定跑不起来
    resolveTurnModel({ userData: boot.userData, route: opts.route, model: opts.model });
    const sessionId = await ensureSession(boot.gateway, {
      sessionId: opts.sessionId,
      workspacePath: boot.workspacePath,
      title: opts.text.slice(0, 40)
    });
    // NDJSON：stdout 只放事件（日志走 stderr），正文作为 delta 事件逐段给出
    const emit = (evt) => process.stdout.write(`${JSON.stringify(evt)}\n`);
    const sink = opts.json
      ? createTerminalSink(null, (delta) => emit({ type: 'delta', text: delta }))
      : createTerminalSink(process.stdout, null);
    const result = await runMainTurn({
      userData: boot.userData,
      gateway: boot.gateway,
      coreBridge: boot.coreBridge,
      mcpRuntime: boot.mcpRuntime,
      compactionAgent: boot.compactionAgent,
      toolBridge: boot.createToolBridge(),
      sessionId,
      workspacePath: boot.workspacePath,
      userText: opts.text,
      ledgerText: opts.text,
      runSource: 'headless',
      model: opts.model,
      route: opts.route,
      listMcpServers: boot.mcpStore.listMcpServersForUi,
      sink,
      onPhase: opts.json
        ? (phase, data) => {
            if (DELTA_PHASES.has(phase)) return;
            emit({ type: 'phase', phase, data: leanPhaseData(data) });
          }
        : null
    });
    if (opts.json) {
      emit({
        type: 'done',
        sessionId: result.sessionId,
        runId: result.runId,
        aborted: !!result.aborted,
        content: result.content
      });
    } else {
      process.stdout.write('\n');
    }
    return result.aborted ? EXIT_FAILED : EXIT_OK;
  } finally {
    await boot.stop();
  }
}

async function cmdRepl(opts, log) {
  const boot = await bootHeadless({ ...opts, log });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sessionId = '';
  try {
    // 同上：没配模型就别进交互，否则每一句话都会失败一次
    resolveTurnModel({ userData: boot.userData, route: opts.route, model: opts.model });
    sessionId = await ensureSession(boot.gateway, {
      sessionId: opts.sessionId,
      workspacePath: boot.workspacePath,
      title: '无界面终端'
    });
    log.info(`会话：${sessionId}（/exit 退出；跑动中 Ctrl-C 中止本轮，空闲时 Ctrl-C 退出）`);
    /**
     * 在跑的那一轮的中止开关（空闲时 null）。
     * readline 一旦接管终端，Ctrl-C 只会发 `'SIGINT'` 事件、不会终止进程；没有这个监听时
     * 它的默认动作是 `pause()`，异步迭代器既不 yield 也不结束 —— REPL 静默卡死，
     * 而且 `finally { boot.stop() }` 永不执行（core / MCP 子进程与 Gateway 端口不回收）。
     */
    let turnController = null;
    rl.on('SIGINT', () => {
      if (turnController && !turnController.signal.aborted) {
        turnController.abort();
        process.stderr.write('\n（正在中止本轮…再按一次 Ctrl-C 直接退出）\n');
        return;
      }
      rl.close();
    });
    const ask = () => rl.setPrompt('\n› ');
    ask();
    rl.prompt();

    for await (const line of rl) {
      const text = String(line || '').trim();
      if (!text) {
        rl.prompt();
        continue;
      }
      if (text === '/exit' || text === '/quit') break;
      if (text === '/new') {
        sessionId = await ensureSession(boot.gateway, {
          workspacePath: boot.workspacePath,
          title: '无界面终端'
        });
        log.info(`新会话：${sessionId}`);
        rl.prompt();
        continue;
      }
      const sink = createTerminalSink(process.stdout, null);
      const controller = new AbortController();
      turnController = controller;
      try {
        await runMainTurn({
          userData: boot.userData,
          gateway: boot.gateway,
          coreBridge: boot.coreBridge,
          mcpRuntime: boot.mcpRuntime,
          compactionAgent: boot.compactionAgent,
          toolBridge: boot.createToolBridge(),
          sessionId,
          workspacePath: boot.workspacePath,
          userText: text,
          ledgerText: text,
          runSource: 'headless',
          model: opts.model,
          route: opts.route,
          listMcpServers: boot.mcpStore.listMcpServersForUi,
          sink,
          signal: controller.signal,
          abortedNote: '（任务已由用户中止）'
        });
      } catch (err) {
        // 用户自己能修的问题原样说；其余只给一句通用失败（细节在日志里）
        process.stderr.write(`\n${err && err.userSafe ? err.message : '执行失败，请查看日志'}\n`);
        if (!(err && err.userSafe)) log.error(`${(err && err.stack) || err}`);
      } finally {
        turnController = null;
      }
      ask();
      rl.prompt();
    }
    return EXIT_OK;
  } finally {
    try {
      rl.close();
    } catch {
      // ignore
    }
    await boot.stop();
  }
}

async function cmdServe(opts, log) {
  const boot = await bootHeadless({ ...opts, log });
  log.info(`headless 已就绪（pid ${process.pid}）`);
  if (!opts.web && !opts.plans) {
    log.info('当前只提供本地 Gateway 与工具面；要交互请加 --web（浏览器）或 --plans（定时任务）');
  }
  await new Promise((resolve) => {
    const bye = () => resolve();
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  });
  log.info('收到退出信号，正在关闭…');
  await boot.stop();
  return EXIT_OK;
}

async function main(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (parsed.version) {
    // 版本只有一个来源：包根的 package.json（deb / tgz 里都是它；不另建 VERSION 文件）
    let version = 'unknown';
    try {
      version = String(require(path.join(__dirname, '..', '..', 'package.json')).version || 'unknown');
    } catch {
      // 源码树被剪过也别为此失败：打日志没用，直接给 unknown
    }
    process.stdout.write(`dieyun-headless ${version}\n`);
    return EXIT_OK;
  }
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return EXIT_FAILED;
  }
  const opts = parsed.opts;
  const log = createLogger({ level: opts.logLevel });

  if (opts.command === 'gen-key') {
    const file = generateKeyFile(opts.out);
    process.stdout.write(`已生成凭据密钥：${file}（权限 0600）\n把它的路径写进服务环境：DIEYUN_SECRET_KEY_FILE=${file}\n`);
    return EXIT_OK;
  }

  try {
    if (opts.command === 'self-test') return await cmdSelfTest(opts, log);
    if (opts.command === 'run') return await cmdRun(opts, log);
    if (opts.command === 'repl') return await cmdRepl(opts, log);
    return await cmdServe(opts, log);
  } catch (err) {
    if (err && err.userSafe) process.stderr.write(`${err.message}\n`);
    else log.error(`${(err && err.stack) || err}`);
    return exitCodeFor(err);
  }
}

if (require.main === module) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
      // 留一拍让 stdout 冲刷完（管道模式下的常见坑）
      setTimeout(() => process.exit(code), 10);
    },
    (err) => {
      // main 内部已兜住错误；走到这里说明连日志都写不出去
      process.stderr.write(`[dieyun-headless] 启动失败：${(err && err.message) || err}\n`);
      process.exit(EXIT_FAILED);
    }
  );
}

module.exports = { main, createTerminalSink, ensureSession, EXIT_OK, EXIT_FAILED, EXIT_CONFIG };

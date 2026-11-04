'use strict';

/**
 * headless 入口的参数解析：**唯一一处** parse `process.argv`。
 *
 * 刻意不引第三方 argv 库：这里只有十来个开关，多一个依赖就多一份「打包时必须存在」的负担
 * （headless 要能在只有 node + src 的服务器上直接跑）。
 */

const path = require('path');
const { SANDBOX_MODES } = require('../gateway/sandbox-policy');
const { normalizeLevel } = require('./log');

const COMMANDS = ['serve', 'repl', 'run', 'self-test', 'gen-key'];
const DEFAULT_WEB_PORT = 17331;

const USAGE = `dieyun-headless —— 无界面运行叠云 Agent（终端 / 一次性命令 / 浏览器）

用法：
  dieyun-headless serve [选项]              常驻；配合 --web 提供浏览器界面
  dieyun-headless repl [选项]               交互终端（一次会话内连续对话）
  dieyun-headless run "<任务>" [选项]       跑一轮就退出（退出码反映成败，适合 cron/CI）
  dieyun-headless self-test [选项]          无网络自检：起 Gateway + dieyun-core，跑一条本地 RPC
  dieyun-headless gen-key --out <文件>      生成凭据加密密钥（0600），写进 DIEYUN_SECRET_KEY_FILE

选项：
  --workspace <目录>      默认工作空间（缺省 ~/.dieyun/workspace）
  --user-data <目录>      数据目录（缺省按平台规则：<appData>/dieyunagent，可用 DIEYUN_USER_DATA 覆盖）
  --session <会话id>      续用已有会话（缺省每次新建）
  --web                   同时提供浏览器界面（复用手机端页面，token 认证）
  --host <地址>           Web 监听地址（缺省 127.0.0.1；要对外必须先想清楚 token 与反代）
  --port <端口>           Web 监听端口（缺省 ${DEFAULT_WEB_PORT}）
  --sandbox <档位>        覆盖沙箱档位：read-only | workspace-write | danger-full-access
  --model <模型>          覆盖本轮使用的模型
  --route <供应商>        模型路由（与模型设置里的供应商 id 一致）
  --plans                 同时启动定时计划调度器
  --json                  run 模式输出 NDJSON 事件（stdout 只放事件，日志走 stderr）
  --log-level <级别>      error | warn | info | debug（缺省 info）
  -v, --version           打印版本（升级后确认服务器上跑的是哪一版）
  -h, --help              显示本帮助

环境变量：
  DIEYUN_USER_DATA        数据目录（优先于 --user-data）
  DIEYUN_SECRET_KEY_FILE  凭据加密密钥文件（MCP / SSH / 频道 Secret 需要；缺失时凭据不可写）
  DIEYUN_CORE_BIN         dieyun-core 可执行文件路径
  DIECLOUD_GATEWAY_PORT   Gateway 本地端口（同一 userData 只允许一个实例）
`;

function fail(message) {
  return { ok: false, error: message, opts: null, help: false };
}

/**
 * @param {string[]} argv 完整 `process.argv`
 * @returns {{ ok: boolean, error?: string, help?: boolean, opts?: object }}
 */
function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const positionals = [];
  const opts = {
    command: 'serve',
    workspace: '',
    userData: '',
    sessionId: '',
    web: false,
    host: '',
    port: 0,
    sandbox: '',
    model: '',
    route: '',
    plans: false,
    json: false,
    logLevel: 'info',
    out: '',
    text: ''
  };

  /** 带值开关：拿不到值就报错，绝不静默当空串（否则 --workspace 后面漏写会跑错目录） */
  function takeValue(flag, i) {
    const v = args[i + 1];
    if (v == null || (v.startsWith('--') && v.length > 2)) {
      throw new Error(`${flag} 需要一个值`);
    }
    return v;
  }

  try {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '-h' || a === '--help') return { ok: true, help: true, opts: null };
      if (a === '-v' || a === '--version') return { ok: true, version: true, opts: null };
      // `--` 之后一律当位置参数：让 `run "--fix this"` 这类以短横线开头的任务文本能被传进去
      if (a === '--') {
        positionals.push(...args.slice(i + 1));
        break;
      }
      if (a === '--web') { opts.web = true; continue; }
      if (a === '--plans') { opts.plans = true; continue; }
      if (a === '--json') { opts.json = true; continue; }
      if (a === '--workspace') { opts.workspace = takeValue(a, i); i += 1; continue; }
      if (a === '--user-data') { opts.userData = takeValue(a, i); i += 1; continue; }
      if (a === '--session') { opts.sessionId = takeValue(a, i); i += 1; continue; }
      if (a === '--host') { opts.host = takeValue(a, i); i += 1; continue; }
      if (a === '--port') {
        // 就地校验：`Number('abc')` 是 NaN，留着不校验会一路传到 listen 里变成随机端口
        const n = Number(takeValue(a, i));
        i += 1;
        if (!Number.isInteger(n) || n < 1 || n > 65535) return fail('--port 必须是 1-65535 的整数');
        opts.port = n;
        continue;
      }
      if (a === '--sandbox') { opts.sandbox = takeValue(a, i); i += 1; continue; }
      if (a === '--model') { opts.model = takeValue(a, i); i += 1; continue; }
      if (a === '--route') { opts.route = takeValue(a, i); i += 1; continue; }
      if (a === '--log-level') { opts.logLevel = takeValue(a, i); i += 1; continue; }
      if (a === '--out') { opts.out = takeValue(a, i); i += 1; continue; }
      if (a.startsWith('-')) return fail(`未知参数：${a}`);
      positionals.push(a);
    }

    if (positionals.length) {
      const cmd = positionals.shift();
      if (!COMMANDS.includes(cmd)) return fail(`未知命令：${cmd}`);
      opts.command = cmd;
      if (positionals.length) opts.text = positionals.join(' ');
    }

    if (opts.workspace) opts.workspace = path.resolve(opts.workspace);
    if (opts.userData) opts.userData = path.resolve(opts.userData);
    if (opts.sandbox && !SANDBOX_MODES.includes(opts.sandbox)) {
      return fail(`--sandbox 只能是 ${SANDBOX_MODES.join(' | ')}`);
    }
    opts.logLevel = normalizeLevel(opts.logLevel);
    if (opts.command === 'run' && !String(opts.text || '').trim()) {
      return fail('run 需要任务文本，例如：dieyun-headless run "看看这个仓库"');
    }
    if (opts.command === 'gen-key' && !String(opts.out || '').trim()) {
      return fail('gen-key 需要 --out <文件路径>');
    }
    return { ok: true, help: false, opts };
  } catch (err) {
    return fail((err && err.message) || String(err));
  }
}

module.exports = { parseCliArgs, USAGE, COMMANDS, DEFAULT_WEB_PORT };

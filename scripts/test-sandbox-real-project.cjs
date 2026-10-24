'use strict';

/**
 * 沙箱「真实项目」验收：把**本仓库自己**当工作区，跑真 Gateway + 真命令 + 真文件。
 *
 * 为什么需要它（临时目录测不出来的东西）：
 * - 程序路径里带空格（`C:\Program Files\nodejs\node.exe`）：引号/转义一旦被弄坏，
 *   临时目录里的"裸 node"照样能跑，问题就漏过去了；
 * - 绝对路径的解释器（`"…\node.exe" -e …`）：read-only 档按字面量 `node -e` 匹配时，
 *   绝对路径**永远不命中**，档位形同虚设；
 * - 真实仓库里到处是 `shutdown` / `reboot` 之类的字（注释、文档、提交信息）：
 *   高危词按"整条命令"匹配时，`grep -rn shutdown src/` 会被当成关机命令硬拒。
 *
 * 只读地使用仓库（git status / git log / grep），写入只落在 `.tmp-sandbox-probe/`，
 * 结束时连同仓库外的探针文件一起删除；不修改任何被跟踪的文件。
 *
 * 用法: node scripts/test-sandbox-real-project.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTestLocalGateway } = require('./lib/test-gateway-harness.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROBE_DIR = path.join(REPO_ROOT, '.tmp-sandbox-probe');

const results = [];
function rec(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}
function normPath(p) {
  return String(p || '').toLowerCase().replace(/\\+$/, '');
}

async function main() {
  const { gateway, stop } = createTestLocalGateway(REPO_ROOT);
  const asks = [];
  let answer = true;
  gateway.setSandboxApprovalChannel(async (payload) => {
    asks.push(payload);
    return answer;
  });
  const rpc = async (method, params) => {
    try {
      return { ok: true, value: await gateway.invokeRpc(method, params) };
    } catch (e) {
      return { ok: false, code: (e && (e.code || e.errorCode)) || 'UNKNOWN', message: e && e.message };
    }
  };

  try {
    // 1) 真实仓库作为工作区：可写，主目录与 ~/.dieyun 父目录不可写
    const state = gateway.getSandboxState();
    rec('工作区 = 真实仓库', state.writableRoots.some((r) => normPath(r) === normPath(REPO_ROOT)), state.mode);
    rec('主目录不可写', !state.writableRoots.some((r) => normPath(r) === normPath(os.homedir())));
    rec(
      '内部根不含 ~/.dieyun 父目录',
      !state.writableRoots.some((r) => normPath(r) === normPath(path.join(os.homedir(), '.dieyun')))
    );

    // 2) 真实只读命令：不询问、不硬拒（仓库里真的到处是 shutdown/reboot 字样）
    for (const cmd of [
      'git status --short',
      'git log --oneline -1',
      'grep -rn shutdown src/',
      'git log --grep=shutdown',
      'ls 2>&1'
    ]) {
      const before = asks.length;
      const r = await rpc('host.exec', { command: cmd, cwd: REPO_ROOT });
      rec(`只读放行：${cmd}`, r.ok && asks.length === before, r.ok ? '' : `${r.code} ${r.message}`);
    }

    // 3) 仓库内写：不问
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    {
      const before = asks.length;
      const r = await rpc('fs.write_file', { filePath: path.join(PROBE_DIR, 'in-repo.txt'), data: 'ok' });
      rec('仓库内写不询问', r.ok && asks.length === before);
    }

    // 4) host.exec + 带空格路径 + 引号（MSVCRT 转义坑）
    {
      const spaced = path.join(PROBE_DIR, 'with space');
      fs.mkdirSync(spaced, { recursive: true });
      const target = path.join(spaced, 'out.txt');
      const r = await rpc('host.exec', { command: `echo "hello real" > "${target}"`, cwd: REPO_ROOT });
      const content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').trim() : '';
      rec('host.exec 带空格引号路径', r.ok && content === '"hello real"', JSON.stringify(content));
    }

    // 5) read-only：解释器一律先问一次（绝对路径 / 裸命令 / 宿主 shell 包装）
    gateway.setPermissions({ sandboxMode: 'read-only' });
    answer = true;
    for (const [label, cmd] of [
      ['node -e（绝对路径）', `"${process.execPath}" -e "console.log(42)"`],
      ['node -e（裸命令）', 'node -e "console.log(42)"'],
      ['cmd /c 包装', 'cmd /c "node -e \\"console.log(42)\\""']
    ]) {
      // 每条前清一次批准记忆：ask-once 会让同类别第二条不再询问（那是设计，不是漏判）
      gateway.sandboxApprovals.clearAll();
      const before = asks.length;
      const r = await rpc('host.exec', { command: cmd, cwd: REPO_ROOT });
      rec(`read-only 先问一次：${label}`, r.ok && asks.length === before + 1, `asks+${asks.length - before}`);
    }
    {
      gateway.sandboxApprovals.clearAll();
      const before = asks.length;
      const r = await rpc('host.exec', { command: 'node -v', cwd: REPO_ROOT });
      rec('read-only 不弹：node -v（纯信息开关）', r.ok && asks.length === before, `asks+${asks.length - before}`);
    }

    // 6) read-only：默认工作区（~/.dieyun/workspace）写入必须问；拒绝则不落盘
    {
      const target = path.join(os.homedir(), '.dieyun', 'workspace', `.probe-${process.pid}.txt`);
      const before = asks.length;
      answer = false;
      const r = await rpc('fs.write_file', { filePath: target, data: 'x' });
      rec('read-only：默认工作区写入要问', asks.length === before + 1);
      rec('read-only：拒绝后不落盘', r.code === 'SANDBOX_DECLINED' && !fs.existsSync(target), r.code);
      answer = true;
    }

    // 7) 档位收紧作废旧批准
    {
      gateway.setPermissions({ sandboxMode: 'workspace-write' });
      gateway.sandboxApprovals.clearAll();
      const target = path.join(os.homedir(), `.dy-real-probe-${process.pid}.txt`);
      const first = await rpc('fs.write_file', { filePath: target, data: 'a' });
      const mark = asks.length;
      gateway.setPermissions({ sandboxMode: 'read-only' });
      const second = await rpc('fs.write_file', { filePath: target, data: 'b' });
      rec('收紧档位后重新询问', first.ok && second.ok && asks.length === mark + 1);
      try {
        fs.rmSync(target, { force: true });
      } catch {
        /* ignore */
      }
    }

    // 8) 高危命令：真执行才拒（"提到关键词"已在第 2 步证明放行）
    {
      gateway.setPermissions({ sandboxMode: 'danger-full-access' });
      const shutdown = await rpc('host.exec', { command: 'shutdown /s /t 0', cwd: REPO_ROOT });
      rec('shutdown 被拒', shutdown.code === 'BLOCKED' || shutdown.code === 'SANDBOX_DENIED', shutdown.code);
      const format = await rpc('host.exec', { command: 'format c:', cwd: REPO_ROOT });
      rec('format 被拒', format.code === 'BLOCKED' || format.code === 'SANDBOX_DENIED', format.code);
    }

    // 9) 观测面字段齐全
    {
      const s = await rpc('permissions.sandbox_state', {});
      const v = s.value || {};
      rec(
        'sandbox_state 字段齐',
        s.ok &&
          Array.isArray(v.writableRoots) &&
          Array.isArray(v.grants) &&
          Array.isArray(v.internalRoots) &&
          'remoteGoverned' in v
      );
    }
  } finally {
    try {
      fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? 'FAILED' : 'ALL OK'}: ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

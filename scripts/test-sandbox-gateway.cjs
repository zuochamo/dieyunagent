'use strict';

/**
 * 沙箱档位 + ask-once 审批的端到端契约（真 Gateway、真文件、真命令）。
 *
 * 覆盖：
 * - 三档对「能写哪儿」的影响（写白名单随档位变）
 * - 越界写 → 问一次 → 允许后本会话不再问 / 拒绝则不写
 * - 高危命令任何档位都拒
 * - host.exec 的越界判定与拒绝话术
 *
 * 用法: node scripts/test-sandbox-gateway.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTestLocalGateway } = require('./lib/test-gateway-harness.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function rpc(gateway, method, params) {
  try {
    return { ok: true, value: await gateway.invokeRpc(method, params) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function errCode(res) {
  if (res.ok) return null;
  return (res.error && (res.error.code || res.error.errorCode)) || 'UNKNOWN';
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-sbx-'));
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello', 'utf8');

  // 工作区之外的落点：主目录（workspace-write 下不再默认可写）
  const outsideDir = path.join(os.homedir(), `.dieyun-sbx-test-${process.pid}-${Date.now()}`);
  const outsideFile = path.join(outsideDir, 'nope.txt');

  const { gateway, stop } = createTestLocalGateway(ws);
  const asks = [];
  gateway.setSandboxApprovalChannel(async (payload) => {
    asks.push(payload);
    return payload.__answer === false ? false : true;
  });

  try {
    // 1) 默认档位 = workspace-write，且可写根包含工作区、不含主目录
    {
      const st = gateway.getSandboxState();
      assert(st.mode === 'workspace-write', `default mode, got ${st.mode}`);
      const norm = (p) => String(p).toLowerCase();
      assert(
        st.writableRoots.some((r) => norm(ws).startsWith(norm(r))),
        'workspace is writable in workspace-write'
      );
      assert(
        !st.writableRoots.some((r) => norm(r) === norm(os.homedir())),
        'user home is NOT writable in workspace-write'
      );
    }

    // 2) 工作区内写：不问，直接成功
    {
      const res = await rpc(gateway, 'fs.write_file', { filePath: path.join(ws, 'in.txt'), data: 'x' });
      assert(res.ok, `workspace write ok: ${res.ok ? '' : res.error && res.error.message}`);
      assert(asks.length === 0, `no approval needed inside workspace, got ${asks.length}`);
      assert(fs.readFileSync(path.join(ws, 'in.txt'), 'utf8') === 'x', 'file content written');
    }

    // 2b) 临时目录：workspace-write 档下两条判定链必须给出同一个答案
    //     （`assertSandboxWritable` 走 `_collectWritableRoots`、handler 走 `sandboxContext`；
    //      临时目录曾经只在前者里，于是文件工具放行、shell 却弹窗）
    {
      const tmpFile = path.join(os.tmpdir(), `dieyun-sbx-tmp-${process.pid}.txt`);
      const beforeFs = asks.length;
      const fsRes = await rpc(gateway, 'fs.write_file', { filePath: tmpFile, data: 't' });
      assert(fsRes.ok, `temp write ok: ${fsRes.ok ? '' : fsRes.error && fsRes.error.message}`);
      assert(asks.length === beforeFs, `temp write must not ask in workspace-write, got ${asks.length - beforeFs} asks`);

      const beforeShell = asks.length;
      const shRes = await rpc(gateway, 'host.exec', { command: `echo t2 > "${tmpFile}"`, cwd: ws });
      assert(shRes.ok, `temp shell write ok: ${shRes.ok ? '' : shRes.error && shRes.error.message}`);
      assert(
        asks.length === beforeShell,
        `shell 写临时目录也不该问（旧实现只放行 fs 通道），got ${asks.length - beforeShell} asks`
      );
      fs.rmSync(tmpFile, { force: true });
    }

    // 3) 工作区外写：问一次 → 允许 → 成功；再一次同类 → 不再问
    {
      const res1 = await rpc(gateway, 'fs.write_file', { filePath: outsideFile, data: 'a' });
      assert(asks.length === 1, `outside write asks once, got ${asks.length}`);
      assert(asks[0].category === 'write', 'approval carries category');
      assert(asks[0].mode === 'workspace-write', 'approval carries mode');
      assert(String(asks[0].detail || '').length > 0, 'approval carries the target path');
      assert(res1.ok, `approved outside write ok: ${res1.ok ? '' : res1.error && res1.error.message}`);

      const res2 = await rpc(gateway, 'fs.write_file', { filePath: `${outsideFile}.2`, data: 'b' });
      assert(res2.ok, 'second outside write ok');
      assert(asks.length === 1, `ask-once: second write must not ask again, got ${asks.length}`);
    }

    // 4) 拒绝：不落盘，返回 SANDBOX_DECLINED
    {
      gateway.sandboxApprovals.clearAll();
      const closed = path.join(outsideDir, 'declined.txt');
      gateway.setSandboxApprovalChannel(async (payload) => {
        asks.push(payload);
        return { granted: false, reason: '测试拒绝' };
      });
      const before = asks.length;
      const res = await rpc(gateway, 'fs.write_file', { filePath: closed, data: 'no' });
      assert(asks.length === before + 1, 'declined path asked exactly once');
      assert(errCode(res) === 'SANDBOX_DECLINED', `declined code, got ${errCode(res)}`);
      assert(!fs.existsSync(closed), 'declined write must not create the file');
      assert(/不要重试/.test(String(res.error && res.error.message)), 'decline message tells the model not to retry');
    }

    // 5) 恢复通道 + read-only 档：工作区内写也要问
    {
      gateway.sandboxApprovals.clearAll();
      gateway.setSandboxApprovalChannel(async (payload) => {
        asks.push(payload);
        return true;
      });
      gateway.setPermissions({ sandboxMode: 'read-only' });
      assert(gateway.getSandboxState().mode === 'read-only', 'mode switched to read-only');
      const before = asks.length;
      const res = await rpc(gateway, 'fs.write_file', { filePath: path.join(ws, 'ro.txt'), data: 'x' });
      assert(asks.length === before + 1, 'read-only asks even inside workspace');
      assert(res.ok, 'approved read-only write proceeds');

      // 临时目录也不算内部根：read-only 档下同样要问
      // （临时目录里的项目不该因为落在 %TEMP% 就整片免问）
      const tmpRo = path.join(os.tmpdir(), `dieyun-sbx-ro-${process.pid}.txt`);
      const beforeRo = asks.length;
      const roRes = await rpc(gateway, 'fs.write_file', { filePath: tmpRo, data: 'x' });
      assert(asks.length === beforeRo + 1, 'read-only asks for temp writes too');
      assert(roRes.ok, 'approved read-only temp write proceeds');
      fs.rmSync(tmpRo, { force: true });

      // read-only 的可写根只能列到具体子目录：`~/.dieyun` 这个父目录包着默认工作区
      // （~/.dieyun/workspace），放行它等于 read-only 在默认工作区里完全失效。
      const st = gateway.getSandboxState();
      const norm = (p) => String(p).toLowerCase();
      const home = os.homedir().toLowerCase();
      assert(
        !st.writableRoots.some((r) => norm(r) === path.join(home, '.dieyun')),
        `~/.dieyun must not be a writable root, got ${JSON.stringify(st.writableRoots)}`
      );
      assert(
        !st.writableRoots.some((r) => norm(r) === path.join(home, '.dieyun', 'workspace')),
        'default workspace must not be writable in read-only'
      );
      assert(
        st.writableRoots.some((r) => norm(r) === path.join(home, '.dieyun', 'skills')),
        'skills dir stays writable in read-only'
      );
    }

    // 6) 高危命令：任何档位都拒（且不触发审批）
    //    注意 shutdown 这类同时也在 `exec-policy` 的高危词表里 —— 两份词表现在是同一份
    //    （sandbox-policy.SANDBOX_DENY_LIST），所以这里同时接受两层给出的错误码。
    {
      for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
        gateway.setPermissions({ sandboxMode: mode });
        for (const cmd of ['shutdown /s /t 0', 'bcdedit /set x y', 'mkfs.ext4 /dev/sdb1']) {
          const before = asks.length;
          const res = await rpc(gateway, 'host.exec', { command: cmd, cwd: ws });
          const code = errCode(res);
          assert(
            code === 'SANDBOX_DENIED' || code === 'BLOCKED',
            `${mode}: "${cmd}" must be denied, got ${code}`
          );
          assert(asks.length === before, `${mode}: "${cmd}" must not ask`);
        }
      }
    }

    // 7) host.exec：越界写要问；批准后命令真的执行
    {
      gateway.setPermissions({ sandboxMode: 'workspace-write' });
      gateway.sandboxApprovals.clearAll();
      gateway.setSandboxApprovalChannel(async (payload) => {
        asks.push(payload);
        return true;
      });
      const marker = path.join(outsideDir, 'cmd-marker.txt');
      const cmd = `echo hi > ${marker}`;
      const before = asks.length;
      const res = await rpc(gateway, 'host.exec', { command: cmd, cwd: ws });
      assert(asks.length === before + 1, 'out-of-workspace shell write asks once');
      assert(res.ok, 'approved shell write runs');
      assert(fs.existsSync(marker), 'approved shell write produced the file');
    }

    // 7c) host.exec 的批准粒度是「会话 × 类别 × 目录」：换目录必须重新问。
    //     曾退化：shell 判定不传 path → `scopeOf(undefined)='-'` → 类别级批准，
    //     批准过 dirA 就等于批准过 dirB（一次批准打穿整个档位）。
    {
      gateway.setPermissions({ sandboxMode: 'workspace-write' });
      gateway.sandboxApprovals.clearAll();
      gateway.setSandboxApprovalChannel(async (payload) => {
        asks.push(payload);
        return true;
      });
      const dirA = path.join(os.homedir(), `.dieyun-sbx-a-${process.pid}-${Date.now()}`);
      const dirB = path.join(os.homedir(), `.dieyun-sbx-b-${process.pid}-${Date.now()}`);
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      const before = asks.length;
      await rpc(gateway, 'host.exec', { command: `echo hi > "${path.join(dirA, 'a.txt')}"`, cwd: ws });
      assert(asks.length === before + 1, `dirA shell write asks once, got ${asks.length - before}`);
      await rpc(gateway, 'host.exec', { command: `echo hi > "${path.join(dirA, 'b.txt')}"`, cwd: ws });
      assert(asks.length === before + 1, `same-dir shell write must not ask again, got ${asks.length - before}`);
      const resB = await rpc(gateway, 'host.exec', {
        command: `echo hi > "${path.join(dirB, 'c.txt')}"`,
        cwd: ws
      });
      assert(
        asks.length === before + 2,
        `换个目录必须重新问（类别级退化会让它免问），got ${asks.length - before} asks`
      );
      assert(resB.ok, 'approved second dir runs');
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }

    // 7b) host.exec 里的引号必须原样到达 cmd.exe（带空格路径不许被转义成 \"）
    {
      const spacedDir = path.join(tmp, 'with space');
      fs.mkdirSync(spacedDir, { recursive: true });
      const marker = path.join(spacedDir, 'quoted.txt');
      const res = await rpc(gateway, 'host.exec', {
        command: `echo "quoted ok" > "${marker}"`,
        cwd: ws
      });
      assert(res.ok, `quoted shell write ok: ${res.ok ? '' : res.error && res.error.message}`);
      assert(fs.existsSync(marker), 'quoted path with spaces is written');
      assert(
        String(fs.readFileSync(marker, 'utf8')).includes('quoted ok'),
        'quotes are not mangled into backslash-quotes'
      );
    }

    // 8) host.exec：只读命令在任何档位都不问
    {
      for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
        gateway.setPermissions({ sandboxMode: mode });
        const before = asks.length;
        const res = await rpc(gateway, 'host.exec', { command: 'echo hi', cwd: ws });
        assert(res.ok, `${mode}: read command ok`);
        assert(asks.length === before, `${mode}: read command must not ask`);
      }
    }

    // 9) danger-full-access：主目录可写且不问
    {
      gateway.setPermissions({ sandboxMode: 'danger-full-access' });
      assert(gateway.getPermissions().unrestrictedPaths === true, 'danger mode derives unrestrictedPaths');
      gateway.sandboxApprovals.clearAll();
      const before = asks.length;
      const res = await rpc(gateway, 'fs.write_file', { filePath: outsideFile, data: 'z' });
      assert(res.ok, 'danger mode writes outside without asking');
      assert(asks.length === before, 'danger mode does not ask');
    }

    // 10) 状态 RPC + 历史配置迁移（只有 unrestrictedPaths 的旧文件）
    {
      const st = await rpc(gateway, 'permissions.sandbox_state', {});
      assert(st.ok && st.value.mode === 'danger-full-access', 'sandbox_state rpc reflects mode');
      const { normalizePermissions } = require('../src/gateway/permissions-store');
      const migrated = normalizePermissions({ unrestrictedPaths: true });
      assert(migrated.sandboxMode === 'danger-full-access', 'legacy flag migrates to danger mode');
      const back = normalizePermissions({ sandboxMode: 'read-only', unrestrictedPaths: true });
      assert(
        back.sandboxMode === 'danger-full-access',
        'explicit unrestrictedPaths wins (it is an explicit user action, not a stale view)'
      );
      const narrowed = normalizePermissions({ sandboxMode: 'read-only', unrestrictedPaths: false });
      assert(narrowed.sandboxMode === 'read-only', 'stale false does not widen the mode');
    }

    // 11) 档位收紧要作废已有批准：否则「我刚切到只读」之后旧批准照样放行
    {
      gateway.setPermissions({ sandboxMode: 'workspace-write' });
      gateway.sandboxApprovals.clearAll();
      gateway.setSandboxApprovalChannel(async (payload) => {
        asks.push(payload);
        return true;
      });
      const target = path.join(outsideDir, 'tighten.txt');
      const ok = await rpc(gateway, 'fs.write_file', { filePath: target, data: 'a' });
      assert(ok.ok, 'write approved in workspace-write');
      const beforeTighten = asks.length;
      gateway.setPermissions({ sandboxMode: 'read-only' });
      const afterTighten = await rpc(gateway, 'fs.write_file', { filePath: target, data: 'b' });
      assert(
        asks.length === beforeTighten + 1,
        `narrowing the mode must ask again, got ${asks.length - beforeTighten} prompts`
      );
      assert(afterTighten.ok, 're-approval still lets the write through');
    }

    // 12) 没有审批通道时错误码要如实说明「没人可问」，不能用"用户拒绝"
    {
      gateway.setPermissions({ sandboxMode: 'read-only' });
      gateway.sandboxApprovals.clearAll();
      gateway.setSandboxApprovalChannel(null);
      const res = await rpc(gateway, 'fs.write_file', { filePath: path.join(ws, 'no-channel.txt'), data: 'x' });
      assert(errCode(res) === 'SANDBOX_NO_CHANNEL', `no-channel code, got ${errCode(res)}`);
      assert(/确认通道/.test(String(res.error && res.error.message)), 'message explains nobody could answer');
      gateway.setSandboxApprovalChannel(async (payload) => {
        asks.push(payload);
        return true;
      });
    }
  } finally {
    await stop();
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log('ok sandbox gateway tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

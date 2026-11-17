'use strict';

/**
 * 冒烟：Local Gateway + runWorkspaceRoot、compaction 分 session
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTestLocalGateway } = require('./lib/test-gateway-harness.cjs');
const { createMainCompactionAgent, applyToolSchemaDeduction } = require('../src/agent/compaction-main');
const { createSshCredentialsStore } = require('../src/ssh/credentials-store');

function fileText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.data === 'string') return result.data;
  if (typeof result.content === 'string') return result.content;
  return JSON.stringify(result);
}

async function testRunWorkspaceRootSwitch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-'));
  const wsA = path.join(tmp, 'proj-a');
  const wsB = path.join(tmp, 'proj-b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsA, 'marker.txt'), 'A', 'utf8');
  fs.writeFileSync(path.join(wsB, 'marker.txt'), 'B', 'utf8');

  const { gateway, stop } = createTestLocalGateway(wsA);
  try {
    const rA = await gateway.invokeRpc('fs.read_file', {
      filePath: 'marker.txt',
      runWorkspaceRoot: wsA
    });
    const rB = await gateway.invokeRpc('fs.read_file', {
      filePath: 'marker.txt',
      runWorkspaceRoot: wsB
    });
    const textA = fileText(rA);
    const textB = fileText(rB);
    if (!textA.includes('A')) throw new Error(`proj-a read got: ${textA.slice(0, 40)}`);
    if (!textB.includes('B')) throw new Error(`proj-b read got: ${textB.slice(0, 40)}`);
    console.log('ok runWorkspaceRoot sequential reads');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testConcurrentRunWorkspaceRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-c-'));
  const wsA = path.join(tmp, 'proj-a');
  const wsB = path.join(tmp, 'proj-b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsA, 'marker.txt'), 'A', 'utf8');
  fs.writeFileSync(path.join(wsB, 'marker.txt'), 'B', 'utf8');

  const { gateway, stop } = createTestLocalGateway(wsA);
  try {
    const slow = gateway.invokeRpc('fs.list_dir', { dirPath: '.', runWorkspaceRoot: wsA });
    await new Promise((r) => setTimeout(r, 2));
    const rB = await gateway.invokeRpc('fs.read_file', {
      filePath: 'marker.txt',
      runWorkspaceRoot: wsB
    });
    await slow;
    const textB = fileText(rB);
    if (!textB.includes('B')) throw new Error(`concurrent proj-b read got: ${textB.slice(0, 40)}`);
    console.log('ok concurrent runWorkspaceRoot (overlap)');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testCompactionPerSession() {
  const agent = createMainCompactionAgent(os.tmpdir(), null);
  let threw = false;
  try {
    await agent.maybeCompactMessages([{ role: 'user', content: 'hi' }], { sessionId: 's1' });
  } catch (e) {
    if (e.code === 'RUST_CORE_UNAVAILABLE') threw = true;
    else throw e;
  }
  if (!threw) throw new Error('expected RUST_CORE_UNAVAILABLE without core');
  // 折叠没有每会话状态可重置（旧 cumulativeSummary / 冷却计数已删除）
  if (agent.resetCompactionState) throw new Error('per-session compaction state should be gone');
  console.log('ok compaction agent surface (no per-session state)');
}

/**
 * 折叠器 RPC 出错 → 软跳过（不阻断这一轮），且**没有**冷却计数这回事：
 * 折叠是本地纯 CPU，下一次触发判定仍然只看预算与 usage。
 */
async function testCompactionRpcErrorSoftSkip() {
  let calls = 0;
  const agent = createMainCompactionAgent(os.tmpdir(), {
    isReady: () => true,
    async invoke(method) {
      if (method === 'compaction.fold') calls += 1;
      const err = new Error('dieyun-core 超时: compaction.fold');
      err.code = 'CORE_RPC_TIMEOUT';
      throw err;
    }
  });
  const runOnce = () =>
    agent.maybeCompactMessages([{ role: 'user', content: 'hi' }], { sessionId: 's-fold-err' });
  const cr = await runOnce();
  if (cr.compacted) throw new Error('rpc error should not compact');
  if (cr.foldSkipped !== 'rpc_error') {
    throw new Error(`expected rpc_error skip, got ${cr.foldSkipped}`);
  }
  await runOnce();
  if (calls !== 2) throw new Error(`每次调用都应重新问一次折叠器（期望 2，实际 ${calls}）`);
  console.log('ok compaction rpc error soft-skip');
}


/**
 * 工具 schema 占用真实窗口却不进 messages：只有「超出系统预留」的部分才从输入预算扣，
 * 且扣减不超过 base 的 25%（防止小窗口档被工具目录顶成每轮误压）。
 */
function testToolSchemaBudgetDeduction() {
  const base = 95232;
  const reserve = 16384;
  const eq = (got, want, label) => {
    if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`);
  };
  eq(applyToolSchemaDeduction(base, reserve, 0), base, 'no tools keeps base');
  // 52000 字符 ≈ 16250 tokens < reserve 16384：预留已覆盖，不扣
  eq(applyToolSchemaDeduction(base, reserve, 52000), base, 'tools within reserve');
  // 80000 字符 ≈ 25000 tokens，超出 8616 → 全额扣
  eq(applyToolSchemaDeduction(base, reserve, 80000), base - 8616, 'excess tools deducted');
  // 800000 字符 ≈ 250000 tokens，超出部分被 base*25% 封顶
  eq(applyToolSchemaDeduction(base, reserve, 800000), base - Math.floor(base * 0.25), 'deduction capped');
  // 小窗口档：扣到底也只能停在 8192 地板
  eq(applyToolSchemaDeduction(8192, 0, 100000), 8192, 'floor keeps 8192');
  console.log('ok tool schema budget deduction');
}

function testCredentialsRejectEmptyEncrypt() {
  const store = createSshCredentialsStore({
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => '', decryptString: () => '' },
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-cred-'))
  });
  let err = null;
  try {
    store.saveProfile({
      host: 'h',
      port: 22,
      username: 'u',
      remember: true,
      password: 'secret'
    });
  } catch (e) {
    err = e;
  }
  if (!err || err.code !== 'CREDENTIALS_ENCRYPT_UNAVAILABLE') {
    throw new Error(`expected CREDENTIALS_ENCRYPT_UNAVAILABLE, got ${err && err.code}`);
  }
  console.log('ok ssh credentials reject when !canEncrypt');
}

async function testSessionWorkspaceContextSwitch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-sess-'));
  const wsA = path.join(tmp, 'proj-a');
  const wsB = path.join(tmp, 'proj-b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsA, 'marker.txt'), 'A', 'utf8');
  fs.writeFileSync(path.join(wsB, 'marker.txt'), 'B', 'utf8');

  const { gateway, stop } = createTestLocalGateway(wsA);
  try {
    gateway.setSessionWorkspaceContext('sess-a', wsA);
    gateway.setSessionWorkspaceContext('sess-b', wsB);
    gateway.setActiveSession('sess-a');
    const rA = await gateway.invokeRpc('fs.read_file', { filePath: 'marker.txt' });
    gateway.setActiveSession('sess-b');
    const rB = await gateway.invokeRpc('fs.read_file', { filePath: 'marker.txt' });
    const textA = fileText(rA);
    const textB = fileText(rB);
    if (!textA.includes('A')) throw new Error(`sess-a read got: ${textA.slice(0, 40)}`);
    if (!textB.includes('B')) throw new Error(`sess-b read got: ${textB.slice(0, 40)}`);
    const ws = gateway.getWorkspace();
    if (!ws.workspacePath || !ws.workspacePath.includes('proj-b')) {
      throw new Error(`active session workspace expected proj-b, got ${ws.workspacePath}`);
    }
    console.log('ok session workspace context switch');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testActiveSessionNoGlobalFallback() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-p2-'));
  const wsGlobal = path.join(tmp, 'global');
  const wsB = path.join(tmp, 'proj-b');
  fs.mkdirSync(wsGlobal, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsGlobal, 'marker.txt'), 'GLOBAL', 'utf8');
  fs.writeFileSync(path.join(wsB, 'marker.txt'), 'B', 'utf8');

  const { gateway, stop } = createTestLocalGateway(wsGlobal);
  try {
    gateway.setSessionWorkspaceContext('sess-b', wsB);
    gateway.setActiveSession('sess-empty');
    let threw = false;
    try {
      await gateway.invokeRpc('fs.read_file', { filePath: 'marker.txt' });
    } catch {
      threw = true;
    }
    if (!threw) {
      const r = await gateway.invokeRpc('fs.read_file', { filePath: 'marker.txt' });
      const text = fileText(r);
      if (text.includes('GLOBAL')) {
        throw new Error('active session without workspace must not read global marker');
      }
    }
    gateway.setActiveSession('sess-b');
    const rB = await gateway.invokeRpc('fs.read_file', { filePath: 'marker.txt' });
    if (!fileText(rB).includes('B')) throw new Error(`sess-b read got: ${fileText(rB).slice(0, 40)}`);
    console.log('ok active session no global fallback');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testRpcSessionIdContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-p2s-'));
  const wsA = path.join(tmp, 'proj-a');
  const wsB = path.join(tmp, 'proj-b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsA, 'marker.txt'), 'A', 'utf8');
  fs.writeFileSync(path.join(wsB, 'marker.txt'), 'B', 'utf8');

  const { gateway, stop } = createTestLocalGateway(wsA);
  try {
    gateway.setSessionWorkspaceContext('sess-a', wsA);
    gateway.setSessionWorkspaceContext('sess-b', wsB);
    gateway.setActiveSession('sess-a');
    const rB = await gateway.invokeRpc('fs.read_file', {
      filePath: 'marker.txt',
      sessionId: 'sess-b'
    });
    if (!fileText(rB).includes('B')) {
      throw new Error(`sessionId ALS read got: ${fileText(rB).slice(0, 40)}`);
    }
    console.log('ok rpc sessionId workspace context');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 回归：绑定工作空间后，宽松档的本地根仍须留在**读**白名单里，否则工作空间不可写 /
 * 用户想在工作空间外读文件时会 PATH_NOT_ALLOWED（曾是 if/else 链把兜底目录吞掉）。
 *
 * 写白名单自沙箱档位上线后**不再包含用户主目录**：默认档「工作区内可写」把写入限制在
 * 工作区 + 内部目录 + 临时目录，越界要用户批一次（见 docs/SANDBOX.md）。
 */
async function testDefaultWorkspaceAlwaysInRoots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-def-'));
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const { gateway, stop } = createTestLocalGateway(ws);
  try {
    const {
      dieyunDefaultWorkspaceDir,
      dieyunUserHome,
      systemTempDir
    } = require('../src/agent-home');
    const norm = (p) => {
      const abs = path.resolve(p);
      return process.platform === 'win32' ? abs.toLowerCase() : abs;
    };
    const readRoots = gateway._collectReadRoots().map(norm);
    for (const want of [dieyunDefaultWorkspaceDir(), dieyunUserHome(), systemTempDir()]) {
      if (!readRoots.includes(norm(want))) {
        throw new Error(`可读白名单缺少本地宽松根：${want}`);
      }
    }

    const writeRoots = gateway._collectWritableRoots().map(norm);
    for (const want of [dieyunDefaultWorkspaceDir(), systemTempDir()]) {
      if (!writeRoots.includes(norm(want))) {
        throw new Error(`可写白名单缺少本地兜底根：${want}`);
      }
    }
    if (writeRoots.includes(norm(dieyunUserHome()))) {
      throw new Error('默认档（workspace-write）不应把用户主目录列入可写白名单');
    }

    // 完全放开档：主目录可写
    gateway.setPermissions({ sandboxMode: 'danger-full-access' });
    const dangerWrite = gateway._collectWritableRoots().map(norm);
    if (!dangerWrite.some((r) => norm(dieyunUserHome()).startsWith(r))) {
      throw new Error('完全放开档下用户主目录应可写');
    }

    console.log('ok local wide roots (default workspace / home / tmp) in read; write follows sandbox mode');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 回归：「完全放开路径限制」开关（默认关）。
 * 打开后本地白名单必须变成整盘卷根；关掉后必须回到宽松档（不能残留整盘）。
 */
async function testUnrestrictedPathsToggle() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-unrestricted-'));
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const { gateway, stop } = createTestLocalGateway(ws);
  const norm = (p) => {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  try {
    const before = gateway.getPermissions();
    if (before.unrestrictedPaths === true) throw new Error('缺省应为关闭（false）');

    const baselineRead = gateway._collectReadRoots().map(norm).sort();
    const baselineWrite = gateway._collectWritableRoots().map(norm).sort();

    const on = gateway.setPermissions({ ...before, unrestrictedPaths: true });
    if (on.unrestrictedPaths !== true) throw new Error('开关未能写入');
    const read = gateway._collectReadRoots().map(norm);
    const write = gateway._collectWritableRoots().map(norm);
    if (process.platform === 'win32') {
      const driveRe = /^[a-z]:\\$/;
      if (!read.length || !read.every((r) => driveRe.test(r))) {
        throw new Error(`Windows 放开档应为盘根，实际：${read.join(',')}`);
      }
      if (!write.length || !write.every((r) => driveRe.test(r))) {
        throw new Error(`Windows 放开档可写应为盘根，实际：${write.join(',')}`);
      }
    } else {
      if (read.join(',') !== '/' || write.join(',') !== '/') {
        throw new Error(`POSIX 放开档应为 /，实际：${read.join(',')} / ${write.join(',')}`);
      }
    }

    gateway.setPermissions({ ...before, unrestrictedPaths: false });
    const restoredRead = gateway._collectReadRoots().map(norm).sort();
    const restoredWrite = gateway._collectWritableRoots().map(norm).sort();
    if (restoredRead.join(',') !== baselineRead.join(',')) {
      throw new Error(`关闭开关后可读白名单未回到宽松档：${restoredRead.join(',')}`);
    }
    if (restoredWrite.join(',') !== baselineWrite.join(',')) {
      throw new Error(`关闭开关后可写白名单未回到宽松档：${restoredWrite.join(',')}`);
    }
    console.log('ok unrestricted paths toggle');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `invokeRpc` 会被**当普通函数**传下去：会话目标 / 计划 / 频道 / headless 的 deps 契约
 * 就写成 `{ invokeRpc: Function }`。脱离实例调用必须照常工作，否则 goal_start 这类
 * 工具会炸在 `this.handlers` 上（历史 bug：Cannot read properties of undefined）。
 */
async function testDetachedInvokeRpc() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-smoke-detached-'));
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'marker.txt'), 'x', 'utf8');
  const { gateway, stop } = createTestLocalGateway(ws);
  try {
    const { invokeRpc } = gateway;
    if (typeof invokeRpc !== 'function') throw new Error('invokeRpc 不是函数');
    const r = await invokeRpc('fs.read_file', { filePath: 'marker.txt', runWorkspaceRoot: ws });
    if (!fileText(r).includes('x')) {
      throw new Error(`detached invokeRpc got: ${fileText(r).slice(0, 40)}`);
    }
    console.log('ok detached invokeRpc');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await testRunWorkspaceRootSwitch();
  await testConcurrentRunWorkspaceRoot();
  await testSessionWorkspaceContextSwitch();
  await testActiveSessionNoGlobalFallback();
  await testRpcSessionIdContext();
  await testCompactionPerSession();
  await testCompactionRpcErrorSoftSkip();
  await testDetachedInvokeRpc();
  testToolSchemaBudgetDeduction();
  testCredentialsRejectEmptyEncrypt();
  await testDefaultWorkspaceAlwaysInRoots();
  await testUnrestrictedPathsToggle();
  console.log('\nlocal-gateway-smoke: ALL OK');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});

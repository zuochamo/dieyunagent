'use strict';

/**
 * 冒烟：Local Gateway + runWorkspaceRoot、compaction 分 session
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTestLocalGateway } = require('./lib/test-gateway-harness.cjs');
const { createMainCompactionAgent } = require('../src/agent/compaction-main');
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
  agent.resetCompactionState('s1');
  console.log('ok compaction session-scoped API');
}

async function testCompactionTimeoutSoftSkip() {
  const agent = createMainCompactionAgent(os.tmpdir(), {
    isReady: () => true,
    async invoke(method) {
      if (method === 'memory.compaction_recent') return [];
      const err = new Error('dieyun-core 超时: compaction.maybe_compact');
      err.code = 'CORE_RPC_TIMEOUT';
      throw err;
    }
  });
  const cr = await agent.maybeCompactMessages([{ role: 'user', content: 'hi' }], {
    sessionId: 's-timeout',
    apiConfig: { baseUrl: 'https://example/v1', apiKey: 'k' }
  });
  if (cr.compacted) throw new Error('timeout should not compact');
  if (cr.compactionSkipped !== 'llm_error') throw new Error(`expected llm_error skip, got ${cr.compactionSkipped}`);
  console.log('ok compaction timeout soft-skip');
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

async function main() {
  await testRunWorkspaceRootSwitch();
  await testConcurrentRunWorkspaceRoot();
  await testSessionWorkspaceContextSwitch();
  await testActiveSessionNoGlobalFallback();
  await testRpcSessionIdContext();
  await testCompactionPerSession();
  await testCompactionTimeoutSoftSkip();
  testCredentialsRejectEmptyEncrypt();
  console.log('\nlocal-gateway-smoke: ALL OK');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});

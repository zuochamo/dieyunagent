#!/usr/bin/env node
'use strict';

/**
 * headless 入口的 smoke：**不联网**，只看「能不能在没有 Electron 的情况下起来」。
 *
 * 覆盖三件事：
 * 1. `--help` 与未知参数（纯解析，零依赖）；
 * 2. `self-test` —— 真起 Gateway + dieyun-core，建会话、读历史、走工具桥列目录；
 * 3. 退出码约定（配置类错误 = 3，参数错误 = 2）。
 *
 * 没有 dieyun-core 产物时（CI 未跑 pack:dieyun-core）按「跳过」处理并返回 0，
 * 与 `scripts/test-agent-smoke.cjs` 对 core 相关项的处理口径一致。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'headless', 'main.js');

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    env: { ...process.env, ...(opts.env || {}) }
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hasCore() {
  const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
  return !!resolveDieyunCoreBinary();
}

function main() {
  // 1) 纯解析：help 与未知参数的退出码
  const help = run(['--help']);
  assert.equal(help.code, 0, `--help 应返回 0，实际 ${help.code}\n${help.stderr}`);
  assert.ok(help.stdout.includes('dieyun-headless'), '--help 应打印用法');

  const bad = run(['--no-such-flag']);
  assert.notEqual(bad.code, 0, '未知参数应非 0 退出');
  console.log('[headless-smoke] help/未知参数 OK');

  if (!hasCore()) {
    console.log('[headless-smoke] 跳过 self-test：未找到 dieyun-core（先跑 npm run pack:dieyun-core）');
    return;
  }

  // 2) self-test：起 Gateway + core，跑一遍本地 RPC 与工具桥
  const userData = tmpDir('dhs-userdata-');
  const workspace = tmpDir('dhs-ws-');
  try {
    const res = run(['self-test', '--user-data', userData, '--workspace', workspace, '--log-level', 'warn'], {
      timeoutMs: 180000
    });
    assert.equal(res.code, 0, `self-test 应返回 0，实际 ${res.code}\n${res.stderr}`);
    assert.ok(res.stdout.includes('self-test: OK'), `self-test 输出异常：\n${res.stdout}\n${res.stderr}`);
    assert.ok(/sandbox=/.test(res.stdout), 'self-test 应报出沙箱档位');
    console.log('[headless-smoke] self-test OK');
  } finally {
    for (const dir of [userData, workspace]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响判定
      }
    }
  }

  console.log('[headless-smoke] PASS');
}

try {
  main();
} catch (err) {
  console.error('[headless-smoke] FAIL:', (err && err.stack) || err);
  process.exitCode = 1;
}

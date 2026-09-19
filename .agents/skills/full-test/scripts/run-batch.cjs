#!/usr/bin/env node
'use strict';

/**
 * 逐个运行 npm scripts 测试套件并输出 PASS/FAIL 汇总；单个失败不中断后续。
 * 失败自动重跑一次再定论（端口/时序抖动常见）；超时杀整棵进程树。
 *
 * 用法: node run-batch.cjs [--timeout MS] [--no-retry] suite1 suite2 ...
 */

const { spawn } = require('child_process');

function parseArgs(argv) {
  const opts = { timeout: 10 * 60 * 1000, retry: true, suites: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--no-retry') opts.retry = false;
    else opts.suites.push(a);
  }
  return opts;
}

function runOne(suite, timeout) {
  return new Promise((resolve) => {
    if (!/^[A-Za-z0-9:_-]+$/.test(suite)) {
      resolve({ suite, code: 2, out: `[batch] 非法套件名: ${suite}` });
      return;
    }
    const child = spawn(`npm run -s ${suite}`, { shell: true, windowsHide: true });
    let out = '';
    const cap = (d) => {
      out += d;
      if (out.length > 20000) out = out.slice(-20000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ suite, code, out });
    };
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
      finish(124);
    }, timeout);
    child.on('exit', (code) => finish(code ?? -1));
    child.on('error', (e) => finish(-1));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.suites.length) {
    console.error('用法: node run-batch.cjs [--timeout MS] [--no-retry] suite1 suite2 ...');
    process.exit(2);
  }
  const fails = [];
  for (const suite of opts.suites) {
    let r = await runOne(suite, opts.timeout);
    if (r.code !== 0 && opts.retry) {
      console.log(`RETRY ${suite}`);
      r = await runOne(suite, opts.timeout);
    }
    if (r.code === 0) {
      console.log(`PASS ${suite}`);
    } else {
      console.log(`FAIL(${r.code}) ${suite}`);
      const tail = r.out.trim().split(/\r?\n/).slice(-6).join('\n');
      if (tail) console.log(tail);
      fails.push(suite);
    }
  }
  const ok = opts.suites.length - fails.length;
  console.log(`\n[batch] ${ok}/${opts.suites.length} 通过${fails.length ? '；失败: ' + fails.join(', ') : ''}`);
  process.exit(fails.length ? 1 : 0);
}

main();

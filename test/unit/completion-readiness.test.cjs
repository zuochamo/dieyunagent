'use strict';

/**
 * 完成验收（Main 单一来源）：证据只认结构字段，判定只出提示。
 *
 * 反例集（原 Renderer 实现踩过的坑，这里逐条钉住）：
 * - 退出码只能从 `result.code` 读，不能从 summary 文本里正则抠 "exit N"
 * - `browser_expect` 只看最后一次（先失败、修完重跑通过不能被判成没做完）
 * - 纯浏览器任务没有写入信号，运行时错误不能被「无证据即跳过」吞掉
 * - 「没有证据」永远不该变成拦住交付的理由（网关挂掉、LSP 没开都只是少一条证据）
 */

const path = require('path');
const readiness = require('../../src/agent/completion-readiness');

function traceOf(...rounds) {
  return rounds.map((tools, idx) => ({ round: idx + 1, thought: '', tools }));
}

const editTool = (filePath) => ({ name: 'fs_edit', toolArgs: { filePath, oldString: 'a', newString: 'b' } });

describe('collectEvidence：只吃结构字段', () => {
  test('host_exec 的退出码取自 result.code，而不是 summary 里的文本', () => {
    const ev = readiness.collectEvidence(
      traceOf([
        {
          name: 'host_exec',
          toolArgs: { command: 'npm test' },
          // summary 里写着 exit 0，但真实退出码是 1：以 result.code 为准
          summary: 'exit 0 · 3 tests failed',
          result: { code: 1, stdout: 'fail', stderr: '' }
        }
      ])
    );
    expect(ev.failedValidations).toHaveLength(1);
    expect(ev.failedValidations[0]).toEqual({ name: 'host_exec', exitCode: 1 });
  });

  test('result.code = 0 的验证命令计入通过，不是失败', () => {
    const ev = readiness.collectEvidence(
      traceOf([
        {
          name: 'host_exec',
          toolArgs: { command: 'npm run check:renderer' },
          summary: 'exit 1', // 文本噪声
          result: { code: 0 }
        }
      ])
    );
    expect(ev.failedValidations).toHaveLength(0);
    expect(ev.passedValidation).toBe(1);
  });

  test('写文件工具提供写入信号与路径；host_exec 写命令按命令内容识别', () => {
    const ev = readiness.collectEvidence(
      traceOf([editTool('src/a.js')], [
        { name: 'host_exec', toolArgs: { command: 'Set-Content out.txt "x"' }, result: { code: 0 } }
      ])
    );
    expect(ev.hasWriteSignal).toBe(true);
    expect(ev.filePaths).toEqual(['src/a.js']);
    expect(ev.writeTools).toEqual(expect.arrayContaining(['fs_edit', 'host_exec']));
  });

  test('只读 host_exec 不算写入信号', () => {
    const ev = readiness.collectEvidence(
      traceOf([{ name: 'host_exec', toolArgs: { command: 'git status' }, result: { code: 0 } }])
    );
    expect(ev.hasWriteSignal).toBe(false);
    expect(ev.filePaths).toEqual([]);
  });

  test('失败的工具（error 字段）也算失败', () => {
    const ev = readiness.collectEvidence(
      traceOf([{ name: 'fs_edit', toolArgs: { filePath: 'a.js' }, error: 'oldString not found' }])
    );
    expect(ev.writeTools).toContain('fs_edit');
    expect(readiness.toolFailed({ name: 'fs_edit', error: 'boom' }, 'fs_edit')).toBe(true);
  });

  test('结果对象的 ok:false 也算失败（浏览器断言/网关工具都用这个形状）', () => {
    expect(readiness.toolFailed({ name: 'browser_expect', result: { ok: false, failed: 1 } }, 'browser_expect')).toBe(
      true
    );
    expect(readiness.toolFailed({ name: 'fs_write_file', result: { ok: false, error: '磁盘已满' } }, 'fs_write_file')).toBe(
      true
    );
    expect(readiness.toolFailed({ name: 'fs_write_file', result: { ok: true } }, 'fs_write_file')).toBe(false);
  });

  test('写入失败的文件不进诊断清单（那里的既有 error 不是本轮的账）', () => {
    const ev = readiness.collectEvidence(
      traceOf([{ name: 'fs_edit', toolArgs: { filePath: 'old.js' }, error: '未找到唯一匹配' }])
    );
    expect(ev.hasWriteSignal).toBe(true);
    expect(ev.filePaths).toEqual([]);
  });
});

describe('evaluateReadiness：判定顺序与语义', () => {
  const writeEvidence = () => readiness.collectEvidence(traceOf([editTool('src/a.js')]));

  test('没有任何写入信号 → 跳过（不提示、不挡交付）', () => {
    const ev = readiness.collectEvidence(traceOf([{ name: 'fs_read_file', toolArgs: { filePath: 'a' } }]));
    const r = readiness.evaluateReadiness(ev, {});
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.note).toBe('');
  });

  test('纯浏览器任务：运行时错误在有写入信号之前就判', () => {
    const ev = readiness.collectEvidence(traceOf([{ name: 'browser_navigate' }]));
    const r = readiness.evaluateReadiness(ev, {
      browser: { used: true, errorCount: 1, consoleErrorCount: 1, networkErrorCount: 0, errors: ['[pageerror] boom'] }
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('browser_runtime_errors');
    expect(r.note).toContain('浏览器');
    expect(r.note).toContain('boom');
    expect(r.shouldRetry).toBe(false);
    expect(r.surfaceToUser).toBe(true);
  });

  test('browser_expect 只看最后一次：失败后重跑通过不算未完成', () => {
    const ev = readiness.collectEvidence(
      traceOf(
        [
          {
            name: 'browser_expect',
            result: {
              ok: false,
              total: 1,
              passed: 0,
              failed: 1,
              results: [{ kind: 'text', pass: false, expected: '登录', actual: '登录中' }]
            }
          }
        ],
        [{ name: 'browser_expect', result: { ok: true, total: 1, passed: 1, failed: 0, results: [{ kind: 'text', pass: true }] } }]
      )
    );
    const r = readiness.evaluateReadiness(ev, { browser: { used: true, errorCount: 0, errors: [] } });
    expect(r.ok).toBe(true);
  });

  test('最后一次断言未通过 → 提示（真形状：ok:false 且不带 error）', () => {
    const ev = readiness.collectEvidence(
      traceOf([
        {
          name: 'browser_expect',
          result: { ok: true, total: 2, passed: 2, failed: 0, results: [{ kind: 'text', pass: true }, { kind: 'visible', pass: true }] }
        },
        {
          name: 'browser_expect',
          result: {
            ok: false,
            total: 2,
            passed: 1,
            failed: 1,
            results: [
              { id: 'login', kind: 'text', pass: false, expected: '登录', actual: '登录中' },
              { kind: 'visible', pass: true }
            ]
          }
        }
      ])
    );
    const r = readiness.evaluateReadiness(ev, { browser: { used: true, errorCount: 0, errors: [] } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('browser_expect_failed');
    expect(r.note).toContain('browser_expect');
    expect(r.note).toContain('login');
    expect(r.note).toContain('期望 登录');
  });

  test('断言根本没跑起来（ref 过期）也算没验完', () => {
    const ev = readiness.collectEvidence(
      traceOf([{ name: 'browser_expect', result: { ok: false, error: 'ref 已过期', errorCode: 'REF_STALE', results: [] } }])
    );
    const r = readiness.evaluateReadiness(ev, { browser: { used: true, errorCount: 0, errors: [] } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('browser_expect_failed');
    expect(r.note).toContain('ref 已过期');
  });

  test('空断言（total=0）不算失败', () => {
    const ev = readiness.collectEvidence(
      traceOf([{ name: 'browser_expect', result: { ok: false, total: 0, passed: 0, failed: 0, results: [] } }])
    );
    const r = readiness.evaluateReadiness(ev, { browser: { used: true, errorCount: 0, errors: [] } });
    expect(r.ok).toBe(true);
  });

  test('写后静态诊断有 error → 提示（带处数与首条）', () => {
    const r = readiness.evaluateReadiness(writeEvidence(), {
      diagnostics: { hasErrors: true, errorCount: 2, samples: ['src/a.js:3 Cannot find name b'] }
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('diagnostic_errors');
    expect(r.note).toContain('2 处');
    expect(r.note).toContain('src/a.js:3');
  });

  test('验证失败且没有通过的验证 → 提示（带 exit code）', () => {
    const ev = readiness.collectEvidence(
      traceOf([editTool('src/a.js')], [
        { name: 'host_exec', toolArgs: { command: 'npm test' }, result: { code: 2 } }
      ])
    );
    const r = readiness.evaluateReadiness(ev, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('validation_failed');
    expect(r.note).toContain('exit 2');
  });

  test('静态诊断干净不能抵消验证失败（诊断只覆盖写过的文件）', () => {
    const ev = readiness.collectEvidence(
      traceOf([editTool('src/a.js')], [{ name: 'host_exec', toolArgs: { command: 'npm test' }, result: { code: 1 } }])
    );
    const r = readiness.evaluateReadiness(ev, { diagnostics: { hasErrors: false, errorCount: 0, samples: [] } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('validation_failed');
    expect(r.note).toContain('exit 1');
  });

  test('先跑通、后面另一条腿挂了 → 提示', () => {
    const ev = readiness.collectEvidence(
      traceOf(
        [editTool('src/a.js'), { name: 'host_exec', toolArgs: { command: 'npm test' }, result: { code: 0 } }],
        [{ name: 'host_exec', toolArgs: { command: 'npm run lint' }, result: { code: 2 } }]
      )
    );
    const r = readiness.evaluateReadiness(ev, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('validation_failed');
    expect(r.note).toContain('exit 2');
  });

  test('失败后又跑通 → 不提示', () => {
    const ev = readiness.collectEvidence(
      traceOf(
        [editTool('src/a.js'), { name: 'host_exec', toolArgs: { command: 'npm test' }, result: { code: 1 } }],
        [{ name: 'host_exec', toolArgs: { command: 'npm test' }, result: { code: 0 } }]
      )
    );
    const r = readiness.evaluateReadiness(ev, {});
    expect(r.ok).toBe(true);
  });
});

describe('evaluateTurnReadiness：采集与降级', () => {
  const fakeGateway = (handlers) => ({
    calls: [],
    async invokeRpc(method, params) {
      this.calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`unexpected rpc ${method}`);
      return typeof h === 'function' ? h(params) : h;
    }
  });

  const writeTrace = traceOf([editTool('src/a.js')]);

  test('explore 只读：连证据都不采（不查诊断/浏览器）', async () => {
    const gateway = fakeGateway({});
    const r = await readiness.evaluateTurnReadiness({ gateway, trace: writeTrace, mode: 'explore' });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(gateway.calls).toHaveLength(0);
  });

  test('静态诊断走 workspace.diagnostics，浏览器证据走 browser.console/network', async () => {
    const gateway = fakeGateway({
      'workspace.diagnostics': { ok: true, items: [{ file: 'src/a.js', diagnostics: [] }] },
      'browser.console': { entries: [] },
      'browser.network': { entries: [] }
    });
    const r = await readiness.evaluateTurnReadiness({
      gateway,
      trace: traceOf([editTool('src/a.js'), { name: 'browser_navigate' }]),
      sessionId: 's1',
      workspacePath: 'E:/ws',
      userDataPath: path.join(__dirname, '../../.tmp-nonexistent-userdata')
    });
    const methods = gateway.calls.map((c) => c.method);
    expect(methods).toContain('workspace.diagnostics');
    expect(methods).toContain('browser.console');
    expect(methods).toContain('browser.network');
    const diagCall = gateway.calls.find((c) => c.method === 'workspace.diagnostics');
    expect(diagCall.params.files).toEqual(['src/a.js']);
    expect(diagCall.params.sessionId).toBe('s1');
    // 只统计 error 级，就只要 error 级：请求 warning 会让每文件上限被 warning 占满、error 被截掉
    expect(diagCall.params.minSeverity).toBe('error');
    expect(r.ok).toBe(true);
    expect(r.evidence.diagnostics).toEqual({ hasErrors: false, errorCount: 0, samples: [] });
  });

  test('浏览器证据按本轮开始时刻切时间窗（账本按会话累计，不自动清空）', async () => {
    const gateway = fakeGateway({
      'workspace.diagnostics': { ok: true, items: [] },
      'browser.console': { entries: [] },
      'browser.network': { entries: [] }
    });
    await readiness.evaluateTurnReadiness({
      gateway,
      trace: traceOf([editTool('src/a.js'), { name: 'browser_navigate' }]),
      sessionId: 's1',
      userDataPath: path.join(__dirname, '../../.tmp-nonexistent-userdata'),
      startedAt: Date.now() - 5000
    });
    for (const method of ['browser.console', 'browser.network']) {
      const call = gateway.calls.find((c) => c.method === method);
      expect(call.params.sessionId).toBe('s1');
      expect(call.params.sinceMs).toBeGreaterThanOrEqual(4900);
    }
  });

  test('网关报错时降级为「没有这条证据」，不抛、不拦交付', async () => {
    const gateway = {
      async invokeRpc() {
        throw new Error('gateway down');
      }
    };
    const r = await readiness.evaluateTurnReadiness({
      gateway,
      trace: writeTrace,
      userDataPath: path.join(__dirname, '../../.tmp-nonexistent-userdata')
    });
    expect(r.ok).toBe(true);
    expect(r.evidence.diagnostics).toBeNull();
  });

  test('没有 gateway 也不崩（沙箱/离线场景）', async () => {
    const r = await readiness.evaluateTurnReadiness({ gateway: null, trace: writeTrace });
    expect(r.ok).toBe(true);
  });
});

'use strict';
/**
 * `fs.read_symbol` 在 SSH 工作区的符号定位顺序（`src/gateway/handlers/fs.js`）。
 *
 * 锁死两件事，都是实测代价：
 *   1. **给了符号名就别先问远程 LSP**：结构索引按名就能给出 startLine/endLine
 *      （docs/INDEX-VALUE-REVIEW.md §7.2 实测 20/20），远程 LSP 只是同一条结论的
 *      更慢路径 —— 遥测里三次「成功」的 read_symbol 分别花了 20012 / 20017 / 45072ms，
 *      全是这段空等（§7.5）。
 *   2. **没给名字时仍必须试远程 LSP**：`filePath + line` 找「包含该行的最内层符号」
 *      是结构索引替代不了的唯一场景，跳过它等于悄悄砍掉能力。
 *   3. 顺带锁死超时预算：它是「白等多久」的唯一旋钮，回退 20s 就立刻复发。
 */
const assert = require('node:assert/strict');
const { createFsHandlers } = require('../../src/gateway/handlers/fs');

/** 远程 LSP 超时预算上限：超过这个数就是用户可感知的空等 */
const MAX_REMOTE_LSP_TIMEOUT_MS = 5000;

function buildHandlers({ sourceText }) {
  const rpcCalls = [];
  const lspTimeouts = [];
  const handlers = createFsHandlers({
    perms: { hostControl: true, fsRead: true },
    // 新契约：handler 读**调用作用域**的 target（resolveCallWorkspaceTarget），不是视图的 getWorkspaceTarget
    resolveCallWorkspaceTarget: () => ({ kind: 'ssh', remotePath: '/w' }),
    ctx: {},
    normalizeFilePathInput: (p) => String(p || ''),
    cwdForCall: () => '/w',
    // 远程 agent「可用」的唯一判据是 info.openChannel（remote-agent-client）
    getRemoteAgentInfo: () => ({ openChannel: async () => ({}) }),
    getRemoteAgentClient: () => ({
      call: async (method, _params, timeoutMs) => {
        rpcCalls.push(method);
        if (method === 'lsp.query') {
          lspTimeouts.push(Number(timeoutMs) || 0);
          // 远程 LSP 冷启动不可用：真实链路里超时后也是这样回落结构索引
          return { ok: false, errorCode: 'LSP_UNAVAILABLE' };
        }
        return { ok: true };
      }
    }),
    getRemoteFs: () => ({ readFile: async () => sourceText }),
    resolveCodebaseContext: () => ({ rootHash: 'x' }),
    invokeIndexCore: async (_ctx, method, params) => {
      rpcCalls.push(method);
      return {
        results: [{ name: params.query, path: 'src/a.js', startLine: 1, endLine: 3 }]
      };
    },
    grepViaRemoteExec: async (cwd, opts) => {
      rpcCalls.push('grep(remote)');
      return { matches: [{ path: 'src/a.js', line: 1, text: `${opts.pattern} function foo() {` }] };
    }
  });
  return { handlers, rpcCalls, lspTimeouts };
}

const SOURCE = ['function foo() {', '  return 1;', '}', '', 'const x = 2;', ''].join('\n');

describe('read_symbol 在 SSH 下的定位顺序', () => {
  it('给了 name：不问远程 LSP，直接用结构索引', async () => {
    const { handlers, rpcCalls, lspTimeouts } = buildHandlers({ sourceText: SOURCE });
    const res = await handlers['fs.read_symbol']({ filePath: 'src/a.js', name: 'foo' });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.source, 'graph');
    assert.ok(rpcCalls.includes('graph.symbol_search'), '结构索引被调用');
    assert.ok(!rpcCalls.includes('lsp.query'), '给了 name 时不该打远程 LSP（每次白等 3-20 秒）');
    assert.equal(lspTimeouts.length, 0);
  });

  it('只给 filePath + line：仍然问远程 LSP（结构索引替代不了的场景）', async () => {
    const { handlers, rpcCalls, lspTimeouts } = buildHandlers({ sourceText: SOURCE });
    // 第 5 行是 `const x = 2;`：行内标识符能被 grep 兜底接住（`return` 这类关键字会被跳过）
    const res = await handlers['fs.read_symbol']({ filePath: 'src/a.js', line: 5 });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.source, 'grep-remote', '远程 LSP 不可用时落到 grep 兜底');
    assert.ok(rpcCalls.includes('lsp.query'), '「包含第 N 行的最内层符号」只能靠远程 LSP 起步');
    assert.equal(lspTimeouts.length, 1);
    assert.ok(
      lspTimeouts[0] > 0 && lspTimeouts[0] <= MAX_REMOTE_LSP_TIMEOUT_MS,
      `远程 LSP 超时预算必须 ≤ ${MAX_REMOTE_LSP_TIMEOUT_MS}ms（实测 20012ms 的空等就是它），实际 ${lspTimeouts[0]}`
    );
  });
});

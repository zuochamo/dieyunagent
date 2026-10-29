'use strict';

/**
 * 远端 exec 的契约必须与本机 runShell 是同一份（`src/exec-limits.js`）。
 *
 * 三条历史事故一次钉住：
 *  1. 远端把超时夹成 180s（工具 schema 允许 600s）→ 长构建在远端必失败、在本地必成功；
 *  2. `c.exec` 回调没有 settled 守卫 → 超时已经报错之后，命令照样在远端跑起来；
 *  3. `connectOne` 返回后到 `client = conn` 之间失败时，没有销毁那条已认证连接。
 *
 * 2/3 都在 async 的 ssh2 客户端内部，没有注入点，因此用「源码不变式」锁住形状 ——
 * 与仓库里既有的形态守卫（remote-gateway-lifecycle 等）一致。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EXEC_TIMEOUT_DEFAULT_MS,
  EXEC_TIMEOUT_MAX_MS,
  EXEC_OUTPUT_MAX_CHARS,
  clampExecTimeoutMs
} = require('../../src/exec-limits');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('exec 超时契约（唯一来源 src/exec-limits.js）', () => {
  it('默认 90s，上限 600s，与工具 schema 的 max 一致', () => {
    assert.equal(EXEC_TIMEOUT_DEFAULT_MS, 90000);
    assert.equal(EXEC_TIMEOUT_MAX_MS, 600000);
    assert.ok(EXEC_OUTPUT_MAX_CHARS >= 64 * 1024, '输出上限不能小到截掉正常编译输出');
  });

  it('clamp：未给 / 非法走默认，超上限被夹到 600s，过小抬到 1s', () => {
    assert.equal(clampExecTimeoutMs(undefined), 90000);
    assert.equal(clampExecTimeoutMs(0), 90000);
    assert.equal(clampExecTimeoutMs('abc'), 90000);
    assert.equal(clampExecTimeoutMs(180000), 180000);
    assert.equal(clampExecTimeoutMs(600000), 600000);
    assert.equal(clampExecTimeoutMs(10 * 60 * 1000 + 1), 600000);
    assert.equal(clampExecTimeoutMs('300000'), 300000);
    assert.equal(clampExecTimeoutMs(10), 1000);
  });

  it('session-manager 用共享 clamp，不再自己写 180000', () => {
    const src = read('src/ssh/session-manager.js');
    assert.match(src, /clampExecTimeoutMs\(timeoutMs\)/, '远端 exec 必须走共享 clamp');
    assert.ok(!/180000/.test(src), '远端不许再把超时夹成 180s');
    assert.ok(!/Math\.min\(\s*\d{6}/.test(src), '远端不许自己再写一份超时上限');
  });

  it('本机 runShell 也走同一份契约（数字只有一处）', () => {
    const src = read('src/gateway/host-control.js');
    assert.match(src, /clampExecTimeoutMs\(opts\.timeoutMs\)/);
    assert.ok(!/SHELL_TIMEOUT_MAX_MS\s*=/.test(src), '上限不许在 host-control 再定义一份');
    assert.ok(!/SHELL_TIMEOUT_DEFAULT_MS\s*=/.test(src));
  });

  it('远端 exec 在 c.exec 回调开头就有 settled 守卫（超时后不许再挂监听）', () => {
    const src = read('src/ssh/session-manager.js');
    const at = src.indexOf('c.exec(wrapped, (err, stream) => {');
    assert.ok(at > 0, '找不到 c.exec 回调');
    const body = src.slice(at, at + 1500);
    assert.match(body, /if \(settled\) \{/, '回调开头必须有 settled 守卫');
    assert.match(body, /stream\.close\(\)/, '被丢弃的 channel 必须关掉，否则输出继续往内存里堆');
    assert.match(body, /maxChars: EXEC_OUTPUT_MAX_CHARS/, '输出上限必须在调用点显式声明');
  });

  it('连上但还没交给 client 的连接，失败路径必须销毁（不许泄漏已认证连接）', () => {
    const src = read('src/ssh/session-manager.js');
    const start = src.indexOf('const conn = await token.race(connectOne(');
    const end = src.indexOf('client = conn;', start);
    assert.ok(start > 0 && end > start, '找不到 connectOne → client 之间那段');
    const between = src.slice(start, end);
    assert.match(between, /unclaimedConn = conn;/, '必须先登记「未认领连接」');
    assert.match(src.slice(end, end + 400), /unclaimedConn = null;/, '交给 client 后要清掉暂存');
    const catchAt = src.indexOf('if (unclaimedConn) {');
    assert.ok(catchAt > end, 'catch 里必须销毁未认领连接');
    assert.match(src.slice(catchAt, catchAt + 400), /gracefulCloseConn\(unclaimedConn\)/);
  });

  it('host.exec 的远端分支把截断信息透给模型', () => {
    const src = read('src/gateway/handlers/host.js');
    assert.match(src, /truncated: r\.truncated === true/);
    assert.match(src, /droppedChars: r\.droppedChars/);
  });
});

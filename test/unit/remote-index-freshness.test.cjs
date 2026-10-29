'use strict';
/**
 * 远端索引新鲜度：桌面端写完远端文件必须让远端 agent 重新索引。
 *
 * P4 之后「谁负责通知」只有一处判断（`fs.write_file` 里按适配器 `transport` 分流）：
 *  - 走 RPC 写（`remote-agent-fs`）→ 远端 handler 自己调度增量，桌面端**不再**补通知；
 *  - 走 SFTP 写（`remote-fs`，没装 Agent 的会话）→ 远端看不见，必须补 `index.notify_change`。
 *
 * 这里锁的是这个通知本身：形状、超时、失败不冒泡。
 */
const assert = require('node:assert/strict');

const { notifyRemoteIndexChange } = require('../../src/gateway/handlers/fs');

/** P2/P4 形态的 info：只认 openChannel，没有 url / token */
const AGENT_INFO = {
  key: '/home/u/.dieyun/remote-agent/run/agent.sock#/srv/p',
  socketPath: '/home/u/.dieyun/remote-agent/run/agent.sock',
  openChannel: () => Promise.resolve(null),
  workspaceRoot: '/srv/p'
};

function spyClient() {
  const calls = [];
  const client = {
    call: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      return { scheduled: true };
    }
  };
  return { calls, getRemoteAgentClient: () => client };
}

describe('notifyRemoteIndexChange', () => {
  it('有远端 agent 时发 index.notify_change，并带上写入路径与编码', async () => {
    const { calls, getRemoteAgentClient } = spyClient();
    notifyRemoteIndexChange(
      { getRemoteAgentInfo: () => AGENT_INFO, getRemoteAgentClient },
      { filePath: '/srv/p/src/a.ts', encoding: 'utf8', op: 'write' }
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'index.notify_change');
    assert.deepEqual(calls[0].params, { filePath: '/srv/p/src/a.ts', encoding: 'utf8', op: 'write' });
    assert.ok(calls[0].timeoutMs > 0, '必须有超时，否则 fire-and-forget 会攒住 socket');
  });

  it('没有远端 agent（本地工作区）时什么都不做', async () => {
    const { calls, getRemoteAgentClient } = spyClient();
    notifyRemoteIndexChange(
      { getRemoteAgentInfo: () => null, getRemoteAgentClient },
      { filePath: '/x', encoding: 'utf8' }
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 0);
  });

  it('通知失败不许冒泡（写入已经成功了）', async () => {
    let threw = false;
    try {
      notifyRemoteIndexChange(
        {
          getRemoteAgentInfo: () => AGENT_INFO,
          getRemoteAgentClient: () => ({
            call: () => Promise.reject(new Error('隧道断了'))
          })
        },
        { filePath: '/x', encoding: 'utf8' }
      );
    } catch {
      threw = true;
    }
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(threw, false);
  });

  it('client 构造同步抛错也被吞掉', () => {
    assert.doesNotThrow(() =>
      notifyRemoteIndexChange(
        {
          getRemoteAgentInfo: () => AGENT_INFO,
          getRemoteAgentClient: () => {
            throw new Error('隧道未就绪');
          }
        },
        { filePath: '/x', encoding: 'utf8' }
      )
    );
  });
});

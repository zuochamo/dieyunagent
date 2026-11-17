'use strict';

/**
 * core ↔ 宿主的**双向**通道验证（真进程）。
 *
 * 一次性验四种行（它们共用一条 stdout，靠 `type` 分流）：
 *   1. 响应                                    —— 按 `id` 匹配
 *   2. 事件 `type:"event"`（agent.delta / agent.usage）
 *   3. 反向调用 `type:"call"`（core 要宿主做事）
 *   4. 答复 `type:"reply"`（宿主回话）
 *
 * 驱动的是 `agent.run.start`（轮次控制已在 core 内），上游用本地假 SSE 端点。
 *
 * 用法：`node scripts/test-core-event-channel.cjs`；缺 core 二进制时跳过。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function resolveCoreBinary() {
  const explicit = String(process.env.DIEYUN_CORE_BIN || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const root = path.join(__dirname, '..', 'target');
  for (const profile of ['debug', 'release']) {
    for (const name of ['dieyun-core.exe', 'dieyun-core']) {
      const candidate = path.join(root, profile, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** 最小上游：两条增量 + usage + [DONE]；刻意分两次写，让块边界落在行中间 */
function startFakeUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ni"}}]}\n\ndata: {"choi');
        setTimeout(() => {
          res.write(
            'ces":[{"delta":{"content":"hao"}}]}\n\n' +
              'data: {"usage":{"prompt_tokens":77},"choices":[]}\n\ndata: [DONE]\n\n'
          );
          res.end();
        }, 10);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function main() {
  const bin = resolveCoreBinary();
  if (!bin) {
    console.log('skip: 未找到 dieyun-core 二进制（先 cargo build -p dieyun-core）');
    return Promise.resolve();
  }
  return startFakeUpstream().then(
    ({ server, port }) =>
      new Promise((resolve, reject) => {
        const child = spawn(bin, ['serve-stdio'], {
          env: { ...process.env, DIEYUN_DATA_DIR: path.join(os.tmpdir(), `dieyun-ch-${process.pid}`) },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        child.stdout.setEncoding('utf8');

        const events = [];
        const hostCalls = [];
        const replies = {};
        let buffer = '';
        let started = false;
        let finished = false;

        const finishedOnce = (fn) => (arg) => {
          if (finished) return;
          finished = true;
          fn(arg);
        };
        const cleanup = () => {
          clearTimeout(timer);
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          server.close();
        };
        const fail = finishedOnce((message) => {
          cleanup();
          reject(new Error(message));
        });
        const timer = setTimeout(
          () => fail(`超时：events=${events.length} calls=${JSON.stringify(hostCalls)} replies=${JSON.stringify(replies)}`),
          20000
        );
        timer.unref?.();

        const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

        function check() {
          const run = replies[2] && replies[2].result;
          if (!run) throw new Error(`agent.run.start 没有结果：${JSON.stringify(replies[2])}`);
          if (run.phase !== 'done') throw new Error(`应一轮跑完：${JSON.stringify(run)}`);
          if (run.content !== 'nihao') throw new Error(`正文不对：${JSON.stringify(run.content)}`);
          // usage 必须作为事件回流（成本统计只认它）
          const usage = events.find((e) => e && e.type === 'agent.usage');
          if (!usage || !usage.usage || usage.usage.prompt_tokens !== 77) {
            throw new Error(`usage 没回流：${JSON.stringify(events)}`);
          }
          // 增量必须到达，且能拼回原文
          const deltas = events.filter((e) => e && e.type === 'agent.delta');
          if (!deltas.length) throw new Error(`一条增量都没有：${JSON.stringify(events)}`);
          if (deltas.map((d) => d.content || '').join('') !== 'nihao') {
            throw new Error(`增量拼不回原文：${JSON.stringify(deltas.map((d) => d.content))}`);
          }
          if (deltas.some((d) => String(d.runId || '') !== 'run-evt')) {
            throw new Error(`事件 runId 归属不对：${JSON.stringify(deltas)}`);
          }
          // 反向通道
          if (!hostCalls.some((c) => c.method === 'round.prepare')) {
            throw new Error(`没收到 round.prepare：${JSON.stringify(hostCalls)}`);
          }
          // 通用一次调用（辅助任务的唯一入口）
          const once = replies[4] && replies[4].result;
          if (!once) throw new Error(`llm.complete 没有结果：${JSON.stringify(replies[4])}`);
          if (once.content !== 'nihao') {
            throw new Error(`llm.complete 正文不对：${JSON.stringify(once.content)}`);
          }
          if (!once.usage || once.usage.prompt_tokens !== 77) {
            throw new Error(`llm.complete 没带 usage：${JSON.stringify(once.usage)}`);
          }
        }

        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.type === 'call') {
              hostCalls.push(msg);
              const params = msg.params || {};
              // round.prepare：原样回消息（快照/注入在 Node 侧；这里只验通道）
              send({ type: 'reply', id: msg.id, result: { messages: params.messages, visionInjected: 0 } });
              continue;
            }
            if (msg.type === 'event') {
              events.push(msg.event);
              continue;
            }
            if (msg.id != null) {
              replies[msg.id] = msg;
              if (msg.id === 1 && !started) {
                started = true;
                send({
                  id: 2,
                  method: 'agent.run.start',
                  params: {
                    runId: 'run-evt',
                    model: 'fake',
                    messages: [{ role: 'user', content: 'hi' }],
                    maxToolCalls: 4,
                    maxRounds: 4,
                    url: `http://127.0.0.1:${port}/v1/chat/completions`,
                    stream: true,
                    llm: { apiKey: 'sk-test', authMode: 'bearer' }
                  }
                });
                continue;
              }
              if (msg.id === 2) {
                // 通用一次调用：Node 侧辅助任务（标题 / 汇总 / 评审…）走的就是这条
                send({
                  id: 4,
                  method: 'llm.complete',
                  params: {
                    url: `http://127.0.0.1:${port}/v1/chat/completions`,
                    body: { model: 'fake', messages: [{ role: 'user', content: 'hi' }] },
                    // 假上游只会吐 SSE，所以这里按流式发（一次性调用也支持 stream）
                    stream: true
                  }
                });
                continue;
              }
              if (msg.id === 4) {
                setTimeout(() => {
                  try {
                    check();
                    cleanup();
                    console.log(
                      `core-event-channel: OK（${events.length} 事件 / ${hostCalls.length} 反向调用 / done + llm.complete）`
                    );
                    resolve();
                  } catch (err) {
                    fail(err && err.message ? err.message : String(err));
                  }
                }, 150);
              }
            }
          }
        });
        child.stderr.on('data', () => {
          /* core 的 stderr 是日志 */
        });
        child.on('error', (err) => fail(`spawn 失败：${err && err.message}`));

        send({ id: 1, method: 'core.ping', params: {} });
      })
  );
}

main().catch((err) => {
  console.error(`core-event-channel FAILED: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});

'use strict';

/**
 * `src/timeout.js` 的行为契约。
 *
 * 这份单测的存在理由：`withTimeout` 被六个模块共用（agent 系统提示装配 / 工具桥、
 * browser evaluate、sandbox 审批、LSP 符号查询、MCP 连接与调用）。它的两种模式
 * 正好是「超时要失败」与「超时要降级成 null」两派语义，一旦改错，
 * 现象是「某个可选增强步骤把整轮拖挂」或「本该报错的超时被悄悄吞掉」，
 * 都很难从调用点看出来。
 */

const { withTimeout } = require('../../src/timeout');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('withTimeout', () => {
  test('未超时：原样返回结果', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 50)).toBe('ok');
  });

  test("reject 模式：超时抛错，消息可定制", async () => {
    await expect(withTimeout(sleep(50).then(() => 'late'), 10, { message: '自定义超时' })).rejects.toThrow(
      '自定义超时'
    );
  });

  test('reject 模式：不带 message 时给出含毫秒数的默认文案', async () => {
    await expect(withTimeout(sleep(50), 10)).rejects.toThrow('等待超时（10ms）');
  });

  test('reject 模式：超时错误带 code（审批链路靠它区分超时与通道故障）', async () => {
    await expect(
      withTimeout(sleep(50), 10, { message: '等待确认超时', code: 'APPROVAL_TIMEOUT' })
    ).rejects.toMatchObject({ code: 'APPROVAL_TIMEOUT' });
  });

  test('reject 模式：原 promise 的失败照常上抛（不是超时就不改写错误）', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });

  test("null 模式：超时返回 null", async () => {
    expect(await withTimeout(sleep(50).then(() => 'late'), 10, { mode: 'null' })).toBe(null);
  });

  test('null 模式：底层失败也返回 null（可选增强步骤不得中断主流程）', async () => {
    expect(await withTimeout(Promise.reject(new Error('boom')), 50, { mode: 'null' })).toBe(null);
  });

  test('ms 非正数 = 不设超时：reject 模式原样返回，失败仍上抛', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 0)).toBe('ok');
    await expect(withTimeout(Promise.reject(new Error('boom')), 0)).rejects.toThrow('boom');
  });

  test('ms 非正数 = 不设超时：null 模式吞掉失败', async () => {
    expect(await withTimeout(Promise.reject(new Error('boom')), 0, { mode: 'null' })).toBe(null);
  });

  test('ms 非有限（undefined / NaN）按不设超时处理', async () => {
    expect(await withTimeout(Promise.resolve('ok'), undefined)).toBe('ok');
    expect(await withTimeout(Promise.resolve('ok'), NaN)).toBe('ok');
  });

  test('超时后底层稍后完成，不会重复 settle（也不会抛未处理的 reject）', async () => {
    let settled = 0;
    const p = withTimeout(sleep(20).then(() => 'late'), 5, { mode: 'null' }).then((v) => {
      settled += 1;
      return v;
    });
    expect(await p).toBe(null);
    await sleep(40);
    expect(settled).toBe(1);
  });

  test('普通值（非 promise）也能用', async () => {
    expect(await withTimeout(42, 10)).toBe(42);
  });
});

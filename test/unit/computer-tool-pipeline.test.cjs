'use strict';

/**
 * computer 工具接入工具链的三个接缝：参数校验（tool-validate）、
 * 出站净化（tool-bridge-main.sanitizeToolResultForApi）、视觉缓冲来源（browser-vision）。
 */

const { validateToolArgs } = require('../../src/agent/tool-validate');
const { sanitizeToolResultForApi } = require('../../src/agent/tool-bridge-main');
const {
  SOURCE_COMPUTER,
  extractShot,
  recordBrowserScreenshot,
  takePendingBrowserScreenshots,
  buildVisionMessage,
  clearPendingVisionImages
} = require('../../src/agent/browser-vision');
const { MUTATING_TOOL_NAMES } = require('../../src/agent/guardrails-shared');

const SHOT = {
  ok: true,
  action: 'click',
  display: 0,
  primary: true,
  screen: { width: 1920, height: 1080 },
  cursor: { x: 960, y: 540 },
  activeWindow: '记事本',
  mime: 'image/png',
  base64: 'aGVsbG8=',
  width: 1920,
  height: 1080
};

describe('validateToolArgs(computer)', () => {
  it('未知动作拒绝并给出 action 枚举', () => {
    const r = validateToolArgs('computer', { action: 'shutdown' });
    expect(r.ok).toBe(false);
    expect(r.suggestedFix).toContain('screenshot');
  });

  it('move/drag 必须带 coordinate；drag 还要 to', () => {
    expect(validateToolArgs('computer', { action: 'move' }).ok).toBe(false);
    expect(validateToolArgs('computer', { action: 'drag', coordinate: [1, 2] }).ok).toBe(false);
    expect(
      validateToolArgs('computer', { action: 'drag', coordinate: [1, 2], to: [3, 4] }).ok
    ).toBe(true);
  });

  it('click 可以省略 coordinate（在当前光标位置点），但给错形状要拒', () => {
    expect(validateToolArgs('computer', { action: 'click' }).ok).toBe(true);
    expect(validateToolArgs('computer', { action: 'click', coordinate: [1] }).ok).toBe(false);
    expect(validateToolArgs('computer', { action: 'click', coordinate: ['a', 'b'] }).ok).toBe(false);
  });

  it('type 文本超长拒绝', () => {
    const big = 'x'.repeat(2100);
    const r = validateToolArgs('computer', { action: 'type', text: big });
    expect(r.ok).toBe(false);
    expect(r.suggestedFix).toContain('分段');
  });

  it('key 结构校验（非法字符拒；具体键名执行端判）', () => {
    expect(validateToolArgs('computer', { action: 'key', key: 'ctrl+c' }).ok).toBe(true);
    expect(validateToolArgs('computer', { action: 'key', key: 'ctrl alt' }).ok).toBe(false);
    expect(validateToolArgs('computer', { action: 'key' }).ok).toBe(false);
  });

  it('scroll amount 越界与 wait ms 越界拒绝', () => {
    expect(validateToolArgs('computer', { action: 'scroll', amount: 999 }).ok).toBe(false);
    expect(validateToolArgs('computer', { action: 'scroll', direction: 'left' }).ok).toBe(false);
    expect(validateToolArgs('computer', { action: 'wait', ms: 999999 }).ok).toBe(false);
    expect(validateToolArgs('computer', { action: 'wait', ms: 500 }).ok).toBe(true);
  });
});

describe('sanitizeToolResultForApi(computer)', () => {
  it('剥离 base64，保留动作事实', () => {
    const out = sanitizeToolResultForApi('computer', { ...SHOT });
    expect(out.base64).toBeUndefined();
    expect(out.base64Omitted).toBe(true);
    expect(out.action).toBe('click');
    expect(out.cursor).toEqual({ x: 960, y: 540 });
    expect(out.activeWindow).toBe('记事本');
    expect(out.width).toBe(1920);
  });

  it('无 base64 的结果原样透传', () => {
    const r = { ok: false, error: 'x' };
    expect(sanitizeToolResultForApi('computer', r)).toBe(r);
  });
});

describe('browser-vision SOURCE_COMPUTER', () => {
  afterEach(() => {
    clearPendingVisionImages('run-c');
  });

  it('computer 结果按 computer 来源入队并保留最新（evictOldest）', () => {
    const limits = { visionShotsPerRound: 2, visionMaxBase64Chars: 100000 };
    const shotA = { ...SHOT, base64: 'AAA' };
    const shotB = { ...SHOT, base64: 'BBB' };
    const shotC = { ...SHOT, base64: 'CCC' };
    expect(recordBrowserScreenshot('run-c', 'computer', shotA, limits)).toBe(true);
    recordBrowserScreenshot('run-c', 'computer', shotB, limits);
    // 第三张进队时挤掉最旧的 A：模型永远看得到最新画面
    recordBrowserScreenshot('run-c', 'computer', shotC, limits);
    const list = takePendingBrowserScreenshots('run-c');
    expect(list).toHaveLength(2);
    expect(list[0].source).toBe(SOURCE_COMPUTER);
    expect(list.map((s) => s.base64)).toEqual(['BBB', 'CCC']);
  });

  it('buildVisionMessage 含 computer 引导文案（坐标系说明）', () => {
    const limits = { visionShotsPerRound: 2, visionMaxBase64Chars: 100000 };
    recordBrowserScreenshot('run-c', 'computer', { ...SHOT, base64: 'ZZZ' }, limits);
    const msg = buildVisionMessage(takePendingBrowserScreenshots('run-c'));
    expect(msg).toBeTruthy();
    expect(msg.role).toBe('user');
    expect(msg.content[0].text).toContain('电脑屏幕');
    expect(msg.content[0].text).toContain('像素');
    expect(msg.content[1].image_url.url).toContain('data:image/png;base64,ZZZ');
  });

  it('extractShot 认 computer 工具（导出探针）', () => {
    expect(extractShot('computer', { ...SHOT }).source).toBe(SOURCE_COMPUTER);
    expect(extractShot('host_exec', SHOT)).toBeNull();
  });
});

describe('guardrails 分类', () => {
  it('computer 在串行（mutating）集合里', () => {
    expect(MUTATING_TOOL_NAMES.has('computer')).toBe(true);
  });
});

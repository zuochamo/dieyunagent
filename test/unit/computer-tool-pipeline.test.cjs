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
const { encodeWithinBudget } = require('../../src/computer/capture');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

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

/**
 * 真机回归：3240×2160 整屏 PNG 的 base64 是 4,720,372 字符，超过单张上限 4,194,304，
 * 于是被 browser-vision 整张丢弃 —— 模型只能反复说「下一轮就能看到画面」。
 * 修法是截图侧按长边上限缩放进预算；这里用「字节/像素」比例还原那张真机图。
 */
function fakeImage(width, height, bytesPerPixel) {
  const bytes = () => Math.max(1, Math.round(width * height * bytesPerPixel));
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => width <= 0 || height <= 0,
    resize({ width: w, height: h }) {
      return fakeImage(w, h, bytesPerPixel);
    },
    toPNG: () => Buffer.alloc(bytes()),
    // JPEG 约为 PNG 的 1/4（界面截图的经验值，只用于挑编码，不影响判定口径）
    toJPEG: () => Buffer.alloc(Math.max(1, Math.round(bytes() / 4)))
  };
}

const base64Len = (bytes) => Math.ceil(bytes / 3) * 4;

describe('encodeWithinBudget（截图进视觉预算）', () => {
  const MAX_EDGE = 1568;
  const MAX_CHARS = 4 * 1024 * 1024;

  it('4K 整屏 PNG 缩放后能进预算，且报告原始尺寸', () => {
    const out = encodeWithinBudget(fakeImage(3240, 2160, 0.5), {
      maxEdge: MAX_EDGE,
      maxBase64Chars: MAX_CHARS
    });
    expect(out.mime).toBe('image/png');
    expect(out.base64.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(Math.max(out.width, out.height)).toBe(MAX_EDGE);
    expect(out.native).toEqual({ width: 3240, height: 2160 });
    expect(out.overBudget).toBeUndefined();
    // 宽高比保持：坐标口径仍是「模型看到的那张图」的像素
    expect(out.width / out.height).toBeCloseTo(3240 / 2160, 2);
  });

  it('缩到下限仍超预算时如实标记 overBudget，不静默假成功', () => {
    // 4 字节/像素 + 极小预算：PNG/JPEG/逐次缩小都救不回来
    const out = encodeWithinBudget(fakeImage(3240, 2160, 4), {
      maxEdge: MAX_EDGE,
      maxBase64Chars: 4096
    });
    expect(out.overBudget).toBe(true);
    expect(out.base64.length).toBeGreaterThan(4096);
  });

  it('小图 / 大预算不需要缩放时原样返回', () => {
    const out = encodeWithinBudget(fakeImage(800, 600, 0.2), {
      maxEdge: MAX_EDGE,
      maxBase64Chars: MAX_CHARS
    });
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    expect(out.mime).toBe('image/png');
    expect(out.overBudget).toBeUndefined();
  });

  it('默认预算来自 agent-limits 单一来源', () => {
    const out = encodeWithinBudget(fakeImage(3240, 2160, 0.5));
    expect(Math.max(out.width, out.height)).toBe(AGENT_LIMITS_DEFAULTS.visionShotMaxEdge);
    expect(out.base64.length).toBeLessThanOrEqual(AGENT_LIMITS_DEFAULTS.visionMaxBase64Chars);
    // 复现真机那张图：不缩放时的 base64 会超过上限（正是本次 bug 的成因）
    expect(base64Len(Math.round(3240 * 2160 * 0.5))).toBeGreaterThan(
      AGENT_LIMITS_DEFAULTS.visionMaxBase64Chars
    );
  });
});

/**
 * 截图进不了视觉通道时，模型必须拿到两样东西：一句「你看不到」的实话，和一条可读的退路。
 * 这两件都由 after 关卡与 vision-image 的文案单一来源拼出来，这里锁住端到端形状。
 */
describe('computer 截图的视觉凭证（after 关卡 → 工具结果）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createMainToolBridge } = require('../../src/agent/tool-bridge-main');
  const { takePendingVisionImages, clearPendingVisionImages } = require('../../src/agent/browser-vision');

  function fakePngBuffer(bytes) {
    const buf = Buffer.alloc(bytes);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    return buf;
  }

  /** 起一个只认 computer.action 的假网关：截图由用例决定。 */
  function runComputerShot({ shotBytes = 2048, visionEnabled = true, runId }) {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-shot-ud-'));
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-shot-ws-'));
    const base64 = fakePngBuffer(shotBytes).toString('base64');
    const gateway = {
      invokeRpc: async (method) => {
        if (method !== 'computer.action') throw new Error(`unexpected rpc: ${method}`);
        return {
          ok: true,
          action: 'screenshot',
          display: 0,
          primary: true,
          screen: { width: 1568, height: 882 },
          cursor: { x: 10, y: 20 },
          activeWindow: '记事本',
          mime: 'image/png',
          width: 1568,
          height: 882,
          base64
        };
      }
    };
    const bridge = createMainToolBridge({ gateway, webContents: null, userDataPath });
    const ctx = { runId, sessionId: 's1', workspacePath, browserVision: visionEnabled };
    return bridge.executeAgentTool('computer', { action: 'screenshot' }, ctx);
  }

  it('入队成功：结果带可寻址凭证（id + 视觉 token + 只读副本路径）', async () => {
    const runId = 'run-shot-ok';
    try {
      const out = await runComputerShot({ runId });
      expect(out.ok).toBe(true);
      expect(out.base64).toBeUndefined();
      expect(out.visionImage).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(out.visionTokens).toBe(821);
      expect(out.note).toContain(out.visionImage);
      expect(out.note).toContain('只读副本');
      expect(out.note).toContain('1568×882');
      // 副本真的落盘了（模型据此可 fs_read_file 再看细节）
      const saved = out.note.match(/只读副本：(.+?)。/);
      expect(saved).toBeTruthy();
      expect(fs.existsSync(saved[1])).toBe(true);
      expect(takePendingVisionImages(runId)).toHaveLength(1);
    } finally {
      clearPendingVisionImages(runId);
    }
  });

  it('超体积未入队：明说看不到 + 原因，但副本仍在（不静默、不留死路）', async () => {
    const runId = 'run-shot-big';
    try {
      // base64 约 5.6MB，超过 agent-limits 的单张上限（4MiB）
      const out = await runComputerShot({ runId, shotBytes: 5 * 1024 * 1024 });
      expect(out.base64).toBeUndefined();
      expect(out.note).toContain('没有进入视觉通道');
      expect(out.note).toContain('不要假设自己已经看过');
      expect(out.note).toContain('超过单张上限');
      expect(out.note).toContain('只读副本仍在');
      expect(out.note).toContain('fs_read_file');
      expect(takePendingVisionImages(runId)).toHaveLength(0);
    } finally {
      clearPendingVisionImages(runId);
    }
  }, 20000);

  it('模型没开视觉：明说不会看到，并给替代途径', async () => {
    const runId = 'run-shot-textonly';
    try {
      const out = await runComputerShot({ runId, visionEnabled: false });
      expect(out.note).toContain('未开启视觉输入');
      expect(out.note).toContain('host_exec');
      expect(out.visionImage).toBeUndefined();
    } finally {
      clearPendingVisionImages(runId);
    }
  });
});

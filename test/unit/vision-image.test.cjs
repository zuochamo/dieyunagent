'use strict';

/**
 * 视觉图片的「可寻址凭证」：视觉 token 口径、内容寻址落盘、统一文案。
 * 这是「工具产出的图片用完即丢」那半个缺口的回归锁。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_IMAGE_TOKENS,
  visionTokensForSize,
  storeVisionImage,
  pruneVisionImages,
  visionHandleText,
  visionOmitText
} = require('../../src/agent/vision-image');

/** 生成能被 base64 解码的假 PNG 字节（内容可控，便于断言内容寻址）。 */
function fakePng(seed, size = 512) {
  const buf = Buffer.alloc(size);
  buf.fill(seed % 251);
  // PNG 魔数：让 "这是张 png" 这件事在字节层面也成立
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt8(seed % 251, 100);
  return buf;
}

function tmpUserData(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-vision-${tag}-`));
}

describe('visionTokensForSize（DeepSeek 公开图片 token 算法）', () => {
  it('16:9 注入尺寸按公开格网算得 821 token', () => {
    // 1568 = 112×14 patch → 38 格；882 = 63×14 patch → 21 格；21×(38+1)+2
    expect(visionTokensForSize(1568, 882)).toBe(821);
  });

  it('4K 整屏被压到 token 上限内', () => {
    const t = visionTokensForSize(3840, 2160);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(MAX_IMAGE_TOKENS);
  });

  it('小图先放大到 544×544 下限再投影（不会被算成 1~8 token）', () => {
    const t = visionTokensForSize(16, 16);
    expect(t).toBeGreaterThan(100);
    expect(t).toBeLessThanOrEqual(MAX_IMAGE_TOKENS);
  });

  it('极端长宽比不崩且不越界', () => {
    for (const [w, h] of [
      [8000, 20],
      [20, 8000],
      [1000, 1000]
    ]) {
      const t = visionTokensForSize(w, h);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(MAX_IMAGE_TOKENS);
    }
  });

  it('尺寸非法返回 0（不猜）', () => {
    expect(visionTokensForSize(0, 100)).toBe(0);
    expect(visionTokensForSize(NaN, 100)).toBe(0);
    expect(visionTokensForSize(undefined, undefined)).toBe(0);
  });
});

describe('storeVisionImage', () => {
  it('内容寻址：同图同路径，第二次标记去重', () => {
    const userDataPath = tmpUserData('dedupe');
    const bytes = fakePng(7);
    const shot = { base64: bytes.toString('base64'), mime: 'image/png', width: 1568, height: 882 };

    const first = storeVisionImage(shot, { userDataPath });
    expect(first).toBeTruthy();
    expect(first.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.deduped).toBe(false);
    expect(first.bytes).toBe(bytes.length);
    expect(first.tokens).toBe(821);
    expect(first.path).toContain(path.join('tool-output', 'vision'));
    expect(fs.readFileSync(first.path).equals(bytes)).toBe(true);

    const second = storeVisionImage(shot, { userDataPath });
    expect(second.path).toBe(first.path);
    expect(second.deduped).toBe(true);
  });

  it('保留张数由 agent-limits 口径裁剪（旧的先删）', () => {
    const userDataPath = tmpUserData('prune');
    const stored = [];
    // keep=0 = 不裁剪：先把 5 张都存下来，再显式裁，断言才与时间戳顺序严格对应
    for (let i = 0; i < 5; i += 1) {
      const h = storeVisionImage(
        { base64: fakePng(i + 1).toString('base64'), mime: 'image/png' },
        { userDataPath, limits: { visionImageKeepFiles: 0 } }
      );
      expect(h).toBeTruthy();
      const t = 1_700_000_000 + i; // 递增的固定 mtime，避免同毫秒并列
      fs.utimesSync(h.path, t, t);
      stored.push(h);
    }
    const root = path.dirname(path.dirname(stored[0].path));
    expect(pruneVisionImages(root, 2)).toBe(3);
    const alive = stored.filter((h) => fs.existsSync(h.path));
    expect(alive.map((h) => h.path)).toEqual(stored.slice(-2).map((h) => h.path));
  });

  it('写入时自动裁剪：总量不超过上限', () => {
    const userDataPath = tmpUserData('prune-auto');
    let last = null;
    for (let i = 0; i < 4; i += 1) {
      last = storeVisionImage(
        { base64: fakePng(i + 11).toString('base64'), mime: 'image/png' },
        { userDataPath, limits: { visionImageKeepFiles: 2 } }
      );
      expect(last).toBeTruthy();
    }
    const root = path.dirname(path.dirname(last.path));
    const count = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .reduce((n, e) => n + fs.readdirSync(path.join(root, e.name)).length, 0);
    expect(count).toBeLessThanOrEqual(2);
  });

  it('非受支持格式 / 空图返回 null（调用方据此说明没有可读副本）', () => {
    const userDataPath = tmpUserData('reject');
    expect(storeVisionImage({ base64: '', mime: 'image/png' }, { userDataPath })).toBeNull();
    expect(
      storeVisionImage({ base64: fakePng(1).toString('base64'), mime: 'image/bmp' }, { userDataPath })
    ).toBeNull();
  });

  it('本地工作区落在工作区的 .dieyun/tool-output/vision 下（与其它工具产物同源）', () => {
    const userDataPath = tmpUserData('ws-ud');
    const workspacePath = tmpUserData('ws');
    const h = storeVisionImage(
      { base64: fakePng(3).toString('base64'), mime: 'image/png' },
      { userDataPath, workspacePath }
    );
    expect(h.path.startsWith(path.join(workspacePath, '.dieyun', 'tool-output', 'vision'))).toBe(
      true
    );
  });

  it('SSH 远程工作区交虚拟路径（副本在本机，本地绝对路径远端不存在）', () => {
    const userDataPath = tmpUserData('ws-remote');
    const h = storeVisionImage(
      { base64: fakePng(5).toString('base64'), mime: 'image/png' },
      { userDataPath, workspacePath: 'ssh://me@buildhost/home/me/proj' }
    );
    expect(h.path.startsWith('.dieyun/tool-output/vision/')).toBe(true);
    // 文件实际落在本机 userData（虚拟路径经 host-sidecar 反向映射回去）
    const local = path.join(userDataPath, 'tool-output', h.path.replace(/^\.dieyun\/tool-output\//, ''));
    expect(fs.existsSync(local)).toBe(true);
  });
});

describe('文案（模型可见的唯一一份）', () => {
  const handle = {
    id: 'sha256:' + 'a'.repeat(64),
    path: 'E:\\ws\\.dieyun\\tool-output\\vision\\aa\\aaa.png',
    width: 1568,
    height: 882,
    mime: 'image/png',
    bytes: 309248,
    tokens: 821
  };

  it('凭证含身份 / 尺寸 / 体积 / token / 副本路径', () => {
    const text = visionHandleText(handle);
    expect(text).toContain('sha256:aaaa');
    expect(text).toContain('1568×882');
    expect(text).toContain('302 KB');
    expect(text).toContain('视觉约 821 token');
    expect(text).toContain(handle.path);
  });

  it('hint 追加在末尾；无 handle 时为空串', () => {
    expect(visionHandleText(handle, '不要重复截同一屏。')).toMatch(/不要重复截同一屏。$/);
    expect(visionHandleText(null)).toBe('');
    expect(visionHandleText({ width: 1, height: 1 })).toBe('');
  });

  it('失败文案：说清看不到 + 原因 + 仍可读的副本', () => {
    const text = visionOmitText('编码后 base64 999 字符，超过单张上限 100', handle);
    expect(text).toContain('没有进入视觉通道');
    expect(text).toContain('不要假设自己已经看过');
    expect(text).toContain('超过单张上限 100');
    expect(text).toContain(handle.path);
  });

  it('失败文案：无副本时明说没有可读副本（不给假退路）', () => {
    const text = visionOmitText('本轮同来源截图张数已满', null);
    expect(text).toContain('没有留下可读副本');
    expect(text).not.toContain('fs_read_file');
  });
});

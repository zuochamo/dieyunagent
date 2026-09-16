'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  pruneAttachmentImages,
  resolveRetentionLimits,
  isImageName,
  isResizableName,
  MAX_FILES_PER_PASS
} = require('../../src/attachment-retention');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

const MB = 1024 * 1024;
const KB = 1024;

/** 解码替身：输出恒为输入的一半，模拟「缩完明显变小」。 */
function halfDecoder(buf) {
  const out = () => Buffer.alloc(Math.floor(buf.length / 2), 1);
  return {
    getSize: () => ({ width: 2000, height: 1000 }),
    resize: () => ({ toPNG: out, toJPEG: out }),
    toPNG: out,
    toJPEG: out
  };
}

/** 解码替身：输出与输入同尺寸，用来验证「压不小就不写回」。 */
function noShrinkDecoder(buf) {
  const out = () => Buffer.alloc(buf.length, 1);
  return {
    getSize: () => ({ width: 100, height: 100 }),
    resize: () => ({ toPNG: out, toJPEG: out }),
    toPNG: out,
    toJPEG: out
  };
}

const tmpDirs = [];

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-attach-'));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir, name, bytes, mtimeMs) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 7));
  if (mtimeMs != null) fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

/** 宽松额度：容量 1MB、最小体积 1KB，方便用小文件构造超限场景。 */
const TIGHT_LIMITS = {
  attachmentRetentionMaxMb: 1,
  attachmentDownsampleMaxPx: 1600,
  attachmentDownsampleMinKb: 1
};

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('attachment-retention', () => {
  it('does nothing when under capacity', async () => {
    const dir = makeDir();
    writeFile(dir, 'a.png', 300 * KB, 1000);
    writeFile(dir, 'b.png', 300 * KB, 2000);

    const report = await pruneAttachmentImages({
      target: { kind: 'local', dir },
      limits: TIGHT_LIMITS,
      decodeImage: halfDecoder
    });

    expect(report.downsized).toBe(0);
    expect(report.checked).toBe(0);
    expect(report.totalBytes).toBe(600 * KB);
    expect(fs.statSync(path.join(dir, 'a.png')).size).toBe(300 * KB);
  });

  it('downsamples oldest first until under capacity and keeps every file name', async () => {
    const dir = makeDir();
    for (let i = 0; i < 5; i += 1) writeFile(dir, `f${i}.png`, 300 * KB, 1000 + i * 1000);
    const before = fs.readdirSync(dir).sort();

    const report = await pruneAttachmentImages({
      target: { kind: 'local', dir },
      limits: TIGHT_LIMITS,
      decodeImage: halfDecoder
    });

    // 5 × 300KB = 1500KB；每张省 150KB；省 600KB 后 900KB ≤ 1024KB 即停
    expect(report.downsized).toBe(4);
    expect(report.freedBytes).toBe(4 * 150 * KB);
    expect(report.totalBytes).toBeLessThanOrEqual(MB);
    expect(fs.readdirSync(dir).sort()).toEqual(before);

    // 最旧的先被压小，最新的原样保留
    expect(fs.statSync(path.join(dir, 'f0.png')).size).toBe(150 * KB);
    expect(fs.statSync(path.join(dir, 'f4.png')).size).toBe(300 * KB);
  });

  it('skips non-resizable formats and files below the minimum size', async () => {
    const dir = makeDir();
    writeFile(dir, 'animated.gif', 300 * KB, 1000);
    writeFile(dir, 'tiny.png', 500, 2000);
    for (let i = 0; i < 4; i += 1) writeFile(dir, `f${i}.png`, 300 * KB, 3000 + i * 1000);

    const report = await pruneAttachmentImages({
      target: { kind: 'local', dir },
      limits: TIGHT_LIMITS,
      decodeImage: halfDecoder
    });

    expect(report.downsized).toBe(4);
    expect(fs.statSync(path.join(dir, 'animated.gif')).size).toBe(300 * KB);
    expect(fs.statSync(path.join(dir, 'tiny.png')).size).toBe(500);
  });

  it('does not rewrite when re-encode cannot shrink', async () => {
    const dir = makeDir();
    for (let i = 0; i < 5; i += 1) writeFile(dir, `f${i}.png`, 300 * KB, 1000 + i * 1000);

    const report = await pruneAttachmentImages({
      target: { kind: 'local', dir },
      limits: TIGHT_LIMITS,
      decodeImage: noShrinkDecoder
    });

    expect(report.downsized).toBe(0);
    expect(fs.statSync(path.join(dir, 'f0.png')).size).toBe(300 * KB);
  });

  it('bounds work per pass so a single call cannot block forever', async () => {
    const dir = makeDir();
    for (let i = 0; i < MAX_FILES_PER_PASS + 8; i += 1) {
      writeFile(dir, `f${i}.png`, 300 * KB, 1000 + i * 1000);
    }

    const report = await pruneAttachmentImages({
      target: { kind: 'local', dir },
      limits: TIGHT_LIMITS,
      decodeImage: halfDecoder
    });

    expect(report.checked).toBe(MAX_FILES_PER_PASS);
    expect(report.downsized).toBe(MAX_FILES_PER_PASS);
    expect(report.totalBytes).toBeGreaterThan(MB);
  });

  it('handles ssh workspaces through sftp without touching local disk', async () => {
    const dir = '/ws/.dieyun/attachments';
    const store = new Map();
    const entries = [];
    for (let i = 0; i < 5; i += 1) {
      const name = `f${i}.png`;
      store.set(`${dir}/${name}`, Buffer.alloc(300 * KB, 3));
      entries.push({ name, isDirectory: false, size: 300 * KB, mtimeMs: 1000 + i * 1000 });
    }
    const written = [];
    const ssh = {
      browse: async () => ({ ok: true, path: dir, entries }),
      sftpReadFile: async (p) => ({ buf: store.get(p) || Buffer.alloc(0), truncated: false }),
      sftpWriteFile: async (p, buf) => {
        written.push(p);
        store.set(p, buf);
      }
    };

    const report = await pruneAttachmentImages({
      target: { kind: 'ssh', dir, ssh },
      limits: TIGHT_LIMITS,
      decodeImage: halfDecoder
    });

    expect(report.downsized).toBe(4);
    expect(written.every((p) => p.startsWith(`${dir}/`))).toBe(true);
    expect(store.get(`${dir}/f0.png`).length).toBe(150 * KB);
    expect(store.get(`${dir}/f4.png`).length).toBe(300 * KB);
  });

  it('reports why it did nothing instead of throwing', async () => {
    const noWorkspace = await pruneAttachmentImages({});
    expect(noWorkspace.skipped).toBe('no-workspace');

    const disabled = await pruneAttachmentImages({
      target: { kind: 'local', dir: makeDir() },
      limits: { attachmentRetentionMaxMb: 0 }
    });
    expect(disabled.skipped).toBe('disabled');
  });

  it('converts agent-limits units and filters image names', () => {
    const cfg = resolveRetentionLimits({
      attachmentRetentionMaxMb: 2,
      attachmentDownsampleMaxPx: 800,
      attachmentDownsampleMinKb: 64
    });
    expect(cfg.maxTotalBytes).toBe(2 * MB);
    expect(cfg.maxPx).toBe(800);
    expect(cfg.minBytes).toBe(64 * KB);

    const defaults = resolveRetentionLimits();
    expect(defaults.maxTotalBytes).toBe(AGENT_LIMITS_DEFAULTS.attachmentRetentionMaxMb * MB);
    expect(defaults.minBytes).toBe(AGENT_LIMITS_DEFAULTS.attachmentDownsampleMinKb * KB);
    expect(defaults.maxPx).toBe(AGENT_LIMITS_DEFAULTS.attachmentDownsampleMaxPx);

    expect(isImageName('shot.PNG')).toBe(true);
    expect(isImageName('shot.webp')).toBe(true);
    expect(isImageName('notes.txt')).toBe(false);
    expect(isResizableName('shot.jpeg')).toBe(true);
    expect(isResizableName('shot.gif')).toBe(false);
  });
});

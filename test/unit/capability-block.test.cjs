'use strict';

/**
 * 【本轮能力事实】：能力表 + 判定 + 文本块。
 *
 * 锁三件事：
 * 1. 判定口径与工具注入同一份（`renderer-tool-defs.js#getHostToolFlags`）：hostControl 是总闸，
 *    webFetch 独立，摄像头必须显式 true；
 * 2. 「关着」必须出现 —— 这是这个块存在的理由（权限关掉的工具不会注入，模型否则分不清
 *    「没这个能力」和「被关着」）；
 * 3. 没有权限快照时输出空串（Renderer 兜底装配路径），不许拿缺省值编一份假能力表。
 */

const {
  CAPABILITIES,
  CAPABILITY_BY_KEY,
  capabilityEnabled,
  enabledCapabilities,
  formatCapabilityBlock
} = require('../../src/agent/capability-index');

/** 与 `permissions-store.DEFAULTS` 同形状的最小快照（默认开：文件/命令/电脑控制；摄像头默认关）。 */
const DEFAULTS_LIKE = {
  hostControl: true,
  fsRead: true,
  fsWrite: true,
  shellExec: true,
  webFetch: true,
  browserAutomation: true,
  osControl: true,
  camera: false,
  desktopCamera: false,
  sandboxMode: 'workspace-write',
  unrestrictedPaths: false
};

describe('能力表', () => {
  it('每个能力都有唯一 key 与中文标签，且 key 索引与数组一致', () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of CAPABILITIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(CAPABILITY_BY_KEY[c.key]).toBe(c);
    }
  });

  it('默认快照：摄像头关着、电脑控制开着', () => {
    expect(capabilityEnabled('osControl', DEFAULTS_LIKE)).toBe(true);
    expect(capabilityEnabled('camera', DEFAULTS_LIKE)).toBe(false);
    expect(capabilityEnabled('desktopCamera', DEFAULTS_LIKE)).toBe(false);
  });

  it('hostControl 是文件/命令/浏览器的总闸，webFetch 独立于总闸', () => {
    const noHost = { ...DEFAULTS_LIKE, hostControl: false };
    expect(capabilityEnabled('fsRead', noHost)).toBe(false);
    expect(capabilityEnabled('fsWrite', noHost)).toBe(false);
    expect(capabilityEnabled('shellExec', noHost)).toBe(false);
    expect(capabilityEnabled('browser', noHost)).toBe(false);
    expect(capabilityEnabled('osControl', noHost)).toBe(false);
    expect(capabilityEnabled('webFetch', noHost)).toBe(true);
  });

  it('webFetch / browserAutomation 是「!== false」口径：缺字段时算开', () => {
    expect(capabilityEnabled('webFetch', { hostControl: true })).toBe(true);
    expect(capabilityEnabled('browser', { hostControl: true })).toBe(true);
    expect(capabilityEnabled('webFetch', { hostControl: true, webFetch: false })).toBe(false);
  });

  it('enabledCapabilities 分成两列且顺序稳定', () => {
    const { on, off } = enabledCapabilities(DEFAULTS_LIKE);
    expect(on).toEqual(['fsRead', 'fsWrite', 'shellExec', 'browser', 'webFetch', 'osControl']);
    expect(off).toEqual(['camera', 'desktopCamera']);
    const all = enabledCapabilities(null);
    expect(all.on).toEqual([]);
    expect(all.off.length).toBe(CAPABILITIES.length);
  });
});

describe('能力事实块', () => {
  it('没有权限快照时返回空串（不编假能力表）', () => {
    expect(formatCapabilityBlock()).toBe('');
    expect(formatCapabilityBlock({ permissions: null })).toBe('');
  });

  it('默认快照：列出已开与关着（关着是这段存在的理由）', () => {
    const text = formatCapabilityBlock({ permissions: DEFAULTS_LIKE });
    expect(text).toContain('【本轮能力事实】');
    expect(text).toContain('已开：读文件、写文件、执行 Shell、浏览器自动化、联网抓取、电脑控制（截屏/键鼠）');
    expect(text).toContain('关着（这些能力现在用不了，需要用户去设置里打开）：手机摄像头、本机摄像头');
    // 档位标签来自 SANDBOX_MODE_META；没有沙箱事实时退到原始档位名，不编文案
    expect(text).toContain('沙箱：workspace-write');
    expect(text).not.toContain('可写根');
  });

  it('沙箱事实：档位人话 + 可写根 + 内部目录个数 + 远端提示', () => {
    const text = formatCapabilityBlock({
      permissions: DEFAULTS_LIKE,
      sandbox: {
        mode: 'workspace-write',
        label: '工作区内可写（默认）',
        desc: '工作区里随便改；写工作区之外、装到系统目录这类动作会先问你一次。',
        workspaceRoots: ['E:\\proj'],
        grantedPaths: ['D:\\shared'],
        internalCount: 5,
        remoteGoverned: false
      }
    });
    expect(text).toContain('沙箱：工作区内可写（默认）（工作区里随便改');
    expect(text).toContain('可写根：E:\\proj、D:\\shared');
    expect(text).toContain('另含应用内部目录');
  });

  it('可写根超过 4 处时折叠成「另 N 处」', () => {
    const text = formatCapabilityBlock({
      permissions: DEFAULTS_LIKE,
      sandbox: {
        mode: 'workspace-write',
        label: '工作区内可写（默认）',
        workspaceRoots: ['/a', '/b', '/c', '/d', '/e'],
        internalCount: 0,
        remoteGoverned: false
      }
    });
    expect(text).toContain('（另 1 处）');
    expect(text).not.toContain('当前工作空间在远端主机');
  });

  it('远端会话不报本机可写根（那些根不参与远端写，报了就是误导）', () => {
    const { projectSandboxState } = require('../../src/agent/capability-index');
    const projected = projectSandboxState(
      {
        mode: 'workspace-write',
        workspaceRoots: ['E:\\local'],
        grantedPaths: ['D:\\shared'],
        internalRoots: ['/ud'],
        remoteGoverned: true
      },
      require('../../src/gateway/sandbox-policy').SANDBOX_MODE_META
    );
    expect(projected.workspaceRoots).toEqual([]);
    expect(projected.grantedPaths).toEqual([]);
    expect(projected.remoteGoverned).toBe(true);
    const text = formatCapabilityBlock({ permissions: DEFAULTS_LIKE, sandbox: projected });
    expect(text).not.toContain('可写根');
    expect(text).toContain('当前工作空间在远端主机');
  });

  it('主机控制关着时不写 host_exec 使用提示（那是给了它做不到的建议）', () => {
    const text = formatCapabilityBlock({ permissions: { ...DEFAULTS_LIKE, hostControl: false } });
    expect(text).not.toContain('Windows 的 host_exec 是 cmd');
    expect(text).toContain('已开：联网抓取');
  });
});

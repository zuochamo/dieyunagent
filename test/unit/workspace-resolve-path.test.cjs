'use strict';

/**
 * workspace.resolve_path 的编排逻辑（三态返回、护栏、路径补全）。
 *
 * 为什么值得单测：这是「Renderer 猜路径」改成「交给持有文件系统的那一层判断」
 * 的关键一步，而它只在 SSH 工作区生效 —— 无法在本地跑通全链路。
 * 所以把 IO 全部 mock 掉，只钉住编排：谁被调用、返回哪一态、护栏有没有生效。
 */

const path = require('path');
const { createWorkspaceHandlers } = require('../../src/gateway/handlers/workspace');

const ROOT = '/srv/app';

function makeDeps(overrides = {}) {
  const existing =
    overrides.existing instanceof Map
      ? overrides.existing
      : new Map((overrides.existing || []).map((p) => [p, 1700]));
  const globMap = overrides.globMap || {};
  const globCalls = [];
  const statCalls = [];
  const deps = {
    getRemoteFs: () => ({
      root: ROOT,
      // 真实 remoteFs.stat 会先 resolve（相对路径拼到 root 下）再 stat，这里照做，
      // 否则测不出「相对路径能不能命中」这条路径
      stat: async (p) => {
        const abs = path.posix.isAbsolute(p) ? p : path.posix.join(ROOT, p);
        statCalls.push(abs);
        if (overrides.statImpl) return overrides.statImpl(abs);
        if (existing.has(abs)) return { size: 42, mtimeMs: existing.get(abs) };
        const err = new Error('No such file');
        err.code = 'ENOENT';
        throw err;
      }
    }),
    globViaRemoteExec: async (cwd, opts) => {
      globCalls.push(opts);
      if (overrides.globImpl) return overrides.globImpl(cwd, opts);
      const list = globMap[opts.pattern];
      if (!list) return { ok: true, files: [], truncated: false, source: 'remote_rg' };
      return { ok: true, files: list, truncated: false, source: 'remote_rg' };
    },
    resolveCallWorkspaceTarget: () =>
      overrides.target === undefined ? { kind: 'ssh', remotePath: ROOT } : overrides.target,
    isSshConnectedForCall: () => overrides.connected !== false,
    getActiveCallSessionId: () => overrides.sessionId || 's1'
  };
  return { deps, globCalls, statCalls };
}

function handlerFor(overrides) {
  const { deps, globCalls, statCalls } = makeDeps(overrides);
  const handlers = createWorkspaceHandlers(deps);
  return { resolve: handlers['workspace.resolve_path'], globCalls, statCalls };
}

describe('workspace.resolve_path — 前置护栏', () => {
  it('空路径直接拒绝，不打远程', async () => {
    const { resolve, statCalls } = handlerFor({});
    const r = await resolve({ inputPath: '   ' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PATH');
    expect(statCalls).toHaveLength(0);
  });

  it('本地工作区不解析（本地路径无歧义，模糊匹配只会引入新风险）', async () => {
    const { resolve, statCalls, globCalls } = handlerFor({
      target: { kind: 'local', path: 'C:/proj' }
    });
    const r = await resolve({ inputPath: 'C:/proj/src/a.ts' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_SSH_WORKSPACE');
    expect(statCalls).toHaveLength(0);
    expect(globCalls).toHaveLength(0);
  });

  it('SSH 未连接时拒绝', async () => {
    const { resolve } = handlerFor({ connected: false });
    const r = await resolve({ inputPath: '/srv/app/a.ts' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSH_NOT_CONNECTED');
  });

  it('同一输入短时间内重入被节流（防连点造成远程 rg 风暴）', async () => {
    const { resolve } = handlerFor({});
    const first = await resolve({ inputPath: 'C:/x/a.ts' });
    expect(first.code).toBe('NOT_FOUND');
    const second = await resolve({ inputPath: 'C:/x/a.ts' });
    expect(second.code).toBe('THROTTLED');
  });

  it('不同输入的节流互不影响', async () => {
    const { resolve } = handlerFor({ globMap: { '**/a.ts': ['src/a.ts'] } });
    const first = await resolve({ inputPath: 'C:/x/a.ts' });
    const other = await resolve({ inputPath: 'C:/x/b.ts' });
    expect(first.ok).toBe(true);
    expect(other.code).toBe('NOT_FOUND');
  });
});

describe('workspace.resolve_path — Step 1 原样命中', () => {
  it('原路径存在时直接返回 exact，且不做任何搜索', async () => {
    const { resolve, globCalls } = handlerFor({ existing: ['/srv/app/src/a.ts'] });
    const r = await resolve({ inputPath: 'src/a.ts' });
    expect(r.ok).toBe(true);
    expect(r.exact).toBe(true);
    expect(r.path).toBe('src/a.ts');
    expect(r.candidates).toEqual([]);
    expect(globCalls).toHaveLength(0);
  });

  it('原路径 stat 抛越界错误时，不把它当目标，继续走候选查找', async () => {
    const { resolve } = handlerFor({
      statImpl: (abs) => {
        // 模拟 resolveRemotePath 的权威校验：越界直接抛 PATH_NOT_ALLOWED
        if (abs.startsWith('/etc/')) {
          const err = new Error('路径不在远程工作空间内');
          err.code = 'PATH_NOT_ALLOWED';
          throw err;
        }
        const err = new Error('No such file');
        err.code = 'ENOENT';
        throw err;
      },
      globMap: { '**/syslog': ['logs/syslog'] }
    });
    const r = await resolve({ inputPath: '/etc/syslog' });
    // 关键：越界路径本身绝不能被当成目标返回
    expect(r.ok).toBe(true);
    expect(r.exact).toBe(false);
    expect(r.candidates.map((c) => c.path)).toEqual(['/srv/app/logs/syslog']);
  });
});

describe('workspace.resolve_path — Step 2 候选查找', () => {
  it('由长到短尝试，命中即停（更长特征更精确，不再试更短的）', async () => {
    const { resolve, globCalls } = handlerFor({
      globMap: { '**/agent/foo.js': ['src/renderer/agent/foo.js'] }
    });
    const r = await resolve({ inputPath: 'C:\\Users\\me\\proj\\src\\renderer\\agent\\foo.js' });
    expect(r.ok).toBe(true);
    expect(r.exact).toBe(false);
    // 第一条（3 段）未命中，第二条（2 段）命中后必须停手，不能再试 '**/foo.js'
    expect(globCalls.map((c) => c.pattern)).toEqual(['**/renderer/agent/foo.js', '**/agent/foo.js']);
    expect(r.candidates.map((c) => c.path)).toEqual(['/srv/app/src/renderer/agent/foo.js']);
    expect(r.candidates[0].relativePath).toBe('src/renderer/agent/foo.js');
  });

  it('长特征零命中时逐级放宽到短特征', async () => {
    const { resolve, globCalls } = handlerFor({
      globMap: { '**/foo.js': ['lib/foo.js'] }
    });
    const r = await resolve({ inputPath: '/other/proj/src/agent/foo.js' });
    expect(r.ok).toBe(true);
    expect(globCalls.map((c) => c.pattern)).toEqual([
      '**/src/agent/foo.js',
      '**/agent/foo.js',
      '**/foo.js'
    ]);
    expect(r.candidates.map((c) => c.path)).toEqual(['/srv/app/lib/foo.js']);
  });

  it('把候选补成工作区绝对路径并带上 size/mtime', async () => {
    const { resolve } = handlerFor({
      existing: new Map([['/srv/app/src/a.ts', 1700]]),
      globMap: { '**/a.ts': ['src/a.ts'] }
    });
    const r = await resolve({ inputPath: 'C:/x/a.ts' });
    expect(r.candidates[0]).toMatchObject({
      path: '/srv/app/src/a.ts',
      relativePath: 'src/a.ts',
      size: 42,
      mtimeMs: 1700
    });
  });

  it('候选 stat 失败时退化为 0，不中断整次解析', async () => {
    const { resolve } = handlerFor({
      statImpl: () => {
        throw new Error('permission denied');
      },
      globMap: { '**/a.ts': ['src/a.ts'] }
    });
    const r = await resolve({ inputPath: 'C:/x/a.ts' });
    expect(r.ok).toBe(true);
    expect(r.candidates[0]).toMatchObject({ size: 0, mtimeMs: 0 });
  });

  it('多候选按 mtime 降序返回，并受 maxCandidates 约束', async () => {
    const { resolve } = handlerFor({
      existing: new Map([
        ['/srv/app/a.ts', 100],
        ['/srv/app/b.ts', 300],
        ['/srv/app/c.ts', 200]
      ]),
      globMap: { '**/a.ts': ['a.ts', 'b.ts', 'c.ts'] }
    });
    const r = await resolve({ inputPath: 'C:/x/a.ts', maxCandidates: 2 });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].mtimeMs).toBe(300);
    expect(r.candidates[1].mtimeMs).toBe(200);
    expect(r.truncated).toBe(true);
  });

  it('零命中返回 NOT_FOUND 并说明找过什么', async () => {
    const { resolve } = handlerFor({});
    const r = await resolve({ inputPath: '/other/proj/src/agent/foo.js' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(r.reason).toContain('src/agent/foo.js');
  });

  it('检索不可用时给出 SEARCH_UNAVAILABLE（与「真没有」区分开）', async () => {
    const { resolve } = handlerFor({
      globImpl: () => ({ ok: false, errorCode: 'GLOB_UNAVAILABLE', error: '远程没有 rg' })
    });
    const r = await resolve({ inputPath: 'C:/x/a.ts' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SEARCH_UNAVAILABLE');
    expect(r.reason).toContain('远程没有 rg');
  });

  it('没有可用文件名特征时直接拒绝，不打远程', async () => {
    const { resolve, globCalls } = handlerFor({});
    const r = await resolve({ inputPath: 'C:/' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(globCalls).toHaveLength(0);
  });

  it('返回 searched 便于排查（用了哪些模式、哪个根、花了多久）', async () => {
    const { resolve } = handlerFor({ globMap: { '**/a.ts': ['src/a.ts'] } });
    const r = await resolve({ inputPath: 'C:/x/a.ts' });
    expect(r.searched.roots).toEqual([ROOT]);
    // 'C:' 被过滤后只剩 ['x','a.ts']，故两条模式
    expect(r.searched.patterns).toEqual(['**/x/a.ts', '**/a.ts']);
    expect(typeof r.searched.elapsedMs).toBe('number');
  });
});

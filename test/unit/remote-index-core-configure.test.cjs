'use strict';

/**
 * 远端 index core 的 configure 语义（`src/remote/remote-index-core.js#applyConfigure`）：
 *
 * 载荷里**没带** embedding 时必须保留上一次的。远端 daemon / 每个工作区的 core 都是长命进程，
 * core 被重启时 `_ensureStarted` 用的是 `configureOpts || {}` —— 一旦被空载荷覆盖，core 会以
 * 「没有 embedding 模型」的状态起来，建向量永远停在 embedding 阶段（2026-11-09 真机现场：
 * 换 embedding 模型后 `embeddingModel=null`、`vectorCount=0`、index.sqlite 的 WAL 不再增长）。
 *
 * 显式 `disabled: true` 仍要照办 —— 那是「关掉语义」的用户意图，不是缺省。
 */

const { RemoteIndexCoreHost, buildCoreConfigurePayload } = require('../../src/remote/remote-index-core');

const EMBED = {
  disabled: false,
  baseUrl: 'http://192.168.31.62:5018/v1',
  apiKey: 'sk-test',
  model: 'text-embedding-zen-embedding-8b',
  dimensions: 4096,
  headers: {},
  authMode: ''
};

/** 不落盘、不起进程的 host：只观察 configureOpts 与投给 bridge 的载荷 */
function fakeHost() {
  const host = new RemoteIndexCoreHost({ workspaceRoot: '/w/proj', packRoot: '/nonexistent-pack' });
  host.hasBinary = () => true;
  host._ensureStarted = async () => {};
  const sent = [];
  host._configureBridge = async (opts) => {
    sent.push(buildCoreConfigurePayload({ workspaceRoot: '/w/proj', runtimeDataDir: '/w/.d', indexDbPath: '/w/.dieyun/index.sqlite', opts }));
    return { ok: true };
  };
  return { host, sent };
}

describe('远端 index core 的 configure', () => {
  it('空载荷不会把上一次的 embedding 覆盖成空', async () => {
    const { host, sent } = fakeHost();
    await host.applyConfigure({ embedding: EMBED });
    expect(sent[0].embedding.model).toBe('text-embedding-zen-embedding-8b');

    await host.applyConfigure({});
    expect(host.configureOpts.embedding.model).toBe('text-embedding-zen-embedding-8b');
    expect(sent[1].embedding.model).toBe('text-embedding-zen-embedding-8b');
    expect(sent[1].embedding.dimensions).toBe(4096);
  });

  it('显式的 disabled:true 仍然生效（不是缺省，是用户关掉语义）', async () => {
    const { host, sent } = fakeHost();
    await host.applyConfigure({ embedding: EMBED });
    await host.applyConfigure({ embedding: { disabled: true } });
    expect(sent[1].embedding.disabled).toBe(true);
  });

  it('换模型时按新值下发（不被上一次的粘住）', async () => {
    const { host, sent } = fakeHost();
    await host.applyConfigure({ embedding: EMBED });
    await host.applyConfigure({
      embedding: { ...EMBED, model: 'text-embedding-qwen3-embedding-4b', dimensions: 2560 }
    });
    expect(sent[1].embedding.model).toBe('text-embedding-qwen3-embedding-4b');
    expect(sent[1].embedding.dimensions).toBe(2560);
  });
});

'use strict';
/**
 * 远程 dieyun-core 的 configure 载荷：data_dir（记忆/账本库）必须落在 $HOME，
 * 项目目录只放 index_db_path。
 *
 * 现场：`_configureBridge` 曾把 data_dir 写成 `<workspace>/.dieyun`，等于
 * 把记忆库塞回用户项目里，还和项目 index.sqlite 挤同一目录。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { buildCoreConfigurePayload } = require('../../src/remote/remote-index-core');

describe('远程 core configure 载荷', () => {
  it('记忆库落在 $HOME，不在工作区里', () => {
    const runtimeDataDir = path.join(os.homedir(), '.dieyunagent');
    const p = buildCoreConfigurePayload({
      workspaceRoot: '/srv/proj',
      runtimeDataDir,
      indexDbPath: '/srv/proj/.dieyun/index.sqlite',
      opts: {}
    });
    assert.equal(p.data_dir, runtimeDataDir);
    assert.ok(!String(p.data_dir).includes('/srv/proj'), '记忆库不许跟着项目走');
    assert.equal(p.index_db_path, '/srv/proj/.dieyun/index.sqlite');
    assert.deepEqual(p.workspace_roots, ['/srv/proj']);
  });

  it('embedding 的 headers / authMode 透传（缺了远程只能靠 apiKey 硬拼）', () => {
    const p = buildCoreConfigurePayload({
      workspaceRoot: '/srv/proj',
      runtimeDataDir: '/home/u/.dieyunagent',
      indexDbPath: '/srv/proj/.dieyun/index.sqlite',
      opts: {
        embedding: {
          disabled: false,
          builtin: false,
          baseUrl: 'https://emb.example.com/v1',
          apiKey: 'k',
          model: 'bge-m3',
          dimensions: 1024,
          headers: { 'x-opencode-session': 's1', Authorization: 'Bearer k' },
          authMode: 'header'
        }
      }
    });
    assert.equal(p.embedding.headers['x-opencode-session'], 's1');
    assert.equal(p.embedding.authMode, 'header');
    assert.equal(p.embedding.model, 'bge-m3');
  });

  it('没有 embedding 配置时默认关闭，不炸', () => {
    const p = buildCoreConfigurePayload({
      workspaceRoot: '/srv/proj',
      runtimeDataDir: '/home/u/.dieyunagent',
      indexDbPath: '/srv/proj/.dieyun/index.sqlite',
      opts: {}
    });
    assert.equal(p.embedding.disabled, true);
    assert.deepEqual(p.embedding.headers, {});
    assert.equal(p.embedding.dimensions, 1024);
  });
});

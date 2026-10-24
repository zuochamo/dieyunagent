'use strict';
/**
 * 插件「从 URL 直接安装」（`src/plugins/catalog.js` `installFromUrl`）。
 *
 * 守的语义：
 * 1. 空 URL → PLUGIN_CATALOG_BAD_URL，且不触发下载与安装；
 * 2. 正常 URL → 复用 _downloadZip（同源 SSRF 校验/大小上限）→ host.installFromZip → 删除临时 zip；
 * 3. installFromZip 抛错时临时 zip 仍被清理（finally 兜底）；
 * 4. opts（如 allowDowngrade）原样透传给 host.installFromZip。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PluginCatalog } = require('../../src/plugins/catalog');

function makeCatalog(hostOverrides) {
  const host = Object.assign(
    {
      installFromZip: async () => ({ list: [], action: 'install' }),
      installFromPath: async () => ({ list: [], action: 'install' }),
      listPublic: () => []
    },
    hostOverrides || {}
  );
  return { catalog: new PluginCatalog({ appRoot: process.cwd(), host, log: () => {} }), host };
}

function stubDownload(catalog, zipPath) {
  catalog._downloadZip = async (url, expectedSha) => {
    catalog.downloadCalls = (catalog.downloadCalls || []).concat([{ url, expectedSha }]);
    return zipPath;
  };
}

test('空 URL 拒绝且不下载不安装', async () => {
  const { catalog, host } = makeCatalog({
    installFromZip: async () => {
      throw new Error('不应被调用');
    }
  });
  stubDownload(catalog, 'x.zip');
  await assert.rejects(
    () => catalog.installFromUrl('   '),
    (e) => e.code === 'PLUGIN_CATALOG_BAD_URL'
  );
  assert.equal((catalog.downloadCalls || []).length, 0);
  assert.equal(host.listPublic !== undefined, true);
});

test('正常 URL：下载 → installFromZip → 清理临时 zip，opts 透传', async () => {
  const zipPath = path.join(os.tmpdir(), `dieyun-plugin-test-${Date.now()}.zip`);
  fs.writeFileSync(zipPath, 'fake');
  const seen = {};
  const { catalog } = makeCatalog({
    installFromZip: async (zp, opts) => {
      seen.zipPath = zp;
      seen.opts = opts;
      return { list: [{ id: 'demo' }], action: 'install' };
    }
  });
  stubDownload(catalog, zipPath);

  const result = await catalog.installFromUrl('https://example.com/demo.zip', {
    allowDowngrade: true
  });
  assert.deepEqual(result.list, [{ id: 'demo' }]);
  assert.equal(seen.zipPath, zipPath, 'installFromZip 收到下载落盘路径');
  assert.deepEqual(seen.opts, { allowDowngrade: true }, 'opts 原样透传');
  assert.equal(fs.existsSync(zipPath), false, '安装后临时 zip 应被删除');
  assert.deepEqual(catalog.downloadCalls, [
    { url: 'https://example.com/demo.zip', expectedSha: null }
  ]);
});

test('installFromZip 失败仍清理临时 zip', async () => {
  const zipPath = path.join(os.tmpdir(), `dieyun-plugin-test-${Date.now()}.zip`);
  fs.writeFileSync(zipPath, 'fake');
  const { catalog } = makeCatalog({
    installFromZip: async () => {
      throw new Error('manifest 非法');
    }
  });
  stubDownload(catalog, zipPath);
  await assert.rejects(() => catalog.installFromUrl('https://example.com/bad.zip'), /manifest 非法/);
  assert.equal(fs.existsSync(zipPath), false, '失败路径也必须清理临时 zip');
});

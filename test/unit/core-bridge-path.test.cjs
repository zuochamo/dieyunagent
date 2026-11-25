'use strict';

/**
 * dieyun-core 本地路径解析：打包态的候选顺序（唯一实现在 src/core-bridge-path.js）。
 *
 * 为什么值得钉住：Linux 安装包**只在远端注入包里存一份 Linux core**（同一个 ELF 不存两遍，
 * 见 package.json build.linux 与 scripts/after-pack-win-icon.cjs），解析顺序一旦漂了，
 * Linux 桌面包会表现为「core 未就绪 → Agent 不可用」，而 Windows 上一切正常 —— 最难查的那种。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveDieyunCoreBinary } = require('../../src/core-bridge-path');

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc);
  }
}

function withResources(resourcesPath, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process, 'resourcesPath', desc);
    else delete process.resourcesPath;
  }
}

it('打包态 core 路径：Windows 认 PE、Linux 认远端 pack 里那一份', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-core-path-'));
  const savedEnv = process.env.DIEYUN_CORE_BIN;
  delete process.env.DIEYUN_CORE_BIN;
  try {
    // --- Windows 打包态：只认 resources/dieyun-core/dieyun-core.exe
    const winRes = path.join(tmp, 'win');
    fs.mkdirSync(path.join(winRes, 'dieyun-core'), { recursive: true });
    fs.writeFileSync(path.join(winRes, 'dieyun-core', 'dieyun-core.exe'), 'MZ');
    // 远端注入包里那份是 Linux ELF，Windows 绝不该拿它当本机 sidecar
    fs.mkdirSync(path.join(winRes, 'remote-gateway-pack', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(winRes, 'remote-gateway-pack', 'bin', 'dieyun-core'), '\x7fELF');
    assert.strictEqual(
      withPlatform('win32', () => withResources(winRes, () => resolveDieyunCoreBinary())),
      path.join(winRes, 'dieyun-core', 'dieyun-core.exe')
    );

    // --- Windows 打包态但缺 PE：不许退化到 pack 里的 Linux core
    const winBare = path.join(tmp, 'win-bare');
    fs.mkdirSync(path.join(winBare, 'remote-gateway-pack', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(winBare, 'remote-gateway-pack', 'bin', 'dieyun-core'), '\x7fELF');
    const winBareGot = withPlatform('win32', () =>
      withResources(winBare, () => resolveDieyunCoreBinary())
    );
    assert.ok(
      winBareGot === null || !String(winBareGot).includes('remote-gateway-pack'),
      'Windows 不得把远端注入包里的 Linux core 当本机 sidecar：' + winBareGot
    );

    // --- Linux 打包态：core 只在 pack 里（build.linux 不再有独立 extraResources）
    const linRes = path.join(tmp, 'linux');
    fs.mkdirSync(path.join(linRes, 'remote-gateway-pack', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(linRes, 'remote-gateway-pack', 'bin', 'dieyun-core'), '\x7fELF');
    assert.strictEqual(
      withPlatform('linux', () => withResources(linRes, () => resolveDieyunCoreBinary())),
      path.join(linRes, 'remote-gateway-pack', 'bin', 'dieyun-core')
    );

    // --- Linux 老安装包（两份都在）：优先用独立那份，升级不改变行为
    const linOld = path.join(tmp, 'linux-old');
    fs.mkdirSync(path.join(linOld, 'dieyun-core'), { recursive: true });
    fs.writeFileSync(path.join(linOld, 'dieyun-core', 'dieyun-core'), '\x7fELF');
    fs.mkdirSync(path.join(linOld, 'remote-gateway-pack', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(linOld, 'remote-gateway-pack', 'bin', 'dieyun-core'), '\x7fELF');
    assert.strictEqual(
      withPlatform('linux', () => withResources(linOld, () => resolveDieyunCoreBinary())),
      path.join(linOld, 'dieyun-core', 'dieyun-core')
    );

    // --- 环境变量优先于一切
    process.env.DIEYUN_CORE_BIN = path.join(linRes, 'remote-gateway-pack', 'bin', 'dieyun-core');
    assert.strictEqual(
      withPlatform('linux', () => withResources(linRes, () => resolveDieyunCoreBinary())),
      process.env.DIEYUN_CORE_BIN
    );
  } finally {
    if (savedEnv === undefined) delete process.env.DIEYUN_CORE_BIN;
    else process.env.DIEYUN_CORE_BIN = savedEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

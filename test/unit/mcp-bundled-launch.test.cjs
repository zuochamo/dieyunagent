'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  resolveBundledMcpEntry,
  resolveBundledMcpLaunch
} = require('../../src/mcp/bundled-launch');
const {
  packLooksComplete,
  patchLauncherHideConsole
} = require('../../scripts/pack-mcp-bundled.cjs');
const { getBuiltinMcpById } = require('../../src/mcp/registry');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const FAKE_EXE = Buffer.from('MZ-fake-binary');

/** 上游 launcher 起原生二进制那一行（未打补丁，会弹控制台窗口） */
const LAUNCHER_UPSTREAM = "const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });\n";
/** 打过补丁后的同一行 */
const LAUNCHER_PATCHED =
  "const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', windowsHide: true });\n";

describe('预装 MCP 启动解析（离线预装产物）', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-bundled-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * 造一份最小预装产物：manifest.json + pkg/bin/cli.js + pkg/vendor/<exe>。
   * 布局由 manifest 声明，测试不依赖脚本的实现细节。
   * launcher 默认写成「已打补丁」的样子 —— 与 pack 脚本的产出一致。
   */
  function writePack(dirName, patch = {}) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(path.join(dir, 'pkg', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pkg', 'vendor'), { recursive: true });
    const launcher = patch.__launcher === 'upstream' ? LAUNCHER_UPSTREAM : LAUNCHER_PATCHED;
    fs.writeFileSync(path.join(dir, 'pkg', 'bin', 'cli.js'), launcher, 'utf8');
    if (!patch.__skipBinary) {
      fs.writeFileSync(path.join(dir, 'pkg', 'vendor', 'x.exe'), FAKE_EXE);
    }
    const manifest = {
      id: dirName,
      packageName: 'x',
      version: '0.1.10',
      // 与 pack 脚本一致：manifest 里的相对路径用正斜杠（跨平台可解析）
      entry: 'pkg/bin/cli.js',
      binary: 'pkg/vendor/x.exe',
      binarySha256: sha256(FAKE_EXE),
      ...patch
    };
    delete manifest.__skipBinary;
    delete manifest.__launcher;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return dir;
  }

  it('按 manifest 声明解析入口（不假设目录结构）', () => {
    const dir = writePack('mcp-postgres');
    const resolved = resolveBundledMcpEntry('mcp-postgres', [root]);
    expect(resolved.entry).toBe(path.join(dir, 'pkg', 'bin', 'cli.js'));
    expect(resolved.manifest.version).toBe('0.1.10');
  });

  it('manifest 声明的二进制缺失 → 失败关闭（BUNDLED_MCP_MISSING）', () => {
    writePack('mcp-postgres', { __skipBinary: true });
    expect(() => resolveBundledMcpEntry('mcp-postgres', [root])).toThrow(/缺少平台二进制/);
    try {
      resolveBundledMcpEntry('mcp-postgres', [root]);
    } catch (e) {
      expect(e.code).toBe('BUNDLED_MCP_MISSING');
    }
  });

  it('manifest 声明的 entry 越界（../）不被接受', () => {
    writePack('mcp-postgres', { entry: path.join('..', '..', 'evil.js') });
    expect(() => resolveBundledMcpEntry('mcp-postgres', [root])).toThrow(/非法或越界/);
  });

  // 核心回归：预装启动必须保留服务自身参数。
  // mcp-postgres 的 `--stdio` 丢掉后服务会去开 HTTP 监听，客户端表现为静默挂住。
  it('预装启动保留 --stdio，剥掉 npx 专用的 -y 与包名规格', () => {
    writePack('mcp-postgres');
    const server = getBuiltinMcpById('mcp-postgres');
    expect(server.bundledServer).toBe('mcp-postgres');
    const launch = resolveBundledMcpLaunch(server, [root]);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe(path.join(root, 'mcp-postgres', 'pkg', 'bin', 'cli.js'));
    expect(launch.args.slice(1)).toEqual(['--stdio']);
    expect(launch.launchEnv.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('非预装服务返回 null（不影响普通 npx / remote 服务）', () => {
    writePack('mcp-postgres');
    expect(resolveBundledMcpLaunch({ id: 'mcp-x', command: 'npx', args: ['-y', 'pkg'] }, [root])).toBeNull();
    expect(resolveBundledMcpLaunch({ id: 'mcp-y', remoteUrl: 'https://e.com/mcp' }, [root])).toBeNull();
  });

  it('预装产物完全不存在 → BUNDLED_MCP_MISSING（带可执行的修法）', () => {
    const launch = () => resolveBundledMcpLaunch({ id: 'mcp-postgres', bundledServer: 'mcp-postgres' }, [root]);
    expect(launch).toThrow(/预装 MCP 入口不存在/);
    try {
      launch();
    } catch (e) {
      expect(e.code).toBe('BUNDLED_MCP_MISSING');
    }
  });

  // 纯 JS 预装服务（随 app.asar 分发、不需要 manifest 产物）这条捷径已随叠云 Open API 四件套一起删除：
  // 现在「预装」＝必须有 manifest 产物，没有就是没预装（返回 null，交给调用方按普通服务走）。
  it('没有 manifest 产物就不算预装', () => {
    expect(resolveBundledMcpEntry('not-bundled-anywhere', [])).toBeNull();
  });
});

describe('预装产物完成判定（决定是否重新 pack）', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-pack-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('版本一致且二进制校验通过才算完成；改一个字节或换版本都要重打包', () => {
    const dir = path.join(root, 'mcp-postgres');
    fs.mkdirSync(path.join(dir, 'pkg', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pkg', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'bin', 'cli.js'), LAUNCHER_PATCHED, 'utf8');
    fs.writeFileSync(path.join(dir, 'pkg', 'vendor', 'x.exe'), FAKE_EXE);
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        packageName: 'x',
        version: '0.1.10',
        // 平台/架构是产物的一部分：同一份 build/ 目录被多平台构建复用时，
        // 不能把 Windows 产物当成 Linux 的「已完成」用（pack 脚本里那条闸门）。
        platform: process.platform,
        arch: process.arch,
        entry: path.join('pkg', 'bin', 'cli.js'),
        binary: path.join('pkg', 'vendor', 'x.exe'),
        binarySha256: sha256(FAKE_EXE)
      }),
      'utf8'
    );

    expect(packLooksComplete(dir, { name: 'x', version: '0.1.10' })).toBe(true);
    // 版本脱钩（registry 升版但产物没重打）
    expect(packLooksComplete(dir, { name: 'x', version: '0.1.11' })).toBe(false);
    // 换了平台（产物是别的系统打的）同样要重打包
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        packageName: 'x',
        version: '0.1.10',
        platform: process.platform === 'win32' ? 'linux' : 'win32',
        arch: process.arch,
        entry: path.join('pkg', 'bin', 'cli.js'),
        binary: path.join('pkg', 'vendor', 'x.exe'),
        binarySha256: sha256(FAKE_EXE)
      }),
      'utf8'
    );
    expect(packLooksComplete(dir, { name: 'x', version: '0.1.10' })).toBe(false);
    // 复原成当前平台产物，再验证「字节被替换」这条
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        packageName: 'x',
        version: '0.1.10',
        platform: process.platform,
        arch: process.arch,
        entry: path.join('pkg', 'bin', 'cli.js'),
        binary: path.join('pkg', 'vendor', 'x.exe'),
        binarySha256: sha256(FAKE_EXE)
      }),
      'utf8'
    );
    // 产物被替换/损坏
    fs.writeFileSync(path.join(dir, 'pkg', 'vendor', 'x.exe'), Buffer.from('tampered'));
    expect(packLooksComplete(dir, { name: 'x', version: '0.1.10' })).toBe(false);
  });

  // 版本没变但缺补丁 → 必须判定为「未完成」，否则旧产物会一直弹窗口
  it('launcher 没打防弹窗补丁的旧产物视为未完成（强制重打包）', () => {
    const dir = path.join(root, 'mcp-postgres');
    fs.mkdirSync(path.join(dir, 'pkg', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pkg', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'bin', 'cli.js'), LAUNCHER_UPSTREAM, 'utf8');
    fs.writeFileSync(path.join(dir, 'pkg', 'vendor', 'x.exe'), FAKE_EXE);
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        packageName: 'x',
        version: '0.1.10',
        entry: path.join('pkg', 'bin', 'cli.js'),
        binary: path.join('pkg', 'vendor', 'x.exe'),
        binarySha256: sha256(FAKE_EXE)
      }),
      'utf8'
    );

    expect(packLooksComplete(dir, { name: 'x', version: '0.1.10' })).toBe(false);
  });
});

/**
 * 为什么需要这个补丁：上游 launcher 起原生二进制时没传 windowsHide。
 * app 与 launcher 自己都是 GUI 子系统 / 无控制台进程，Windows 对控制台子进程必须新分配一个控制台，
 * 于是每次连接 mcp-postgres 都弹一个黑窗口（2026-10-16 实测：electron 父进程下窗口 11→12）。
 */
describe('预装 launcher 的防弹窗补丁（打包期打到上游字节上）', () => {
  it('上游原文 → 补上 windowsHide', () => {
    const r = patchLauncherHideConsole(LAUNCHER_UPSTREAM);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('windowsHide: true');
    expect(r.text).toContain("stdio: 'inherit'");
  });

  it('重复执行幂等（改了字节不重复改）', () => {
    const once = patchLauncherHideConsole(LAUNCHER_UPSTREAM).text;
    const twice = patchLauncherHideConsole(once);
    expect(twice.ok).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });

  it('上游自己修好了（写法不同）也放行，不强改字节', () => {
    const upstreamFixed =
      'const child = spawn(bin, process.argv.slice(2), { windowsHide: true, stdio: \'inherit\' });\n';
    const r = patchLauncherHideConsole(upstreamFixed);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(upstreamFixed);
  });

  it('上游结构变了（锚点找不到且没有 windowsHide）→ 失败关闭，拒绝产出带窗口的包', () => {
    const unknown = 'const child = spawn(bin, argv, { stdio: "inherit", detached: false });\n';
    const r = patchLauncherHideConsole(unknown);
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(unknown);
  });
});

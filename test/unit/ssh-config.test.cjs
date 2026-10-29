'use strict';
/**
 * `~/.ssh/config` 解析：别名、优先级（第一个值生效）、Host 通配与取反、Include、ProxyJump。
 * 这些都是「猜错就会连到错的主机」的地方，逐条固定住。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseSshConfigText,
  resolveHostConfig,
  loadSshConfig,
  parseProxyJump,
  hostPatternsMatch,
  globMatch,
  splitArgs,
  stripComment
} = require('../../src/ssh/ssh-config');

const CFG = [
  '# 注释行',
  'Host prod',
  '  HostName 10.0.0.5',
  '  User deploy',
  '  Port 2200',
  '  IdentityFile ~/.ssh/id_prod',
  '',
  'Host *.internal !secret.internal',
  '  User admin',
  '  ProxyJump bastion',
  '',
  'Host bastion',
  '  HostName bastion.example.com',
  '  User jump',
  '  Port 2222',
  '',
  'Host *',
  '  User fallback',
  '  ServerAliveInterval 30'
].join('\n');

describe('ssh-config 解析', () => {
  const blocks = parseSshConfigText(CFG);

  it('别名解析出 HostName / User / Port / IdentityFile', () => {
    const r = resolveHostConfig(blocks, 'prod');
    assert.equal(r.matched, true);
    assert.equal(r.hostName, '10.0.0.5');
    assert.equal(r.user, 'deploy');
    assert.equal(r.port, 2200);
    assert.equal(r.identityFiles.length, 1);
    assert.ok(r.identityFiles[0].endsWith('id_prod'), r.identityFiles[0]);
  });

  it('每个参数第一个匹配到的值生效（Host * 不许覆盖前面的 User）', () => {
    assert.equal(resolveHostConfig(blocks, 'prod').user, 'deploy');
  });

  it('Host 通配命中，`!` 取反的块整体不生效', () => {
    assert.equal(resolveHostConfig(blocks, 'app.internal').user, 'admin');
    // secret.internal 被取反 → 只能落到 Host * 的 fallback
    assert.equal(resolveHostConfig(blocks, 'secret.internal').user, 'fallback');
  });

  it('没匹配到任何块时 matched=false（调用方据此不当别名处理）', () => {
    const only = parseSshConfigText('Host a\n  User u');
    assert.equal(resolveHostConfig(only, 'zzz').matched, false);
  });

  it('ProxyJump 原样带出，交由上层解析', () => {
    assert.equal(resolveHostConfig(blocks, 'app.internal').proxyJump, 'bastion');
    assert.deepEqual(parseProxyJump('bastion'), [{ username: '', host: 'bastion', port: 22 }]);
  });

  it('Match 块整体忽略（猜错语义比不应用更危险）', () => {
    const mixed = parseSshConfigText(
      ['Host x', '  User ux', 'Match host y', '  User other', 'Host z', '  User uz'].join('\n')
    );
    assert.equal(resolveHostConfig(mixed, 'x').user, 'ux');
    assert.equal(resolveHostConfig(mixed, 'z').user, 'uz');
    assert.equal(resolveHostConfig(mixed, 'y').matched, false);
  });

  it('支持 `Key=Value` 写法与引号内的空格', () => {
    const eq = parseSshConfigText('Host q\n  User=qu\n  IdentityFile "C:\\Users\\me\\my key"');
    const r = resolveHostConfig(eq, 'q');
    assert.equal(r.user, 'qu');
    assert.equal(r.identityFiles[0], 'C:\\Users\\me\\my key');
  });
});

describe('ssh-config include', () => {
  const home = path.resolve(path.sep + 'tmp', 'ssh-home-test');
  const configPath = path.join(home, '.ssh', 'config');
  const extraPath = path.join(home, '.ssh', 'conf.d', '01-extra.conf');
  const files = new Map([
    [configPath, 'Include conf.d/*.conf\nHost a\n  User ua\n'],
    [extraPath, 'Host b\n  User ub\n']
  ]);
  const fsApi = {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
      return files.get(p);
    },
    readdirSync: (dir) => {
      const out = [];
      for (const key of files.keys()) {
        if (path.dirname(key) === dir) out.push(path.basename(key));
      }
      return out;
    },
    statSync: () => {
      throw new Error('ENOENT');
    }
  };

  it('Include 支持通配并被就地展开（顺序 = 文件出现顺序）', () => {
    const blocks = loadSshConfig({ home, fsApi });
    assert.equal(resolveHostConfig(blocks, 'b').user, 'ub');
    assert.equal(resolveHostConfig(blocks, 'a').user, 'ua');
  });

  it('include 环不会无限递归', () => {
    const loop = new Map([[configPath, 'Include config\nHost a\n  User ua\n']]);
    const loopFs = {
      readFileSync: (p) => loop.get(p),
      readdirSync: () => [],
      statSync: () => {
        throw new Error('ENOENT');
      }
    };
    const blocks = loadSshConfig({ home, fsApi: loopFs });
    assert.equal(resolveHostConfig(blocks, 'a').user, 'ua');
  });

  it('配置文件缺失时返回空列表而不是抛错', () => {
    const blocks = loadSshConfig({ home: path.resolve(path.sep + 'tmp', 'nope'), fsApi });
    assert.deepEqual(blocks, []);
  });

  /**
   * `Include a b` 是合法的（一行多个路径），带引号的路径也合法。
   * 以前把整串当成一个文件名 → 两个文件都不读，配置里的主机静默消失。
   */
  it('Include 一行多个路径：每个都展开', () => {
    const home2 = path.resolve(path.sep + 'tmp', 'ssh-home-multi');
    const main = path.join(home2, '.ssh', 'config');
    const f1 = path.join(home2, '.ssh', 'a.conf');
    const f2 = path.join(home2, '.ssh', 'b.conf');
    const map = new Map([
      [main, `Include ${f1} ${f2}\nHost local\n  User ul\n`],
      [f1, 'Host from-a\n  User ua\n'],
      [f2, 'Host from-b\n  User ub\n']
    ]);
    const fs2 = {
      readFileSync: (p) => {
        if (!map.has(p)) throw Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
        return map.get(p);
      },
      readdirSync: () => [],
      statSync: (p) => {
        if (!map.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mtimeMs: 1, size: map.get(p).length };
      }
    };
    const blocks = loadSshConfig({ home: home2, fsApi: fs2 });
    assert.equal(resolveHostConfig(blocks, 'from-a').user, 'ua');
    assert.equal(resolveHostConfig(blocks, 'from-b').user, 'ub');
    assert.equal(resolveHostConfig(blocks, 'local').user, 'ul');
  });

  it('Include 的路径带引号（含空格）时能读到', () => {
    const home3 = path.resolve(path.sep + 'tmp', 'ssh-home-quoted');
    const main = path.join(home3, '.ssh', 'config');
    const spaced = path.join(home3, '.ssh', 'my configs', 'work.conf');
    const map = new Map([
      [main, `Include "${spaced}"\nHost local\n  User ul\n`],
      [spaced, 'Host work\n  User uw\n']
    ]);
    const fs3 = {
      readFileSync: (p) => {
        if (!map.has(p)) throw Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
        return map.get(p);
      },
      readdirSync: () => [],
      statSync: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    };
    const blocks = loadSshConfig({ home: home3, fsApi: fs3 });
    assert.equal(resolveHostConfig(blocks, 'work').user, 'uw');
  });
});

/**
 * 缓存只看主 config 的 mtime 时，「改了 Include 里的文件」永远不生效 ——
 * 用户改完 ssh config、点连接，还是按旧配置去连。
 */
describe('ssh-config 缓存失效', () => {
  it('被 Include 的文件改了内容：缓存自动失效，读到新值', () => {
    const { getSshConfigBlocks, resetSshConfigCache } = require('../../src/ssh/ssh-config');
    const home = path.resolve(path.sep + 'tmp', 'ssh-home-cache');
    const main = path.join(home, '.ssh', 'config');
    const inc = path.join(home, '.ssh', 'conf.d', 'work.conf');
    const contents = new Map([
      [main, 'Include conf.d/work.conf\n'],
      [inc, 'Host work\n  User olduser\n']
    ]);
    const stamps = new Map([
      [main, 100],
      [inc, 200]
    ]);
    const fsApi2 = {
      readFileSync: (p) => {
        if (!contents.has(p)) throw Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
        return contents.get(p);
      },
      readdirSync: (dir) =>
        [...contents.keys()].filter((k) => path.dirname(k) === dir).map((k) => path.basename(k)),
      statSync: (p) => {
        if (!contents.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mtimeMs: stamps.get(p) || 0, size: contents.get(p).length };
      }
    };

    resetSshConfigCache();
    assert.equal(resolveHostConfig(getSshConfigBlocks({ home, fsApi: fsApi2 }), 'work').user, 'olduser');

    // 只改被 Include 的文件（主 config 的 mtime 完全不动）
    contents.set(inc, 'Host work\n  User newuser\n');
    stamps.set(inc, 201);
    assert.equal(
      resolveHostConfig(getSshConfigBlocks({ home, fsApi: fsApi2 }), 'work').user,
      'newuser',
      '改了 Include 的文件必须生效'
    );

    // 未改动时命中缓存（不重复解析）
    const a = getSshConfigBlocks({ home, fsApi: fsApi2 });
    const b = getSshConfigBlocks({ home, fsApi: fsApi2 });
    assert.equal(a, b, '内容没变时应返回同一份缓存数组');
    resetSshConfigCache();
  });
});

describe('ssh-config 小工具', () => {
  it('glob 只支持 * 与 ?，且不把正则元字符当语法', () => {
    assert.equal(globMatch('a*c', 'abc'), true);
    assert.equal(globMatch('a?c', 'abc'), true);
    assert.equal(globMatch('a.c', 'abc'), false);
  });

  it('splitArgs 处理引号与空段', () => {
    assert.deepEqual(splitArgs('a "b c"  d'), ['a', 'b c', 'd']);
    assert.deepEqual(splitArgs('   '), []);
  });

  it('stripComment 保留引号里的 #，去掉行尾注释', () => {
    assert.equal(stripComment('User a # comment'), 'User a ');
    assert.equal(stripComment('User "a#b"'), 'User "a#b"');
    assert.equal(stripComment('# whole line'), '');
  });

  it('hostPatternsMatch 忽略大小写', () => {
    const b = parseSshConfigText('Host ProdBox\n  User u');
    assert.equal(hostPatternsMatch(b[0].patterns, 'prodbox'), true);
  });

  it('ProxyJump 多跳 / none / ipv6 方括号', () => {
    assert.deepEqual(parseProxyJump('u@j1:2222,j2'), [
      { username: 'u', host: 'j1', port: 2222 },
      { username: '', host: 'j2', port: 22 }
    ]);
    assert.deepEqual(parseProxyJump('none'), []);
    assert.deepEqual(parseProxyJump('[::1]:2200'), [{ username: '', host: '::1', port: 2200 }]);
  });
});

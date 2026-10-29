'use strict';

/**
 * `~/.ssh/config` 读取与解析（Host 别名 → 实际地址 / 用户 / 端口 / 私钥 / 跳板）。
 *
 * 为什么要读它：改造前只有「手输 IP + 手输用户名 + 密码或私钥文件」一种方式，
 * 而运维/开发机器上的可达性信息（跳板、非 22 端口、身份文件、`Host` 别名）
 * 全都写在 `~/.ssh/config` 里。不读，就等于要求用户把 `ssh` 已经知道的东西再抄一遍，
 * 而且抄不出 ProxyJump。
 *
 * 只实现「解析 + 解析别名」这一件事：真正的连接参数装配在 connect-payload.js，
 * 不要把 ssh2 的概念漏进来（本文件不 require ssh2，纯字符串处理 + 可注入 fs）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Include 允许的嵌套层数：挡住 include 环与超深目录树。 */
const MAX_INCLUDE_DEPTH = 4;
/** 我们在意的键（其余键照常解析但不参与别名解析，避免假装支持）。 */
const RESOLVED_KEYS = ['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'proxycommand'];
/** 支持 `Include` 的键名 */
const INCLUDE_KEY = 'include';

/**
 * 去掉行尾注释。`#` 在引号内、或紧贴非空白字符（如 `Host a#b`）时不算注释。
 * @param {string} line
 */
function stripComment(line) {
  const s = String(line || '');
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/**
 * 按空白切分，支持双引号/单引号包裹的参数（`IdentityFile "C:\Users\a b\id"`）。
 * @param {string} text
 * @returns {string[]}
 */
function splitArgs(text) {
  const out = [];
  const s = String(text || '');
  let cur = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

/**
 * 把一段 config 文本解析成**有序**指令：host 块与 include 指令按出现顺序排列。
 * `Match` 块整体忽略（保守）：猜错它的语义比不应用更危险。
 *
 * @param {string} text
 * @returns {Array<{kind:'host', patterns: Array<{text:string, negate:boolean}>, options: Record<string, string[]>} | {kind:'include', spec:string}>}
 */
function parseSshConfigText(text) {
  const items = [];
  /** @type {{kind:'host', patterns:any[], options:Record<string,string[]>} | null} */
  let current = null;
  let skipping = false; // 处于 Match 块内：不记录任何指令

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'host') {
      const patterns = splitArgs(value).map((raw) => ({
        negate: raw.startsWith('!'),
        text: raw.replace(/^!/, '').toLowerCase()
      }));
      current = { kind: 'host', patterns, options: {} };
      items.push(current);
      skipping = false;
      continue;
    }
    if (key === 'match') {
      // Match 之后直到下一个 Host 的指令一律丢弃
      current = null;
      skipping = true;
      continue;
    }
    if (key === INCLUDE_KEY) {
      // 一行可以写多个路径，也可以写成带引号的形式：`Include config.d/* "C:\a b\cfg"`。
      // 以前把整串当一个文件名，于是多路径/带引号的 Include 静默失效（配置里的主机连不上）。
      if (!skipping) {
        for (const one of splitArgs(value)) {
          if (one) items.push({ kind: 'include', spec: one });
        }
      }
      continue;
    }
    if (skipping || !current) continue;
    if (!current.options[key]) current.options[key] = [];
    // 单值参数按 shell 规则去引号后再存：`IdentityFile "C:\a b\id"` 的值是路径本身，
    // 多词参数（ProxyCommand）用空格还原，供上层按原样判断/报错。
    current.options[key].push(splitArgs(value).join(' '));
  }
  return items;
}

/**
 * Host 模式匹配（`*` / `?`，`!` 取反）。Host 名比较不区分大小写。
 * @param {Array<{text:string, negate:boolean}>} patterns
 * @param {string} name
 */
function hostPatternsMatch(patterns, name) {
  const host = String(name || '').toLowerCase();
  if (!host || !Array.isArray(patterns) || !patterns.length) return false;
  let positive = false;
  for (const p of patterns) {
    if (!globMatch(p.text, host)) continue;
    if (p.negate) return false;
    positive = true;
  }
  return positive;
}

/** 极简 glob：只支持 `*` 与 `?`（与 OpenSSH Host 模式一致）。 */
function globMatch(pattern, text) {
  const re = new RegExp(
    '^' +
      String(pattern || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return re.test(text);
}

/**
 * 解析 `ProxyJump`：`user@host:port,jump2` 或 `none`。
 * @param {string} spec
 * @returns {Array<{username:string, host:string, port:number}>}
 */
function parseProxyJump(spec) {
  const raw = String(spec || '').trim();
  if (!raw || raw.toLowerCase() === 'none') return [];
  const hops = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(token);
    if (!m) continue;
    const host = String(m[2] || '').replace(/^\[|\]$/g, '');
    if (!host) continue;
    hops.push({ username: m[1] ? m[1] : '', host, port: Number(m[3]) || 22 });
  }
  return hops;
}

/**
 * 把有序指令拍平成「按 OpenSSH 语义生效」的 host 块列表（已内联 Include）。
 * @param {Array<any>} items
 * @param {{readInclude:(spec:string)=>Array<any>}} io
 */
function flattenItems(items, io) {
  const blocks = [];
  for (const item of items) {
    if (item.kind === 'host') {
      blocks.push(item);
      continue;
    }
    if (item.kind === 'include') {
      for (const nested of io.readInclude(item.spec)) blocks.push(nested);
    }
  }
  return blocks;
}

/**
 * 解析别名 → 有效连接参数。
 *
 * 语义与 OpenSSH 一致：按文件顺序，**每个参数第一个匹配到的值生效**；
 * `IdentityFile` 例外（可叠加，全部按顺序尝试）。
 *
 * @param {Array<any>} blocks
 * @param {string} alias
 * @returns {{matched:boolean, alias:string, hostName:string, user:string, port:number, identityFiles:string[], proxyJump:string, proxyCommand:string, jumped:string[]}}
 */
function resolveHostConfig(blocks, alias) {
  const name = String(alias || '').trim();
  const out = {
    matched: false,
    alias: name,
    hostName: '',
    user: '',
    port: 0,
    identityFiles: [],
    proxyJump: '',
    proxyCommand: '',
    jumped: []
  };
  if (!name) return out;
  for (const block of blocks || []) {
    if (!hostPatternsMatch(block.patterns, name)) continue;
    out.matched = true;
    out.jumped.push(name);
    for (const key of RESOLVED_KEYS) {
      const values = block.options && block.options[key];
      if (!values || !values.length) continue;
      if (key === 'identityfile') {
        for (const v of values) out.identityFiles.push(expandHome(v));
        continue;
      }
      if (out[keyToField(key)]) continue; // 第一个生效
      out[keyToField(key)] = key === 'port' ? Number(values[0]) || 0 : values[0];
    }
  }
  if (out.matched) out.hostName = out.hostName || name;
  return out;
}

function keyToField(key) {
  switch (key) {
    case 'hostname':
      return 'hostName';
    case 'user':
      return 'user';
    case 'port':
      return 'port';
    case 'proxyjump':
      return 'proxyJump';
    case 'proxycommand':
      return 'proxyCommand';
    default:
      return key;
  }
}

/** `~/x` → 家目录展开（配置文件里的 IdentityFile 常写成 `~/.ssh/id_ed25519`）。 */
function expandHome(p, home) {
  const s = String(p || '');
  const h = home || os.homedir();
  if (s === '~') return h;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(h, s.slice(2));
  return s;
}

/**
 * 读取一个 config 文件（含 Include 展开）。
 * @param {string} filePath
 * @param {{fsApi: typeof fs, home: string, depth: number, seen: Set<string>, onWarn?: (msg:string)=>void}} ctx
 */
function loadFile(filePath, ctx) {
  if (ctx.depth > MAX_INCLUDE_DEPTH) {
    ctx.onWarn && ctx.onWarn(`ssh config Include 过深（>${MAX_INCLUDE_DEPTH}）：${filePath}`);
    return [];
  }
  const abs = path.resolve(filePath);
  if (ctx.seen.has(abs)) return [];
  let text;
  try {
    text = ctx.fsApi.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  ctx.seen.add(abs);
  const items = parseSshConfigText(text);
  return flattenItems(items, {
    readInclude: (spec) =>
      expandInclude(spec, { ...ctx, depth: ctx.depth + 1, seen: ctx.seen, baseDir: path.dirname(abs) })
  });
}

/**
 * 展开一条 Include：支持 `~/`、相对路径（相对包含它的文件所在目录）、以及末段的 `*`/`?`。
 * @param {string} spec
 * @param {{fsApi: typeof fs, home: string, baseDir: string, depth: number, seen: Set<string>, onWarn?: (msg:string)=>void}} ctx
 */
function expandInclude(spec, ctx) {
  const raw = String(spec || '').trim();
  if (!raw) return [];
  const expanded = expandHome(raw, ctx.home);
  const abs = path.isAbsolute(expanded) ? expanded : path.join(ctx.baseDir || ctx.home, expanded);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const out = [];
  if (!/[*?]/.test(base)) {
    for (const block of loadFile(abs, ctx)) out.push(block);
    return out;
  }
  let names = [];
  try {
    names = ctx.fsApi.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names.filter((n) => globMatch(base, n)).sort()) {
    for (const block of loadFile(path.join(dir, name), ctx)) out.push(block);
  }
  return out;
}

/**
 * 读取并解析 SSH 配置（附带本次真正读过的文件清单，供缓存判断失效）。
 * @param {{home?: string, configPath?: string, fsApi?: typeof fs, onWarn?: (msg:string)=>void}} [opts]
 * @returns {{ blocks: Array<any>, files: string[] }}
 */
function loadSshConfigWithFiles(opts = {}) {
  const home = opts.home || os.homedir();
  const fsApi = opts.fsApi || fs;
  const configPath = opts.configPath || path.join(home, '.ssh', 'config');
  const seen = new Set();
  const blocks = loadFile(configPath, {
    fsApi,
    home,
    depth: 0,
    seen,
    onWarn: opts.onWarn
  });
  return { blocks, files: [...seen] };
}

/**
 * 读取并解析 SSH 配置。
 * @param {{home?: string, configPath?: string, fsApi?: typeof fs, onWarn?: (msg:string)=>void}} [opts]
 * @returns {Array<any>} 已内联 Include 的 host 块
 */
function loadSshConfig(opts = {}) {
  return loadSshConfigWithFiles(opts).blocks;
}

/**
 * 缓存键：把**本次读过的每一个文件**的 mtime/size 都算进去。
 *
 * 只看主 `~/.ssh/config` 的 mtime 是不够的：`Include config.d/work` 里改了内容时主文件不动，
 * 缓存会一直返回旧解析结果，表现为「改了 ssh config 却不生效」。
 *
 * 已知边界：往 glob 目录里**新增**一个文件不会改变已读文件的 mtime，这种情况仍要
 * `resetSshConfigCache()`（界面上的「重新读取配置」）才会刷新。
 */
function configCacheKey(fsApi, files) {
  const list = Array.isArray(files) && files.length ? files : [''];
  return list
    .map((f) => {
      if (!f) return '|none';
      try {
        const st = fsApi.statSync(f);
        return `${f}|${st.mtimeMs}|${st.size}`;
      } catch {
        return `${f}|missing`;
      }
    })
    .join(';');
}

/** 进程内缓存：主 config 或任一被 Include 的文件改动后自动失效。 */
let cache = { key: '', blocks: [], files: [] };

/**
 * 带缓存的加载器（IPC 路径用；每次连接都会问一次，别每个连接重读整棵 include 树）。
 * @param {{home?: string, configPath?: string, fsApi?: typeof fs, onWarn?: (msg:string)=>void}} [opts]
 */
function getSshConfigBlocks(opts = {}) {
  const fsApi = opts.fsApi || fs;
  const home = opts.home || os.homedir();
  const configPath = opts.configPath || path.join(home, '.ssh', 'config');
  // 用「上次读过的文件集」判断是否失效；还没读过时只有主 config
  const watchList = cache.files.length ? cache.files : [path.resolve(configPath)];
  if (configCacheKey(fsApi, watchList) === cache.key) return cache.blocks;
  const loaded = loadSshConfigWithFiles({ ...opts, home, configPath, fsApi });
  const files = loaded.files.length ? loaded.files : [path.resolve(configPath)];
  cache = { key: configCacheKey(fsApi, files), blocks: loaded.blocks, files };
  return cache.blocks;
}

/** 测试与「重新读取配置」按钮用。 */
function resetSshConfigCache() {
  cache = { key: '', blocks: [], files: [] };
}

/**
 * 配置里出现过的 Host 别名（供 UI 提示/未来下拉；不含 `*` 这类通配块）。
 * @param {Array<any>} blocks
 * @returns {string[]}
 */
function listHostAliases(blocks) {
  const out = [];
  const seen = new Set();
  for (const b of blocks || []) {
    for (const p of b.patterns || []) {
      if (p.negate || /[*?]/.test(p.text)) continue;
      if (seen.has(p.text)) continue;
      seen.add(p.text);
      out.push(p.text);
    }
  }
  return out;
}

module.exports = {
  parseSshConfigText,
  parseProxyJump,
  hostPatternsMatch,
  globMatch,
  resolveHostConfig,
  loadSshConfig,
  loadSshConfigWithFiles,
  getSshConfigBlocks,
  resetSshConfigCache,
  listHostAliases,
  splitArgs,
  stripComment,
  expandHome
};

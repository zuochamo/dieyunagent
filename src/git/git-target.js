'use strict';

/**
 * 统一 git 执行目标：把「在本地仓库跑 git」与「在 SSH 远端仓库跑 git」
 * 收敛成同一个接口，供 scm / diff-context / 其它需要仓库级 git 的模块复用。
 *
 * 分层约定：
 *   - 本模块只懂「怎么把 git 命令送到目标并拿回结果」，不懂 status/diff 的语义；
 *   - 语义解析放 scm-service.js，避免每个调用方各写一份 porcelain 解析。
 *
 * 调用方不再需要 `if (remote) ... else ...` 分叉，也就不会再出现
 * 「本地修了、远端忘了修」的双实现漂移。
 */

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 12 * 1024 * 1024;
const GIT_DEFAULT_TIMEOUT_MS = 60000;
/** 工作区单文件读取上限：diff 预览用，超过就截断，不做整读 */
const TARGET_READ_MAX_BYTES = 200 * 1024;

/**
 * 回合撤回 / Plan 回写快照的单文件上限：超过就不进快照。
 * 过去在 baseline-capture、remote-baseline-capture、turn-undo-service、rpc 四处各写一遍 4MB。
 */
const WORKTREE_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** POSIX 单引号转义：远端 shell 下唯一安全的字面量包法 */
function gitShellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 二进制判定：出现 NUL 即视为二进制。
 * 单一规则，预览读取与回合基线捕获共用（过去三处各写一遍 `buf.includes(0)`）。
 * @param {Buffer} buf
 */
function bufferLooksBinary(buf) {
  return !!buf && buf.includes(0);
}

/**
 * 工作区内容 → 基线 / 预览用的编码描述。
 * @param {Buffer} buf
 * @returns {{ before: string, encoding: 'utf8'|'base64', binary: boolean }}
 */
function encodeWorktreeContent(buf) {
  const binary = bufferLooksBinary(buf);
  if (binary) return { before: buf.toString('base64'), encoding: 'base64', binary: true };
  return { before: buf.toString('utf8'), encoding: 'utf8', binary: false };
}

/** git 输出统一 LF 并去首尾空白，避免 \r 污染路径比较与逐行解析 */
function normalizeGitText(stdout, stderr) {
  return String(stdout || stderr || '').replace(/\r\n/g, '\n').trim();
}

const REL_PATH_ESCAPE_RE = /(^|\/)\.\.(\/|$)/;

/**
 * 仓库相对路径规范化。拒绝 `..` 逃逸与绝对路径，
 * 保证后续 path.join(root, rel) / rm -- rel 不会跑出仓库根。
 * @param {string} input
 * @returns {string} 规范化后的相对路径；不合法时返回空串
 */
function normalizeGitRelPath(input) {
  let s = String(input == null ? '' : input)
    .replace(/\\/g, '/')
    .trim();
  if (!s) return '';
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s || s === '.') return '';
  if (/^[a-zA-Z]:\//.test(s) || REL_PATH_ESCAPE_RE.test(s)) return '';
  return s;
}

function clampReadBytes(maxBytes) {
  const n = Number(maxBytes);
  if (!Number.isFinite(n) || n <= 0) return TARGET_READ_MAX_BYTES;
  return Math.min(TARGET_READ_MAX_BYTES, Math.max(1, Math.floor(n)));
}

/**
 * @param {string} root 本地仓库根（绝对路径）
 */
function createLocalGitTarget(root) {
  const cwd = path.resolve(String(root));
  return {
    kind: 'local',
    root: cwd,

    async run(args, opts = {}) {
      const list = (Array.isArray(args) ? args : []).map((a) => String(a));
      const timeout = Math.max(1000, Number(opts.timeoutMs) || GIT_DEFAULT_TIMEOUT_MS);
      try {
        const { stdout, stderr } = await execFileAsync('git', list, {
          cwd,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
          timeout
        });
        return { ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      } catch (err) {
        const code = Number(err && err.code);
        return {
          ok: false,
          code: Number.isFinite(code) ? code : 1,
          stdout: String((err && err.stdout) || ''),
          stderr: String((err && err.stderr) || (err && err.message) || err)
        };
      }
    },

    async readText(rel, opts = {}) {
      const maxBytes = clampReadBytes(opts.maxBytes);
      const abs = path.join(cwd, rel);
      const fh = await fs.open(abs, 'r');
      try {
        const st = await fh.stat();
        if (!st.isFile()) return { ok: false, binary: false, truncated: false, text: '' };
        const size = Math.min(st.size, maxBytes);
        const buf = Buffer.alloc(size);
        if (size > 0) await fh.read(buf, 0, size, 0);
        if (bufferLooksBinary(buf)) return { ok: false, binary: true, truncated: false, text: '' };
        return {
          ok: true,
          binary: false,
          truncated: st.size > maxBytes,
          text: buf.toString('utf8')
        };
      } finally {
        await fh.close();
      }
    },

    async removeFile(rel) {
      await fs.rm(path.join(cwd, rel), { force: true });
      return { ok: true };
    },

    async pathExists(rel) {
      try {
        await fs.access(path.join(cwd, rel));
        return true;
      } catch {
        return false;
      }
    }
  };
}

/**
 * @param {string} root 远端仓库根（posix 绝对路径）
 * @param {(command: string, cwd: string, timeoutMs?: number) => Promise<{code?: number, stdout?: string, stderr?: string}>} sshExec
 */
function createSshGitTarget(root, sshExec) {
  const cwd = String(root || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return {
    kind: 'ssh',
    root: cwd,

    async run(args, opts = {}) {
      const list = (Array.isArray(args) ? args : []).map((a) => String(a));
      const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || GIT_DEFAULT_TIMEOUT_MS);
      const command = ['git', ...list.map(gitShellQuote)].join(' ');
      try {
        const r = await sshExec(command, cwd, timeoutMs);
        // 不给「没拿到退出码」补 0：exec 层已经把它当失败拒掉了，这里只做透传，
        // 免得重新长出「未知 ⇒ 成功」那条路（`Number(null) === 0` 就是它）。
        const code = r && r.code != null ? Number(r.code) : null;
        return {
          ok: code === 0,
          code,
          stdout: String((r && r.stdout) || ''),
          stderr: String((r && r.stderr) || '')
        };
      } catch (err) {
        const raw = Number(err && err.code);
        return {
          ok: false,
          code: Number.isFinite(raw) ? raw : null,
          stdout: '',
          stderr: String((err && err.message) || err)
        };
      }
    },

    async readText(rel, opts = {}) {
      const maxBytes = clampReadBytes(opts.maxBytes);
      // 与本地目标同语义：文件不存在 / 读不了 → 抛错，由调用方显式决定要不要当空内容。
      // 以前的 `head ... || true` 把「不存在」「无权限」「读到了空文件」糊成同一个 ''，
      // diff 里就成了「这文件是空的」，而不是「我们没读到」。
      const q = gitShellQuote(rel);
      const script = `if [ -e ${q} ]; then head -c ${maxBytes + 1} -- ${q}; else exit 44; fi`;
      const r = await sshExec(script, cwd, 20000);
      const code = r && r.code != null ? Number(r.code) : null;
      if (code === 44) {
        throw Object.assign(new Error(`远程文件不存在：${rel}`), { code: 'ENOENT' });
      }
      if (code !== 0) {
        const detail = normalizeGitText(String((r && r.stderr) || ''), '');
        throw Object.assign(new Error(detail || `远程读取失败（exit=${code == null ? '?' : code}）：${rel}`), {
          code: 'EIO'
        });
      }
      const raw = String((r && r.stdout) || '');
      if (!raw) return { ok: true, binary: false, truncated: false, text: '' };
      if (raw.includes('\u0000')) return { ok: false, binary: true, truncated: false, text: '' };
      const truncated = raw.length > maxBytes;
      return { ok: true, binary: false, truncated, text: truncated ? raw.slice(0, maxBytes) : raw };
    },

    async removeFile(rel) {
      const r = await sshExec(`rm -f -- ${gitShellQuote(rel)}`, cwd, 15000);
      const code = r && r.code != null ? Number(r.code) : null;
      if (code !== 0) {
        throw new Error(normalizeGitText((r && r.stderr) || '', '') || '远程删除文件失败');
      }
      return { ok: true };
    },

    async pathExists(rel) {
      const r = await sshExec(`test -e ${gitShellQuote(rel)}`, cwd, 15000);
      // `Number(null) === 0` 会把「不知道」报成「存在」，路径判断错会让上层去读一个不存在的文件
      return !!(r && r.code != null && Number(r.code) === 0);
    }
  };
}

/** 给目标补上「拿文本 / 判仓库」的便捷方法，本地与远端共用同一套语义 */
function withGitTextHelpers(target) {
  target.textOrThrow = async (args, opts) => {
    const r = await target.run(args, opts);
    if (!r.ok) {
      const head = (Array.isArray(args) ? args : [])[0] || '';
      throw new Error(normalizeGitText(r.stdout, r.stderr) || `git ${head} 失败`);
    }
    return normalizeGitText(r.stdout, '');
  };
  target.textOrEmpty = async (args, opts) => {
    try {
      return await target.textOrThrow(args, opts);
    } catch {
      return '';
    }
  };
  target.isRepo = async () => (await target.run(['rev-parse', '--git-dir'])).ok;
  return target;
}

/**
 * @param {{ kind?: 'local'|'ssh', root: string, sshExec?: Function }} opts
 */
function createGitTarget(opts) {
  const kind = opts && opts.kind === 'ssh' ? 'ssh' : 'local';
  if (kind === 'ssh') {
    if (typeof (opts && opts.sshExec) !== 'function') {
      throw new Error('SSH git target 需要 sshExec');
    }
    return withGitTextHelpers(createSshGitTarget(opts.root, opts.sshExec));
  }
  return withGitTextHelpers(createLocalGitTarget(opts && opts.root));
}

module.exports = {
  createGitTarget,
  normalizeGitRelPath,
  normalizeGitText,
  bufferLooksBinary,
  encodeWorktreeContent,
  TARGET_READ_MAX_BYTES,
  WORKTREE_SNAPSHOT_MAX_BYTES
};

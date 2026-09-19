'use strict';

/**
 * 源码管理 RPC。
 *
 * 工作区解析只走 rpc.js 已有的「调用作用域」解析（runWorkspaceRoot → sessionId → 当前视图），
 * 因此在并行会话 / SSH 会话下也不会串到别的工作区去。
 * git 命令本地与远端共用同一套实现（git-target），本文件只负责鉴权 + 目标选择。
 */

const { createGitTarget } = require('../../git/git-target');
const {
  getScmStatus,
  getScmFileDiff,
  scmStage,
  scmUnstage,
  scmDiscard,
  scmCommit,
  getScmLog,
  getScmCommitFiles,
  getScmCommitDiff
} = require('../../git/scm-service');

function createScmHandlers(d) {
  const {
    perms,
    ctx,
    assertHostEnabled,
    resolveCallWorkspaceTarget,
    requireSshForCall,
    isSshConnectedForCall,
    normalizeRemotePath
  } = d;

  function assertScmRead() {
    if (!perms.hostControl || !perms.fsRead) {
      const e = new Error('文件读取未授权');
      e.code = 'FS_READ_DISABLED';
      throw e;
    }
  }

  function assertScmWrite() {
    assertHostEnabled(ctx);
    if (!perms.fsWrite) {
      const e = new Error('文件写入未授权');
      e.code = 'FS_WRITE_DISABLED';
      throw e;
    }
  }

  /** 当前调用作用域的 git 目标；拿不到（未选工作区 / SSH 断连）返回 null */
  function resolveGitTarget() {
    const target = resolveCallWorkspaceTarget();
    if (!target) return null;
    if (target.kind === 'ssh') {
      if (!isSshConnectedForCall()) return null;
      const manager = requireSshForCall();
      if (!manager || typeof manager.exec !== 'function') return null;
      return createGitTarget({
        kind: 'ssh',
        root: normalizeRemotePath(target.remotePath || '/'),
        sshExec: (command, cwd, timeoutMs) => manager.exec(command, cwd, timeoutMs)
      });
    }
    return createGitTarget({ kind: 'local', root: target.path });
  }

  async function withGit(fn) {
    const git = resolveGitTarget();
    if (!git) {
      const e = new Error('当前工作区不可用：未选择工作区，或 SSH 未连接');
      e.code = 'SCM_NO_WORKSPACE';
      throw e;
    }
    return fn(git);
  }

  return {
    'scm.status': async () => {
      assertScmRead();
      return withGit((git) => getScmStatus(git));
    },

    'scm.file_diff': async (params) => {
      assertScmRead();
      return withGit((git) => getScmFileDiff(git, params || {}));
    },

    'scm.stage': async ({ paths }) => {
      assertScmWrite();
      return withGit((git) => scmStage(git, paths));
    },

    'scm.unstage': async ({ paths }) => {
      assertScmWrite();
      return withGit((git) => scmUnstage(git, paths));
    },

    'scm.discard': async ({ entries, deleteUntracked }) => {
      assertScmWrite();
      return withGit((git) => scmDiscard(git, { entries, deleteUntracked }));
    },

    'scm.commit': async ({ message, paths }) => {
      assertScmWrite();
      return withGit((git) => scmCommit(git, { message, paths }));
    },

    // 提交历史三件套：只读，与工作区状态共用读权限
    'scm.log': async ({ limit, skip, resume } = {}) => {
      assertScmRead();
      return withGit((git) => getScmLog(git, { limit, skip, resume }));
    },

    'scm.commit_files': async ({ sha } = {}) => {
      assertScmRead();
      return withGit((git) => getScmCommitFiles(git, { sha }));
    },

    'scm.commit_diff': async ({ sha, path } = {}) => {
      assertScmRead();
      return withGit((git) => getScmCommitDiff(git, { sha, path }));
    }
  };
}

module.exports = { createScmHandlers };

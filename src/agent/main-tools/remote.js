'use strict';

/**
 * 远端工作：ssh（连接 / 端口转发 / 切远端工作空间）与 worktree（并行副本）。与 IPC 共用 ssh/actions.js 与 worktree/actions.js，本文件不许出现第二份连接或副本逻辑。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createRemoteHandlers(shared) {
  const {
    sshActions,
    worktreeActions
  } = shared;

  return {
    ssh: async (a, ctx) => {
        // 远端能力：与「连接」面板共用 ssh/actions.js。不接密钥参数 —— 密码/私钥只能来自本机。
        if (!sshActions) {
          return { ok: false, error: 'SSH 不可用（未装配）', errorCode: 'SSH_UNAVAILABLE', retryable: false };
        }
        const action = String(a.action || 'status').trim();
        try {
          if (action === 'list') {
            return { ok: true, action, ...sshActions.listTargets() };
          }
          if (action === 'status') {
            return { ok: true, action, status: sshActions.status() };
          }
          if (action === 'home') {
            return { ok: true, action, ...(await sshActions.home()) };
          }
          if (action === 'browse') {
            const listing = await sshActions.browse(a.path);
            return { ok: true, action, path: String(a.path || '/'), listing };
          }
          if (action === 'use_workspace') {
            const remotePath = String(a.remotePath || '').trim();
            if (!remotePath) return { error: 'use_workspace 需要 remotePath', errorCode: 'MISSING_ARG' };
            const workspace = sshActions.useWorkspace(remotePath);
            return {
              ok: true,
              action,
              workspace,
              note: '工作空间已切到远端：fs_* 与 host_exec 现在作用在这台服务器上（要操作本机文件/命令用 local: 前缀或 local=true）'
            };
          }
          if (action === 'connect') {
            const payload = {
              host: String(a.profile || a.host || '').trim(),
              hostname: a.profile ? '' : String(a.host || '').trim(),
              port: a.port,
              username: a.username,
              authType: a.authType,
              privateKeyPath: a.privateKeyPath,
              // 已存凭据要生效必须带 remember（connect-payload 里那一支才会去凭据库取密码）
              remember: true,
              useSaved: true,
              acceptNewHostKey: a.acceptNewHostKey === true
            };
            const r = await sshActions.connect(payload);
            if (!r || r.ok === false) {
              // 首次连接：主机指纹没被信任过，必须由人确认（工具不替人做这个决定）。
              //
              // 注意：失败结果在关卡里会被 `wrapStructuredError` 归一成
              // `{ok,error,errorCode,retryable,suggestedFix}` —— 额外字段（指纹、主机）会被丢掉。
              // 所以「指纹 + 下一步」必须写进 error / suggestedFix 这两个能活下来的字段里，
              // 否则模型只看到一句「没被信任过」，既拿不到指纹也没法重试。
              if (r && r.needHostKeyTrust) {
                const fp = r.fingerprint || '未知';
                return {
                  ok: false,
                  action,
                  connected: false,
                  fingerprint: r.fingerprint || '',
                  hostKeyMismatch: !!r.hostKeyMismatch,
                  host: r.host,
                  username: r.username,
                  error: r.hostKeyMismatch
                    ? `主机 ${r.host || ''} 的指纹与已保存的不一致（现在：${fp}，已存：${r.savedFingerprint || '未知'}）。可能是换了机器，也可能是中间人 —— 不要自己继续。`
                    : `主机 ${r.host || ''} 的指纹还没被信任过：${fp}`,
                  errorCode: r.hostKeyMismatch ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_HOST_KEY_UNTRUSTED',
                  // 不能标 retryable：那是「同一参数自动重试」的信号，harness 会连打 4 次，
                  // 而这里什么都不会变 —— 要做的是去问人，然后**换参数**重来。
                  retryable: false,
                  suggestedFix: r.hostKeyMismatch
                    ? '把这个不一致告诉用户并停下：只有用户确认那台机器被重装/换过之后，才由用户在连接面板处理，不要带 acceptNewHostKey 重试。'
                    : '把指纹念给用户核对（"这台机器是 10.x，指纹 SHA256:xxx，可以信任吗？"）；用户明确同意后，再带 acceptNewHostKey=true 重试同一条 connect。'
                };
              }
              return {
                ok: false,
                action,
                connected: false,
                ...(r || {}),
                error: (r && (r.error || r.message)) || 'SSH 连接失败',
                errorCode: (r && r.errorCode) || 'SSH_CONNECT_FAILED'
              };
            }
            const out = {
              ok: true,
              action,
              connected: true,
              resolved: r.resolved || {},
              credentialsWarning: r.credentialsWarning || '',
              note: '已连上。要把工作空间切过去就再调 action=use_workspace + remotePath。'
            };
            const remotePath = String(a.remotePath || '').trim();
            if (remotePath) {
              out.workspace = sshActions.useWorkspace(remotePath);
              out.note = '已连上并切到远端工作空间：fs_* 与 host_exec 现在作用在这台服务器上（要操作本机文件/命令用 local: 前缀或 local=true）';
            }
            return out;
          }
          if (action === 'disconnect') {
            const r = await sshActions.disconnect({ force: a.force === true });
            return { ok: true, action, ...(r || {}) };
          }
          if (action === 'port_forward') {
            const sub = String(a.forwardAction || 'list').trim();
            if (sub === 'add') {
              const r = await sshActions.portForwardAdd({
                localPort: a.localPort,
                remoteHost: a.remoteHost,
                remotePort: a.remotePort
              });
              return { ok: true, action, forwardAction: sub, ...(r || {}) };
            }
            if (sub === 'remove') {
              const r = await sshActions.portForwardRemove({ id: a.id });
              return { ok: true, action, forwardAction: sub, ...(r || {}) };
            }
            const r = sshActions.portForwardList();
            return { ok: true, action, forwardAction: 'list', forwards: (r && r.forwards) || [] };
          }
          return {
            ok: false,
            error: `ssh 的 action 不支持「${action}」`,
            errorCode: 'INVALID_ARG',
            retryable: false
          };
        } catch (err) {
          return {
            ok: false,
            action,
            error: String((err && err.message) || err || 'SSH 操作失败'),
            errorCode: (err && err.code) || 'SSH_FAILED',
            retryable: false
          };
        }
    },
    worktree: async (a, ctx) => {
        // 副本隔离：与设置页「副本」面板共用 src/worktree/actions.js。
        if (!worktreeActions) {
          return { ok: false, error: 'Worktree 不可用（未装配）', errorCode: 'WORKTREE_UNAVAILABLE', retryable: false };
        }
        const action = String(a.action || 'list').trim();
        try {
          if (action === 'list') return { ok: true, action, ...(await worktreeActions.list()) };
          if (action === 'list_runs') return { ok: true, action, ...(await worktreeActions.listManaged()) };
          if (action === 'create') {
            const r = await worktreeActions.create({
              runId: a.runId,
              roleId: a.roleId,
              baseRef: a.baseRef
            });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'remove') {
            const p = String(a.path || '').trim();
            if (!p) return { ok: false, error: 'worktree remove 需要 path', errorCode: 'MISSING_ARG' };
            const r = await worktreeActions.remove({ path: p });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'preview_run') {
            const r = await worktreeActions.previewRun({ runId: a.runId });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'apply_run') {
            const r = await worktreeActions.applyRun({
              runId: a.runId,
              paths: a.paths,
              changeIds: a.changeIds,
              forceConflict: a.forceConflict === true,
              allowOverwriteMainDirty: a.allowOverwriteMainDirty === true
            });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'cleanup_run') {
            const r = await worktreeActions.cleanupRun({
              runId: a.runId,
              archive: a.archive !== false,
              allowDiscardUncommitted: a.allowDiscardUncommitted === true,
              deleteBranches: a.deleteBranches === true
            });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'prune') {
            // keep 是该动作唯一的安全阀（省略 = 0 = 全删已合并的 dieyun 分支），必须从参数里来，
            // 不能读一个 schema 里不存在的字段（那样永远是 {}，等于「无差别清理」）。
            const r = await worktreeActions.pruneBranches({ keep: a.keep });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          return { ok: false, error: `worktree 的 action 不支持「${action}」`, errorCode: 'INVALID_ARG', retryable: false };
        } catch (err) {
          return {
            ok: false,
            action,
            error: String((err && err.message) || err || 'worktree 操作失败'),
            errorCode: 'WORKTREE_FAILED',
            retryable: false
          };
        }
    }
  };
}

module.exports = { createRemoteHandlers };

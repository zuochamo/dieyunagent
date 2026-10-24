'use strict';

/**
 * @param {{
 *   perms: object,
 *   ctx?: { sandbox?: object },
 *   getActiveCallSessionId?: () => string,
 *   getRemoteFs?: () => object|null
 * }} deps
 */
function createPermissionsHandlers({ perms, ctx, getActiveCallSessionId, getRemoteFs }) {
  return {
    'permissions.get': () => ({ ...perms }),
    /**
     * 沙箱状态：档位 + **真实可写白名单** + 本会话已批准的位置。
     * 设置页展示、排查「为什么这个写被拦了」都看这一份（判定逻辑在 sandbox-policy.js）。
     *
     * 回报的是实际生效的根（含 %TEMP%、含已批准目录），不是「档位 + 工作区」的示意图：
     * 排查时看到的名单与真正的拦截原因不一致，是最容易把人带偏的一种失真。
     */
    'permissions.sandbox_state': () => {
      const sandbox = ctx && ctx.sandbox;
      if (!sandbox || typeof sandbox.context !== 'function') {
        return { mode: null, unavailable: true };
      }
      const c = sandbox.context();
      const sessionId = typeof getActiveCallSessionId === 'function' ? getActiveCallSessionId() : '';
      const grantedPaths =
        c.mode === 'danger-full-access' || typeof sandbox.grantedWriteRoots !== 'function'
          ? []
          : sandbox.grantedWriteRoots(sessionId);
      const writableRoots =
        typeof sandbox.writableRoots === 'function'
          ? sandbox.writableRoots()
          : Array.from(new Set([...c.internalRoots, ...c.workspaceRoots]));
      return {
        mode: c.mode,
        writableRoots,
        grantedPaths,
        sessionId: sessionId || null,
        /** 远程（SSH）工作区：SFTP 写入由 SSH 凭据授权，本机档位不参与判定（见 docs/SANDBOX.md） */
        remoteGoverned: !!(typeof getRemoteFs === 'function' && getRemoteFs()),
        workspaceRoots: c.workspaceRoots,
        internalRoots: c.internalRoots,
        grants: sandbox.approvals ? sandbox.approvals.snapshot() : []
      };
    }
  };
}

module.exports = { createPermissionsHandlers };

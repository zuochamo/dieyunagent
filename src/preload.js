const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diecloud', {
  getGatewayInfo: () => ipcRenderer.invoke('gateway:get-info'),
  getDeployUiDefaults: () => ipcRenderer.invoke('deploy:get-ui-defaults'),
  getMobileInfo: () => ipcRenderer.invoke('mobile:get-info'),

  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  setPermissions: (perms) => ipcRenderer.invoke('permissions:set', perms),

  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  setActiveSessionWorkspace: (opts) => ipcRenderer.invoke('workspace:set-active-session', opts || {}),
  setSessionRemoteLease: (opts) => ipcRenderer.invoke('remote:session-lease', opts || {}),
  setWorkspace: (p) => ipcRenderer.invoke('workspace:set', p),
  setLocalWorkspace: (path) => ipcRenderer.invoke('workspace:set-local', { path }),
  setSshRemotePath: (remotePath) => ipcRenderer.invoke('workspace:set-ssh-remote', { remotePath }),
  sshConnect: (payload) => ipcRenderer.invoke('ssh:connect', payload),
  sshDisconnect: (opts) => ipcRenderer.invoke('ssh:disconnect', opts || {}),
  sshStatus: () => ipcRenderer.invoke('ssh:status'),
  sshBrowse: (remotePath) => ipcRenderer.invoke('ssh:browse', { path: remotePath }),
  sshHome: () => ipcRenderer.invoke('ssh:home'),
  sshGetProfile: (payload) => ipcRenderer.invoke('ssh:get-profile', payload),
  sshAutoReconnect: () => ipcRenderer.invoke('ssh:auto-reconnect'),
  sshEnsureRemoteGateway: () => ipcRenderer.invoke('ssh:ensure-remote-gateway'),
  sshRemoteGatewayStatus: () => ipcRenderer.invoke('ssh:remote-gateway-status'),
  ensureOptionalAsset: (assetId, opts) =>
    ipcRenderer.invoke('optional-assets:ensure', { assetId, ...(opts || {}) }),
  installOptionalAssetFromFile: (assetId) => ipcRenderer.invoke('optional-assets:install-from-file', { assetId }),
  getComponentsStatus: () => ipcRenderer.invoke('components:status'),
  testBuiltinEmbedding: () => ipcRenderer.invoke('embedding:test-builtin'),
  setComponentInUse: (componentId, inUse) =>
    ipcRenderer.invoke('components:set-usage', { componentId, inUse: !!inUse }),
  onOptionalAssetProgress: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('optional-assets:progress', handler);
    return () => ipcRenderer.removeListener('optional-assets:progress', handler);
  },
  onSshRemoteAgentDeployProgress: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('ssh:remote-agent-deploy-progress', handler);
    return () => ipcRenderer.removeListener('ssh:remote-agent-deploy-progress', handler);
  },
  sshRemoteAgentLog: (opts) => ipcRenderer.invoke('ssh:remote-agent-log', opts || {}),
  sshPortForwardAdd: (payload) => ipcRenderer.invoke('ssh:port-forward-add', payload || {}),
  sshPortForwardRemove: (payload) => ipcRenderer.invoke('ssh:port-forward-remove', payload || {}),
  sshPortForwardList: () => ipcRenderer.invoke('ssh:port-forward-list'),
  pickPrivateKey: () => ipcRenderer.invoke('dialog:pick-private-key'),

  terminalStart: (payload) => ipcRenderer.invoke('terminal:start', payload || {}),
  terminalDetach: (payload) => ipcRenderer.invoke('terminal:detach', payload || {}),
  terminalWrite: (payload) =>
    ipcRenderer.invoke(
      'terminal:write',
      typeof payload === 'string' ? { data: payload } : payload || {}
    ),
  terminalStop: (payload) => ipcRenderer.invoke('terminal:stop', payload || {}),
  onTerminalData: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  onTerminalExit: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
  onGatewaySshReconnected: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('gateway:ssh-reconnected', handler);
    return () => ipcRenderer.removeListener('gateway:ssh-reconnected', handler);
  },
  getDieyunMd: () => ipcRenderer.invoke('workspace:get-dieyun-md'),
  openDieyunMd: () => ipcRenderer.invoke('workspace:open-dieyun-md'),
  formatDieyunMdBlock: (payload) => ipcRenderer.invoke('workspace:format-dieyun-md', payload || {}),

  getAgentsMdTemplate: () => ipcRenderer.invoke('agents-md:get-template'),
  getAgentsMdPrefs: () => ipcRenderer.invoke('agents-md:get-prefs'),
  setAgentsMdPrefs: (payload) => ipcRenderer.invoke('agents-md:set-prefs', payload || {}),
  applyAgentsMdUpdates: (payload) => ipcRenderer.invoke('agents-md:apply-updates', payload),
  formatAgentsMdBlock: (payload) => ipcRenderer.invoke('agents-md:format-block', payload),
  parseAgentsMdMaintainer: (payload) => ipcRenderer.invoke('agents-md:parse-maintainer', payload),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  pickPluginZip: () => ipcRenderer.invoke('dialog:pick-plugin-zip'),
  pickFiles: () => ipcRenderer.invoke('dialog:pick-files'),
  stageFiles: (paths) => ipcRenderer.invoke('files:stage', paths),
  stageBase64: (payload) => ipcRenderer.invoke('files:stage-base64', payload),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),

  scanSkills: () => ipcRenderer.invoke('skills:scan'),
  recallSkills: (payload) => ipcRenderer.invoke('skills:recall', payload),
  readSkill: (skillPath) => ipcRenderer.invoke('skills:read', skillPath),
  createSkill: (payload) => ipcRenderer.invoke('skills:create', payload),
  onSkillsChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, detail) => cb(detail);
    ipcRenderer.on('dieyun:skills-changed', handler);
    return () => ipcRenderer.removeListener('dieyun:skills-changed', handler);
  },
  skillCatalogList: (payload) => ipcRenderer.invoke('skills:catalog-list', payload || {}),
  skillCatalogPreview: (payload) => ipcRenderer.invoke('skills:catalog-preview', payload || {}),
  skillCatalogInstall: (payload) => ipcRenderer.invoke('skills:catalog-install', payload || {}),
  getAgentHome: () => ipcRenderer.invoke('skills:get-home'),
  deleteSkill: (payload) => ipcRenderer.invoke('skills:delete', payload),

  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  setMcpEnabled: (payload) => ipcRenderer.invoke('mcp:set-enabled', payload),
  addMcpServer: (payload) => ipcRenderer.invoke('mcp:add', payload),
  deleteMcpServer: (payload) => ipcRenderer.invoke('mcp:delete', payload),
  mcpCatalogList: (payload) => ipcRenderer.invoke('mcp:catalog-list', payload || {}),
  mcpCatalogInstall: (payload) => ipcRenderer.invoke('mcp:catalog-install', payload || {}),
  mcpCatalogSourcesGet: () => ipcRenderer.invoke('mcp:catalog-sources-get'),
  mcpCatalogSourcesSet: (payload) => ipcRenderer.invoke('mcp:catalog-sources-set', payload || {}),
  getMcpRuntimeTools: (payload) => ipcRenderer.invoke('mcp:runtime-tools', payload || {}),
  callMcpRuntimeTool: (payload) => ipcRenderer.invoke('mcp:runtime-call', payload),
  getMcpConfig: (payload) => ipcRenderer.invoke('mcp:get-config', payload || {}),
  updateMcpConfig: (payload) => ipcRenderer.invoke('mcp:update-config', payload || {}),
  installMcpPackage: (payload) => ipcRenderer.invoke('mcp:install-package', payload || {}),
  repairMcpEnv: (payload) => ipcRenderer.invoke('mcp:repair-env', payload || {}),
  checkMcpUpdate: (payload) => ipcRenderer.invoke('mcp:check-update', payload || {}),
  upgradeMcpPackage: (payload) => ipcRenderer.invoke('mcp:upgrade-package', payload || {}),
  recallAgentTools: (payload) => ipcRenderer.invoke('tools:recall', payload),

  getWorkplaceMonitor: () => ipcRenderer.invoke('workplace-monitor:get'),
  setWorkplaceMonitor: (payload) => ipcRenderer.invoke('workplace-monitor:set', payload || {}),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
  windowHide: () => ipcRenderer.send('window:hide'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  setWindowOpacity: (value) => ipcRenderer.send('window:set-opacity', value),
  setWindowZoom: (factor) => ipcRenderer.send('window:set-zoom', factor),
  getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:set-auto-launch', enabled),
  onAutoLaunchChanged: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('app:auto-launch-changed', handler);
    return () => ipcRenderer.removeListener('app:auto-launch-changed', handler);
  },

  onWindowMaxState: (cb) => {
    ipcRenderer.on('window-max-state', (_evt, v) => {
      try {
        cb(!!v);
      } catch {
        // ignore
      }
    });
  },

  browserSetPanelState: (state) => ipcRenderer.invoke('browser:set-panel-state', state),
  browserSetActiveSession: (opts) => ipcRenderer.invoke('browser:set-active-session', opts || {}),
  browserGetStatus: () => ipcRenderer.invoke('browser:get-status'),
  onBrowserState: (cb) => {
    ipcRenderer.on('browser:state', (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    });
  },
  onBrowserAutoOpen: (cb) => {
    ipcRenderer.on('browser:auto-open', () => {
      try {
        cb();
      } catch {
        // ignore
      }
    });
  },

  onStatus: (cb) => {
    ipcRenderer.on('status', (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    });
  },

  addTokens: (n) => ipcRenderer.invoke('stats:add-tokens', n),

  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  getUpdateState: () => ipcRenderer.invoke('app:get-update-state'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  onAppUpdateState: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('app:update-state', handler);
    return () => ipcRenderer.removeListener('app:update-state', handler);
  },
  fetchAllLogs: (opts) => ipcRenderer.invoke('logs:fetch-all', opts),
  cleanLogs: (opts) => ipcRenderer.invoke('logs:clean', opts || {}),

  syncModelSettings: (settings) => ipcRenderer.invoke('model:sync-settings', settings),
  getModelSettingsFromMain: () => ipcRenderer.invoke('model:get-settings'),
  syncAgentLimits: (limits) => ipcRenderer.invoke('agent:sync-limits', limits),
  getAgentLimitsFromMain: () => ipcRenderer.invoke('agent:get-limits'),
  fetchBuiltinModels: (payload) => ipcRenderer.invoke('models:fetch-list', payload),

  streamChatViaMain: ({ url, headers, body, onRaw, onControl }) =>
    new Promise((resolve, reject) => {
      const streamId = `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const channel = `llm:stream:${streamId}`;
      const abort = () => ipcRenderer.invoke('llm:stream-abort', { streamId }).catch(() => {});
      if (onControl) {
        try {
          onControl({ streamId, abort });
        } catch (e) {
          reject(e);
          return;
        }
      }
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const handler = (_e, evt) => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'raw') {
          try {
            if (onRaw) onRaw(String(evt.text || ''));
          } catch (e) {
            finish(() => reject(e));
          }
          return;
        }
        if (evt.type === 'done') {
          finish(() => resolve({ ok: true }));
          return;
        }
        if (evt.type === 'error') {
          const err = new Error(String(evt.message || 'stream error'));
          if (evt.code) err.code = evt.code;
          if (evt.statusCode) err.statusCode = evt.statusCode;
          if (evt.code === 'ABORT_ERR' || err.message === 'aborted') err.name = 'AbortError';
          finish(() => reject(err));
        }
      };
      const cleanup = () => ipcRenderer.removeListener(channel, handler);
      ipcRenderer.on(channel, handler);
      ipcRenderer
        .invoke('llm:stream-chat', { channel, streamId, url, headers, body })
        .then((result) => {
          if (settled) return;
          if (result && result.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            finish(() => reject(err));
            return;
          }
          if (result && result.ok) {
            finish(() => resolve({ ok: true }));
            return;
          }
          if (result && result.error) {
            finish(() => reject(new Error(String(result.error))));
          }
        })
        .catch((e) => {
          finish(() => reject(e));
        });
    }),

  llmStreamAbort: (streamId) => ipcRenderer.invoke('llm:stream-abort', { streamId }),

  llmChatCompletion: async ({ url, headers, body, requestId, onControl }) => {
    const id = requestId || `llm-json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const abort = () => ipcRenderer.invoke('llm:chat-completion-abort', { requestId: id }).catch(() => {});
    if (onControl) {
      try {
        onControl({ requestId: id, abort });
      } catch (e) {
        throw e;
      }
    }
    const r = await ipcRenderer.invoke('llm:chat-completion', {
      requestId: id,
      url,
      headers,
      body
    });
    if (r && r.ok) return r.json;
    if (r && r.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      throw err;
    }
    const err = new Error((r && r.error) || '请求失败');
    if (String(err.message).toLowerCase() === 'aborted') err.name = 'AbortError';
    throw err;
  },

  llmChatCompletionAbort: (requestId) =>
    ipcRenderer.invoke('llm:chat-completion-abort', { requestId }),

  trayNotify: (payload) => ipcRenderer.invoke('tray:notify', payload),

  plansList: () => ipcRenderer.invoke('plans:list'),
  plansSave: (plan) => ipcRenderer.invoke('plans:save', plan),
  plansDelete: (id) => ipcRenderer.invoke('plans:delete', id),
  plansRunNow: (id) => ipcRenderer.invoke('plans:run-now', id),
  plansCancel: (id) => ipcRenderer.invoke('plans:cancel', id),
  plansCreateFromText: (payload) => ipcRenderer.invoke('plans:create-from-text', payload),
  onPlanRan: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('plans:ran', handler);
    return () => ipcRenderer.removeListener('plans:ran', handler);
  },
  /** 计划运行中的实时事件（AgentRunEvent：run_start / trace / done / error / stopped） */
  onPlanPhase: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('plans:phase', handler);
    return () => ipcRenderer.removeListener('plans:phase', handler);
  },

  agentRunStart: (meta) => ipcRenderer.invoke('agent:run-start', meta),
  agentRunCancel: (runId, reason) => ipcRenderer.invoke('agent:run-cancel', { runId, reason }),
  agentRunEnd: (runId) => ipcRenderer.invoke('agent:run-end', { runId }),
  agentIsCancelled: (runId) => ipcRenderer.invoke('agent:is-cancelled', { runId }),
  agentTaskEnqueue: (runId, task) => ipcRenderer.invoke('agent:task-enqueue', { runId, task }),
  agentTaskRunning: (runId, taskId) => ipcRenderer.invoke('agent:task-running', { runId, taskId }),
  agentTaskComplete: (runId, taskId, result) =>
    ipcRenderer.invoke('agent:task-complete', { runId, taskId, result }),
  agentTaskFail: (runId, taskId, error, cancel) =>
    ipcRenderer.invoke('agent:task-fail', { runId, taskId, error, cancel }),
  agentMessagePost: (runId, message) => ipcRenderer.invoke('agent:message-post', { runId, message }),
  agentMessagesForRole: (runId, roleId) =>
    ipcRenderer.invoke('agent:messages-for-role', { runId, roleId }),
  agentMessagesForRoleSince: (runId, roleId, since) =>
    ipcRenderer.invoke('agent:messages-for-role-since', { runId, roleId, since }),
  agentCheckpointSave: (runId, data) =>
    ipcRenderer.invoke('agent:checkpoint-save', { runId, data }),
  agentCheckpointLoad: (runId) => ipcRenderer.invoke('agent:checkpoint-load', { runId }),
  agentCheckpointDelete: (runId) => ipcRenderer.invoke('agent:checkpoint-delete', { runId }),
  agentCheckpointList: (limit) => ipcRenderer.invoke('agent:checkpoint-list', { limit }),
  agentTrace: (runId) => ipcRenderer.invoke('agent:trace', { runId }),
  agentArbitrate: (runId, decision) => ipcRenderer.invoke('agent:arbitrate', { runId, decision }),
  agentRustLoopPing: () => ipcRenderer.invoke('agent:rust-loop-ping'),
  agentPrepSystemPrompt: (payload) => ipcRenderer.invoke('agent:prep-system-prompt', payload || {}),
  agentRustLoopRun: (payload) =>
    ipcRenderer
      .invoke('agent:rust-loop-run', payload || {})
      .then((result) => {
        if (result && result.aborted) {
          const e = new Error('已停止');
          e.name = 'AbortError';
          throw e;
        }
        return result;
      })
      .catch((err) => {
      const msg = String(err && err.message ? err.message : err);
      if (/aborterror|:\s*aborted/i.test(msg) || msg.includes('已停止')) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        throw e;
      }
      throw err;
    }),
  agentRustLoopCancel: (payload) => ipcRenderer.invoke('agent:rust-loop-cancel', payload || {}),
  agentRetryTool: (payload) => ipcRenderer.invoke('agent:retry-tool', payload || {}),
  agentToolTelemetrySummary: () => ipcRenderer.invoke('agent:tool-telemetry-summary'),
  agentPlannerPing: () => ipcRenderer.invoke('agent:planner-ping'),
  agentPlannerRun: (payload) =>
    ipcRenderer
      .invoke('agent:planner-run', payload || {})
      .then((result) => {
        if (result && result.aborted) {
          const e = new Error('已停止');
          e.name = 'AbortError';
          throw e;
        }
        return result;
      })
      .catch((err) => {
      const msg = String(err && err.message ? err.message : err);
      if (/aborterror|:\s*aborted/i.test(msg) || msg.includes('已停止')) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        throw e;
      }
      throw err;
    }),
  agentPlannerCancel: (payload) => ipcRenderer.invoke('agent:planner-cancel', payload || {}),
  onAgentRustLoopPhase: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:rust-loop-phase', handler);
    return () => ipcRenderer.removeListener('agent:rust-loop-phase', handler);
  },
  onAgentPlannerPhase: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:planner-phase', handler);
    return () => ipcRenderer.removeListener('agent:planner-phase', handler);
  },
  onAgentPlannerArbitrate: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:planner-arbitrate', handler);
    return () => ipcRenderer.removeListener('agent:planner-arbitrate', handler);
  },
  agentPlannerArbitrateResult: (payload) =>
    ipcRenderer.invoke('agent:planner-arbitrate-result', payload || {}),
  onAgentMainToolDelegate: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:main-tool-delegate', handler);
    return () => ipcRenderer.removeListener('agent:main-tool-delegate', handler);
  },
  agentMainToolDelegateResult: (payload) =>
    ipcRenderer.invoke('agent:main-tool-delegate-result', payload || {}),

  compactionMaybeCompact: (payload) => ipcRenderer.invoke('compaction:maybe-compact', payload || {}),
  compactionEstimateTokens: (payload) => ipcRenderer.invoke('compaction:estimate-tokens', payload || {}),
  compactionResetState: (sessionId) =>
    ipcRenderer.invoke('compaction:reset-state', { sessionId: sessionId || null }),
  onCompactionProgress: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('compaction:progress', handler);
    return () => ipcRenderer.removeListener('compaction:progress', handler);
  },
  onAgentServiceSubmitTask: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent-service:submit-task', handler);
    return () => ipcRenderer.removeListener('agent-service:submit-task', handler);
  },
  onAgentServiceCancelTask: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent-service:cancel-task', handler);
    return () => ipcRenderer.removeListener('agent-service:cancel-task', handler);
  },
  agentServiceTaskAccepted: (payload) => ipcRenderer.send('agent-service:task-accepted', payload),
  agentServiceTaskRejected: (payload) => ipcRenderer.send('agent-service:task-rejected', payload),
  agentServiceTaskProgress: (payload) => ipcRenderer.send('agent-service:task-progress', payload),
  agentServiceTaskCompleted: (payload) => ipcRenderer.send('agent-service:task-completed', payload),

  worktreeList: () => ipcRenderer.invoke('worktree:list'),
  worktreeCreate: (runId, roleId, baseRef) =>
    ipcRenderer.invoke('worktree:create', { runId, roleId, baseRef }),
  worktreeRemove: (path) => ipcRenderer.invoke('worktree:remove', { path }),
  worktreeCleanupRun: (runId) => ipcRenderer.invoke('worktree:cleanup-run', { runId }),
  worktreeListManaged: () => ipcRenderer.invoke('worktree:list-managed'),
  worktreeEnforceCleanup: (payload) => ipcRenderer.invoke('worktree:enforce-cleanup', payload || {}),
  worktreePreviewRun: (runId) => ipcRenderer.invoke('worktree:preview-run', { runId }),
  worktreeApplyRun: (runId, paths, forceConflict, changeIds) =>
    ipcRenderer.invoke('worktree:apply-run', { runId, paths, forceConflict, changeIds }),
  worktreeChangeDiff: (change) => ipcRenderer.invoke('worktree:change-diff', { change })
});

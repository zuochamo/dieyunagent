const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { buildPeerBridge } = require('./peer/actions');

contextBridge.exposeInMainWorld('diecloud', {
  getGatewayInfo: () => ipcRenderer.invoke('gateway:get-info'),
  /**
   * 本地 Gateway 的唯一 RPC 通道（Renderer 没有 WebSocket：Gateway 监听私有 socket /
   * 命名管道，Chromium 连不了）。超时在 Main 侧执行一次。
   * @param {{ method: string, params?: object, timeoutMs?: number }} req
   */
  gatewayRpc: (req) => ipcRenderer.invoke('gateway:rpc', req || {}),
  /** Gateway 主动事件（如 `diagnostics.store_updated`）：Main 转一次，Renderer 只消费 */
  onGatewayEvent: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_evt, payload) => handler(payload || {});
    ipcRenderer.on('gateway:event', wrapped);
    return () => ipcRenderer.removeListener('gateway:event', wrapped);
  },
  getMobileInfo: () => ipcRenderer.invoke('mobile:get-info'),

  // 内网 agent 互通（src/peer）：语义全在 Main 的协调器，Renderer 只发命令与收事件。
  // 方法与参数整形的**唯一来源**是 `src/peer/actions.js#PEER_BRIDGE_METHODS`（网页侧同一份），
  // 这里不再手抄一份 —— `set-auto-trust` 就曾漏抄在这里，导致桌面与网页行为不一致。
  ...buildPeerBridge((action, payload) => ipcRenderer.invoke(`peer:${action}`, payload || {})),
  // 频道（企业微信等外部入口）：凭据加密存 Main，Renderer 只看状态
  channelsList: () => ipcRenderer.invoke('channels:list'),
  channelsCreate: (payload) => ipcRenderer.invoke('channels:create', payload || {}),
  channelsUpdate: (payload) => ipcRenderer.invoke('channels:update', payload || {}),
  channelsDelete: (id) => ipcRenderer.invoke('channels:delete', { id }),
  channelsSetEnabled: (id, enabled) => ipcRenderer.invoke('channels:set-enabled', { id, enabled: !!enabled }),
  channelsTest: (payload) => ipcRenderer.invoke('channels:test', payload || {}),
  channelsTestPush: (payload) => ipcRenderer.invoke('channels:test-push', payload || {}),
  // 共享记忆（跨机 PostgreSQL，扩展页签）：服务器/口令在 Main 的密文文件里，Renderer 只看状态
  sharedMemoryStatus: () => ipcRenderer.invoke('shared-memory:status'),
  sharedMemorySave: (patch) => ipcRenderer.invoke('shared-memory:save', patch || {}),
  sharedMemoryTest: (patch) => ipcRenderer.invoke('shared-memory:test', patch || {}),
  sharedMemoryProbe: () => ipcRenderer.invoke('shared-memory:probe'),
  sharedMemoryConsolidate: () => ipcRenderer.invoke('shared-memory:consolidate'),
  // 生命感（设置 → 生命）：只有一个开关 + 只读体征 + 决策日志；判定全在 Main
  aliveStatus: () => ipcRenderer.invoke('alive:status'),
  aliveDecisions: (payload) => ipcRenderer.invoke('alive:decisions', payload || {}),
  aliveHistory: (payload) => ipcRenderer.invoke('alive:history', payload || {}),
  aliveBadge: () => ipcRenderer.invoke('alive:badge'),
  aliveSetEnabled: (payload) => ipcRenderer.invoke('alive:set-enabled', payload || {}),
  aliveReset: () => ipcRenderer.invoke('alive:reset'),
  aliveWakeOnce: () => ipcRenderer.invoke('alive:wake-once'),
  aliveSetSense: (payload) => ipcRenderer.invoke('alive:set-sense', payload || {}),
  aliveSetOption: (payload) => ipcRenderer.invoke('alive:set-option', payload || {}),
  aliveDevices: () => ipcRenderer.invoke('alive:devices'),
  aliveNote: () => ipcRenderer.invoke('alive:note'),
  // 宠物（设置 → 宠物 → 点点）：悬浮窗本体在独立窗口（pet-window/preload 只给它开桥），主窗口只需要读写设置
  petGetSettings: () => ipcRenderer.invoke('pet:get-settings'),
  petSetSettings: (patch) => ipcRenderer.invoke('pet:set-settings', patch || {}),
  petSetEnabled: (enabled) => ipcRenderer.invoke('pet:set-enabled', { enabled: enabled !== false }),
  /** 后台心跳轮刚跑完（Main → 界面）：正开着它的会话就就地补上那一轮 */
  onAliveRan: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_evt, payload) => handler(payload || {});
    ipcRenderer.on('alive:ran', wrapped);
    return () => ipcRenderer.removeListener('alive:ran', wrapped);
  },
  onPeerEvent: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('peer:event', handler);
    return () => ipcRenderer.removeListener('peer:event', handler);
  },

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
  /** 凭据文件坏了（`ssh:get-profile` 返回 storeCorrupt）时，面板据此备份重建 */
  sshCredentialsReset: () => ipcRenderer.invoke('ssh:credentials-reset'),
  sshAutoReconnect: () => ipcRenderer.invoke('ssh:auto-reconnect'),
  sshRemoteGatewayStatus: () => ipcRenderer.invoke('ssh:remote-gateway-status'),
  getMonacoVsUrl: () => ipcRenderer.invoke('bundled-assets:monaco-vs-url'),
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
  pickFiles: () => ipcRenderer.invoke('dialog:pick-files'),
  stageFiles: (paths) => ipcRenderer.invoke('files:stage', paths),
  stageBase64: (payload) => ipcRenderer.invoke('files:stage-base64', payload),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  /** 用系统播放器打开（媒体播不了时的兜底）；路径由 Main 经 Gateway 校验解析 */
  openLocalPath: (filePath) => ipcRenderer.invoke('media:open-path', { filePath: String(filePath || '') }),

  // Electron 32 起渲染层 File.path 被移除，拖拽文件取真实路径只能走 webUtils。
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  scanSkills: () => ipcRenderer.invoke('skills:scan'),
  readSkill: (skillPath) => ipcRenderer.invoke('skills:read', skillPath),
  createSkill: (payload) => ipcRenderer.invoke('skills:create', payload),
  // 技能的启用状态存在 Main（`src/skills/enabled-store.js`）：频道 / 计划 / headless 也要读同一份
  getSkillsEnabled: () => ipcRenderer.invoke('skills:enabled-get'),
  setSkillEnabled: (payload) => ipcRenderer.invoke('skills:set-enabled', payload),
  onSkillsChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, detail) => cb(detail);
    ipcRenderer.on('dieyun:skills-changed', handler);
    return () => ipcRenderer.removeListener('dieyun:skills-changed', handler);
  },
  skillCatalogList: (payload) => ipcRenderer.invoke('skills:catalog-list', payload || {}),
  skillCatalogPreview: (payload) => ipcRenderer.invoke('skills:catalog-preview', payload || {}),
  skillCatalogInstall: (payload) => ipcRenderer.invoke('skills:catalog-install', payload || {}),
  deleteSkill: (payload) => ipcRenderer.invoke('skills:delete', payload),

  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  /** `{ corrupt, message, filePath }`：MCP 凭据文件坏了要显式提示，不能当「没配过」 */
  mcpCredentialsHealth: () => ipcRenderer.invoke('mcp:credentials-health'),
  mcpCredentialsReset: () => ipcRenderer.invoke('mcp:credentials-reset'),
  setMcpEnabled: (payload) => ipcRenderer.invoke('mcp:set-enabled', payload),
  addMcpServer: (payload) => ipcRenderer.invoke('mcp:add', payload),
  deleteMcpServer: (payload) => ipcRenderer.invoke('mcp:delete', payload),
  mcpCatalogList: (payload) => ipcRenderer.invoke('mcp:catalog-list', payload || {}),
  mcpCatalogInstall: (payload) => ipcRenderer.invoke('mcp:catalog-install', payload || {}),
  mcpCatalogSourcesGet: () => ipcRenderer.invoke('mcp:catalog-sources-get'),
  mcpCatalogSourcesSet: (payload) => ipcRenderer.invoke('mcp:catalog-sources-set', payload || {}),
  getMcpRuntimeTools: (payload) => ipcRenderer.invoke('mcp:runtime-tools', payload || {}),
  // MCP 工具语义召回（Renderer 聊天轮次在候选超上限时用）：与 Main 的装配共用同一实现
  recallAgentTools: (payload) => ipcRenderer.invoke('tools:recall', payload || {}),
  getMcpConfig: (payload) => ipcRenderer.invoke('mcp:get-config', payload || {}),
  updateMcpConfig: (payload) => ipcRenderer.invoke('mcp:update-config', payload || {}),
  /**
   * 「模型申请一项能力」的唯一订阅口：`agent_capability`（开权限开关）与
   * `mcp_manage.request_credential`（填服务凭据）都走这条通道，payload 带 `kind`
   * 由渲染器分发（MCP 凭据 → 该服务的配置弹窗；其余 → 打开对应设置页并高亮开关）。
   */
  onCapabilityRequest: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => cb(payload || {});
    ipcRenderer.on('agent:capability-request', handler);
    return () => ipcRenderer.removeListener('agent:capability-request', handler);
  },
  installMcpPackage: (payload) => ipcRenderer.invoke('mcp:install-package', payload || {}),
  repairMcpEnv: (payload) => ipcRenderer.invoke('mcp:repair-env', payload || {}),
  checkMcpUpdate: (payload) => ipcRenderer.invoke('mcp:check-update', payload || {}),
  upgradeMcpPackage: (payload) => ipcRenderer.invoke('mcp:upgrade-package', payload || {}),

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
  clearStats: () => ipcRenderer.invoke('stats:clear'),

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

  // 渲染进程冻结取证（问题 B）：单向 send，不回包——观测不该在卡死时挂住渲染进程。
  // 心跳只更新主进程内存时间戳，snapshot 才落盘（src/main/ipc/renderer-freeze.js）。
  rendererFreezeBeat: () => ipcRenderer.send('renderer:freeze-beat'),
  reportRendererFreeze: (snapshot) => ipcRenderer.send('renderer:freeze-report', snapshot),

  syncModelSettings: (settings) => ipcRenderer.invoke('model:sync-settings', settings),
  getModelSettingsFromMain: () => ipcRenderer.invoke('model:get-settings'),
  syncAgentLimits: (limits) => ipcRenderer.invoke('agent:sync-limits', limits),
  getAgentLimitsFromMain: () => ipcRenderer.invoke('agent:get-limits'),
  // 会话目标面板：视图（进度 / 事实 / 预算）在 Main 侧成形（src/goals/session-goal.js#toPanelView），
  // Renderer 只显示；action:'clear' 删除本会话目标。
  sessionGoalPanel: (payload) => ipcRenderer.invoke('agent:session-goal-panel', payload),
  syncRuntimeByTier: (byTier) => ipcRenderer.invoke('model:sync-runtime-by-tier', byTier),
  getRuntimeByTierFromMain: () => ipcRenderer.invoke('model:get-runtime-by-tier'),
  fetchBuiltinModels: (payload) => ipcRenderer.invoke('models:fetch-list', payload),

  /**
   * 流式 chat completion：Main 只把 core 的增量转发过来（`{type:'delta', content, reasoning}`），
   * 解析在 core（`crates/dieyun-runtime/src/agent/llm.rs`），渲染层不再收到 SSE 原文。
   * resolve 形状：`{ ok: true, result }`，`result` 是 core 归一后的
   * `{ content, reasoning, toolCalls, finishReason, usage, model }`。
   */
  streamChatViaMain: ({ url, headers, body, onDelta, onControl }) =>
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
        if (evt.type === 'delta') {
          try {
            if (onDelta) onDelta({ content: String(evt.content || ''), reasoning: String(evt.reasoning || '') });
          } catch (e) {
            finish(() => reject(e));
          }
          return;
        }
        if (evt.type === 'done') {
          finish(() => resolve({ ok: true, result: evt.result || null }));
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
            finish(() => resolve({ ok: true, result: result.result || null }));
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

  /**
   * 非流式一次调用。返回 core 归一后的
   * `{ content, reasoning, toolCalls, finishReason, usage, model }`
   * —— 不是上游原始 JSON：请求与解析都在 core，宿主侧只转发结果。
   */
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
    if (r && r.ok) return r.result || null;
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
  agentRustLoopPing: () => ipcRenderer.invoke('agent:rust-loop-ping'),
  agentPrepSystemPrompt: (payload) => ipcRenderer.invoke('agent:prep-system-prompt', payload || {}),
  // 记忆归纳：触发与执行都在 Main（src/agent/knowledge-maintainer.js）。
  // Renderer 只剩两件事：读写设置、上报计划 worktree 的应用结果。
  agentKnowledgePlanOutcome: (payload) => ipcRenderer.invoke('agent:knowledge-plan-outcome', payload || {}),
  agentKnowledgeSettingsGet: () => ipcRenderer.invoke('agent:knowledge-settings-get'),
  agentKnowledgeSettingsSet: (patch) => ipcRenderer.invoke('agent:knowledge-settings-set', patch || {}),
  onKnowledgeStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:knowledge-maintenance-status', handler);
    const doneHandler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:knowledge-maintenance-done', doneHandler);
    return () => {
      ipcRenderer.removeListener('agent:knowledge-maintenance-status', handler);
      ipcRenderer.removeListener('agent:knowledge-maintenance-done', doneHandler);
    };
  },
  sessionHandoffGenerate: (payload) => ipcRenderer.invoke('session:handoff-generate', payload || {}),
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
  agentCompactionTelemetrySummary: (sessionId) =>
    ipcRenderer.invoke('agent:compaction-telemetry-summary', { sessionId: sessionId || '' }),
  agentPlannerPing: () => ipcRenderer.invoke('agent:planner-ping'),
  agentPlannerRoute: (payload) => ipcRenderer.invoke('agent:planner-route', payload || {}),
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
  /**
   * 会话标题被 Main 用模型重新总结（每会话一次，轮末异步）。与 rust-loop phase 分通道：
   * 它不是某一次运行的过程事件，只是「历史列表这一行文字变了」。
   */
  onAgentSessionTitle: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:session-title', handler);
    return () => ipcRenderer.removeListener('agent:session-title', handler);
  },
  /**
   * 外部频道（企业微信等）在 Main 后台跑完一轮后的通知：只用于「让会话出现在历史列表里」，
   * 不切换当前会话。payload: { channelId, sessionId, title }。
   */
  onChannelsSessionsChanged: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('channels:sessions-changed', handler);
    return () => ipcRenderer.removeListener('channels:sessions-changed', handler);
  },
  /**
   * 主循环并发 subagent 的隔离 trace（过程卡片）。与 agent:rust-loop-phase 分通道，
   * 因为子运行的 runId 不能回写父 entry，且它需要按 subagentId 分桶。
   */
  onAgentSubagentTrace: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:subagent-trace', handler);
    return () => ipcRenderer.removeListener('agent:subagent-trace', handler);
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
  /**
   * 沙箱越界审批（Main → Renderer）：用户点完按钮回传 `{ requestId, decision }`。
   * 不回传 = Main 侧超时按「拒绝」处理，所以 Renderer 必须保证每条请求都有回包。
   */
  onSandboxApproval: (cb) => {
    const handler = (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent:sandbox-approval', handler);
    return () => ipcRenderer.removeListener('agent:sandbox-approval', handler);
  },
  /**
   * 回包。返回值 `{ ok, delivered: 'live'|'late'|'none', expired?, granted?, reason? }`：
   * `late` = 那次工具调用已超时结束，但批准被记进了本会话（界面要提示用户）。
   */
  sandboxApprovalResult: (payload) => ipcRenderer.invoke('agent:sandbox-approval-result', payload || {}),

  compactionMaybeCompact: (payload) => ipcRenderer.invoke('compaction:maybe-compact', payload || {}),
  compactionEstimateTokens: (payload) => ipcRenderer.invoke('compaction:estimate-tokens', payload || {}),
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
  worktreeCleanupRun: (runId, opts) =>
    ipcRenderer.invoke('worktree:cleanup-run', {
      runId,
      archive: !(opts && opts.archive === false),
      allowDiscardUncommitted: !!(opts && opts.allowDiscardUncommitted),
      deleteBranches: !!(opts && opts.deleteBranches)
    }),
  worktreePruneBranches: (opts) => ipcRenderer.invoke('worktree:prune-branches', opts || {}),
  worktreeRestoreApplyBackup: (backupDir) =>
    ipcRenderer.invoke('worktree:restore-apply-backup', { backupDir }),
  worktreeListManaged: () => ipcRenderer.invoke('worktree:list-managed'),
  worktreeEnforceCleanup: (payload) => ipcRenderer.invoke('worktree:enforce-cleanup', payload || {}),
  worktreePreviewRun: (runId) => ipcRenderer.invoke('worktree:preview-run', { runId }),
  worktreeApplyRun: (runId, paths, forceConflict, changeIds, opts) =>
    ipcRenderer.invoke('worktree:apply-run', {
      runId,
      paths,
      forceConflict,
      changeIds,
      forceChangeIds: (opts && opts.forceChangeIds) || [],
      allowOverwriteMainDirty: !!(opts && opts.allowOverwriteMainDirty)
    }),
  worktreeChangeDiff: (change) => ipcRenderer.invoke('worktree:change-diff', { change }),
  // 远端会话副本（SSH 每会话一份 worktree）：预览 / 应用回主目录
  worktreeRemotePreview: (payload) => ipcRenderer.invoke('worktree:remote-preview', payload || {}),
  worktreeRemoteApply: (payload) => ipcRenderer.invoke('worktree:remote-apply', payload || {})
});

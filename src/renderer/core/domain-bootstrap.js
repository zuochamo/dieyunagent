/* global window, DieyunBootstrap, DieyunNamespaces, api, currentSessionId, sqlStatusCache, initPermissionsUI, initSettingsShell, initHelpUI, initUpdateUI, initSkillsUI, initSkillCatalogUI, initComposerToolbar, initDefinedModelEditors, initSqlSettingsUI, initPluginCatalogUI, initMcpCatalogUI, initAutomationUI, initGraphIndexSettings, initCodebasePanel, initGraphPanel, initWorktreesSettings, initTerminalPane, initBrowserPanel, initPaneResizers, initSelectionToComposerDrag, applySessionWorkspace, loadSqlConfigUI, setGatewayMeta, renderSqlDbList, maybeEnforceWorktreeCleanupPolicy */
'use strict';

(function registerDomainInits() {
  const { register, setStartup } = window.DieyunBootstrap || {};
  const { register: nsRegister } = window.DieyunNamespaces || {};
  if (typeof register !== 'function') {
    console.warn('[domain-bootstrap] DieyunBootstrap missing');
    return;
  }

  if (typeof nsRegister === 'function') {
    nsRegister('DieyunSettings', {}, { compat: false });
  } else {
    window.DieyunSettings = window.DieyunSettings || {};
  }

  register({
    id: 'DieyunGateway',
    deps: [],
    require: ['connectGateway', 'gatewayCall'],
    scriptHint: 'renderer-gateway.js, core/namespace-register.js',
    init() {}
  });

  register({
    id: 'DieyunChat',
    deps: [],
    require: [
      'initChatRenderUI',
      'initChatHistoryUI',
      'loadChatFromGateway',
      'refreshHistoryList',
      'healActiveSessionFromHistory'
    ],
    scriptHint: 'renderer-chat-render.js, renderer-chat-history.js',
    init() {
      window.DieyunChat.initChatRenderUI();
      window.DieyunChat.initChatHistoryUI();
    }
  });

  register({
    id: 'DieyunSettings',
    deps: [],
    require: ['initPermissionsUI', 'initSettingsShell', 'initSkillsUI'],
    scriptHint: 'renderer-permissions.js, renderer-settings-shell.js, renderer-skills-ui.js',
    init() {
      initPermissionsUI();
      initSettingsShell();
      if (typeof initHelpUI === 'function') initHelpUI();
      if (typeof initUpdateUI === 'function') initUpdateUI();
      initSkillsUI();
      if (typeof initSkillCatalogUI === 'function') initSkillCatalogUI();
      if (typeof initDefinedModelEditors === 'function') initDefinedModelEditors();
      if (typeof initGraphIndexSettings === 'function') initGraphIndexSettings();
      if (typeof initCodebasePanel === 'function') initCodebasePanel();
      if (typeof initGraphPanel === 'function') initGraphPanel();
      if (typeof initWorktreesSettings === 'function') initWorktreesSettings();
      if (typeof initSqlSettingsUI === 'function') initSqlSettingsUI();
      if (typeof initPluginCatalogUI === 'function') initPluginCatalogUI();
      if (typeof initMcpCatalogUI === 'function') initMcpCatalogUI();
      if (typeof initAutomationUI === 'function') initAutomationUI();
    }
  });

  register({
    id: 'DieyunWorkspace',
    deps: [],
    require: ['initSidePanel'],
    scriptHint: 'renderer-side-panel.js, renderer-monaco.js',
    init() {
      window.DieyunWorkspace.initSidePanel();
      if (typeof initTerminalPane === 'function') initTerminalPane();
      if (typeof initBrowserPanel === 'function') initBrowserPanel();
      if (typeof initPaneResizers === 'function') initPaneResizers();
      if (typeof initSelectionToComposerDrag === 'function') initSelectionToComposerDrag();
    }
  });

  register({
    id: 'DieyunComposer',
    deps: ['DieyunChat'],
    require: ['initComposerFormUI', 'initComposerToolbar'],
    scriptHint: 'renderer-composer.js, renderer-composer-form.js',
    init() {
      if (typeof initComposerToolbar === 'function') initComposerToolbar();
      window.DieyunComposer.initComposerFormUI();
    }
  });


  register({
    id: 'DieyunAgent',
    deps: ['DieyunChat', 'DieyunComposer', 'DieyunGateway'],
    require: ['initAgentLoopUI', 'sendMessage'],
    scriptHint: 'renderer-agent-abort.js, renderer-agent-run.js, renderer-agent-complete.js, renderer-agent-resume.js, renderer-agent-send.js, renderer-agent-loop.js, core/namespace-register.js',
    init() {
      window.DieyunAgent.initAgentLoopUI();
      if (typeof window.DieyunAgent.initAgentResumeBanner === 'function') {
        window.DieyunAgent.initAgentResumeBanner();
      }
    }
  });

  setStartup(async () => {
    const { connectGateway, gatewayCall } = window.DieyunGateway || {};
    const {
      loadChatFromGateway,
      refreshHistoryList,
      healActiveSessionFromHistory,
      showChatLoadError
    } = window.DieyunChat || {};
    const { preloadMonacoEditor, ensureDefaultWorkspaceEditor } = window.DieyunWorkspace || {};

    const setBootProgress =
      typeof setComposerPrepProgress === 'function'
        ? setComposerPrepProgress
        : (pct) => {
            // fallback if chat-state helpers missing
            const bootEl = document.getElementById('boot-chat-progress');
            const bootFill = document.getElementById('boot-chat-progress-fill');
            if (!bootEl || !bootFill) return;
            bootEl.classList.remove('is-idle', 'is-done');
            bootEl.setAttribute('aria-busy', 'true');
            const p = Math.max(0, Math.min(100, Number(pct) || 0));
            bootFill.style.transform = p <= 0 ? 'scaleX(0)' : `scaleX(${Math.max(0.04, p / 100)})`;
            bootFill.style.opacity = p <= 0 ? '0' : '1';
          };
    const finishBootProgress =
      typeof finishComposerPrepProgress === 'function'
        ? finishComposerPrepProgress
        : () => {
            const bootEl = document.getElementById('boot-chat-progress');
            if (bootEl) {
              bootEl.classList.add('is-idle');
              bootEl.setAttribute('aria-busy', 'false');
            }
          };

    if (typeof connectGateway !== 'function') {
      throw new Error('DieyunGateway.connectGateway missing (load renderer-gateway.js before startup)');
    }
    if (typeof loadChatFromGateway !== 'function' || typeof refreshHistoryList !== 'function') {
      throw new Error('DieyunChat.loadChatFromGateway/refreshHistoryList missing');
    }

    try {
      if (typeof beginComposerPrepProgress === 'function') {
        beginComposerPrepProgress('正在加载对话');
      }
      // Evenly spaced milestones so the bar advances roughly linearly across stages.
      setBootProgress(8);
      await connectGateway();
      setBootProgress(24);

      if (typeof preloadMonacoEditor === 'function') {
        await preloadMonacoEditor().catch(() => {});
      }
      setBootProgress(40);

      let bootSessionId = currentSessionId;
      if (typeof healActiveSessionFromHistory === 'function') {
        bootSessionId = await healActiveSessionFromHistory();
      }
      setBootProgress(56);

      if (typeof applySessionWorkspace === 'function') {
        await applySessionWorkspace(bootSessionId);
      }
      if (typeof maybeEnforceWorktreeCleanupPolicy === 'function') {
        await maybeEnforceWorktreeCleanupPolicy();
      }
      if (typeof ensureDefaultWorkspaceEditor === 'function') {
        await ensureDefaultWorkspaceEditor();
      }
      setBootProgress(72);

      const chatLoaded = await loadChatFromGateway(null, bootSessionId);
      setBootProgress(88);

      await refreshHistoryList();
      setBootProgress(100);
      finishBootProgress();

      if (!chatLoaded) {
        const showErr =
          typeof showChatLoadError === 'function'
            ? showChatLoadError
            : typeof window.showChatLoadError === 'function'
              ? window.showChatLoadError
              : null;
        if (showErr) showErr('对话加载失败，请重试');
      }
    } catch (err) {
      finishBootProgress();
      throw err;
    }

    if (typeof loadSqlConfigUI === 'function') {
      await loadSqlConfigUI();
    }
    if (window.DieyunGateway?.gwState?.authed && sqlStatusCache?.enabled && typeof gatewayCall === 'function') {
      const r = await gatewayCall('sql.list_databases', {});
      if (r?.databases) {
        sqlStatusCache = { ...sqlStatusCache, databases: r.databases };
        if (typeof renderSqlDbList === 'function') renderSqlDbList(r.databases);
      }
    }
  });
})();

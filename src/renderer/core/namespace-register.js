/* global window, DieyunNamespaces, gwState, gatewayCall, connectGateway, reconnectGateway, currentSessionId, setCurrentSessionId, messages, sessionActiveRuns, appendBubble, appendUserTurn, renderChatFromMessages, renderAssistantBubbleContent, initChatRenderUI, initChatHistoryUI, loadChatFromGateway, refreshHistoryList, healActiveSessionFromHistory, showChatLoadError, isCurrentSessionSending, syncComposerForActiveSession, updateSessionRunProgress, dispatchAgentRunEvent, getComposerAgentMode, resolveComposerModelForSend, getComposerLongHorizon, sendMessage, runAgentCompletion, resumeAgentToolLoop, initAgentLoopUI, fetchChatCompletion, chatCompletionWithToolsViaRust, buildAgentTools, buildCompletionMessages, buildSessionChatHistoryBlock, executeAgentTool, renderChangesPane, initSidePanel, setSidePanelTab, preloadMonacoEditor, ensureDefaultWorkspaceEditor, buildSkillsPrompt, buildMcpPrompt, initComposerFormUI */
'use strict';

(function registerRendererNamespaces() {
  const { register } = window.DieyunNamespaces || {};
  if (typeof register !== 'function') {
    console.warn('[DieyunNamespaces] register helper missing');
    return;
  }

  register(
    'DieyunGateway',
    {
      gatewayCall,
      connectGateway,
      reconnectGateway,
      get gwState() {
        return gwState;
      }
    },
    { compat: ['gatewayCall', 'connectGateway', 'reconnectGateway'] }
  );

  register(
    'DieyunChat',
    {
      get currentSessionId() {
        return currentSessionId;
      },
      setCurrentSessionId,
      get messages() {
        return messages;
      },
      get sessionActiveRuns() {
        return sessionActiveRuns;
      },
      appendBubble,
      appendUserTurn,
      renderChatFromMessages,
      renderAssistantBubbleContent,
      updateSessionRunProgress,
      dispatchAgentRunEvent,
      initChatRenderUI,
      initChatHistoryUI,
      loadChatFromGateway,
      refreshHistoryList,
      healActiveSessionFromHistory,
      showChatLoadError,
      isCurrentSessionSending,
      syncComposerForActiveSession
    },
    {
      compat: [
        'appendBubble',
        'appendUserTurn',
        'renderChatFromMessages',
        'renderAssistantBubbleContent',
        'updateSessionRunProgress',
        'dispatchAgentRunEvent',
        'initChatRenderUI',
        'initChatHistoryUI',
        'loadChatFromGateway',
        'refreshHistoryList',
        'healActiveSessionFromHistory',
        'showChatLoadError',
        'isCurrentSessionSending',
        'syncComposerForActiveSession'
      ]
    }
  );

  register(
    'DieyunComposer',
    {
      getComposerAgentMode,
      resolveComposerModelForSend,
      getComposerLongHorizon,
      initComposerFormUI
    },
    { compat: ['getComposerAgentMode', 'resolveComposerModelForSend', 'getComposerLongHorizon', 'initComposerFormUI'] }
  );

  register(
    'DieyunAgent',
    {
      sendMessage,
      runAgentCompletion,
      resumeAgentToolLoop,
      initAgentLoopUI,
      fetchChatCompletion,
      chatCompletionWithToolsViaRust,
      buildAgentTools,
      buildCompletionMessages,
      buildSessionChatHistoryBlock,
      executeAgentTool,
      buildSkillsPrompt,
      buildMcpPrompt
    },
    {
      compat: [
        'sendMessage',
        'runAgentCompletion',
        'resumeAgentToolLoop',
        'initAgentLoopUI',
        'fetchChatCompletion',
        'chatCompletionWithToolsViaRust',
        'buildAgentTools',
        'buildCompletionMessages',
        'buildSessionChatHistoryBlock',
        'executeAgentTool',
        'buildSkillsPrompt',
        'buildMcpPrompt'
      ]
    }
  );

  register(
    'DieyunWorkspace',
    {
      renderChangesPane,
      initSidePanel,
      setSidePanelTab,
      preloadMonacoEditor,
      ensureDefaultWorkspaceEditor
    },
    { compat: ['renderChangesPane', 'initSidePanel', 'setSidePanelTab', 'preloadMonacoEditor', 'ensureDefaultWorkspaceEditor'] }
  );
})();

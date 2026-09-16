'use strict';

const { registerDeployIpc } = require('./ipc/deploy');
const { registerAgentsMdIpc, registerAgentsMdReadyIpc } = require('./ipc/agents-md');
const { registerDialogIpc } = require('./ipc/dialog');
const { registerGatewayShellIpc } = require('./ipc/gateway-shell');
const { registerSettingsIpc } = require('./ipc/settings');
const { registerPlansIpc } = require('./ipc/plans');
const { registerAppShellIpc } = require('./ipc/app-shell');
const { registerWorkspaceRemoteIpc } = require('./ipc/workspace-remote');
const { registerOptionalAssetsIpc } = require('./ipc/optional-assets');
const { registerTerminalIpc } = require('./ipc/terminal');
const { registerWorktreeIpc } = require('./ipc/worktree');
const { registerAttachmentsIpc } = require('./ipc/attachments');
const { registerSkillsMcpIpc } = require('./ipc/skills-mcp');

/**
 * IPC registered before app.whenReady (deploy, agents-md, embedding test).
 * @param {object} ctx
 */
function registerEarlyMainIpc(ctx) {
  registerDeployIpc(ctx);
  registerAgentsMdIpc(ctx);
}

/**
 * IPC registered inside app.whenReady after services are initialized.
 * @param {object} ctx
 */
function registerMainIpc(ctx) {
  registerSettingsIpc(ctx);
  registerPlansIpc(ctx);
  registerGatewayShellIpc(ctx);
  registerDialogIpc(ctx);
  registerAppShellIpc(ctx);
  registerWorkspaceRemoteIpc(ctx);
  registerOptionalAssetsIpc(ctx);
  registerTerminalIpc(ctx);
  registerAgentsMdReadyIpc(ctx);
}

/**
 * IPC that needs tool-bridge / catalogs initialized in whenReady.
 * @param {object} ctx
 */
function registerLateMainIpc(ctx) {
  registerWorktreeIpc(ctx);
  registerAttachmentsIpc(ctx);
  registerSkillsMcpIpc(ctx);
}

module.exports = { registerEarlyMainIpc, registerMainIpc, registerLateMainIpc };

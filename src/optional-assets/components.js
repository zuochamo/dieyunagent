'use strict';

const fs = require('fs');
const path = require('path');
const { OPTIONAL_ASSETS, MONACO_VERSION, BGE_ASSET_ID, BGE_MODEL_NAME, REMOTE_NODE_VERSION } = require('./manifest');
const { assetStatus, resolveRemoteGatewayNodeBundled } = require('./service');
const { isComponentInUse } = require('./usage');
const { getEmbeddingConfig, loadModelSettings } = require('../model-settings');

function resolveMonacoDevPath() {
  const devRoot = path.resolve(__dirname, '..', '..', 'node_modules', 'monaco-editor');
  const marker = path.join(devRoot, 'min', 'vs', 'editor', 'editor.main.js');
  if (fs.existsSync(marker)) return devRoot;
  return null;
}

function getBgeComponentStatus(userDataPath, ctx = {}) {
  return getOptionalComponentStatus(BGE_ASSET_ID, { ...ctx, userDataPath: userDataPath || ctx.userDataPath });
}

function getOptionalComponentStatus(assetId, ctx) {
  const def = OPTIONAL_ASSETS[assetId];
  if (!def) return null;
  const userDataPath = ctx.userDataPath || '';
  const resourcesPath = ctx.resourcesPath;
  const packRoot = ctx.remoteGatewayPackRoot;
  const st = assetStatus(assetId, { userDataPath, resourcesPath, remoteGatewayPackRoot: packRoot });

  let installed = !!st.installed;
  let source = st.source || 'missing';
  let installPath = st.path || '';

  if (assetId === 'monaco-editor' && !installed) {
    const dev = resolveMonacoDevPath();
    if (dev) {
      installed = true;
      source = 'dev';
      installPath = dev;
    }
  }
  if (assetId === 'monaco-editor' && source === 'bundled') {
    const bundledInUse = isComponentInUse(assetId);
    return {
      id: assetId,
      label: def.label,
      kind: 'bundled',
      installed,
      ready: installed,
      source,
      path: installPath,
      configured: true,
      inUse: bundledInUse,
      canDownload: false,
      canManualInstall: false,
      version: MONACO_VERSION,
      detail: bundledInUse ? '安装包内置，编辑器已加载' : '安装包内置，启动时预加载'
    };
  }

  if (assetId === 'remote-gateway-linux-node') {
    const nodeBundled = resolveRemoteGatewayNodeBundled(packRoot);
    if (nodeBundled) {
      installed = true;
      source = st.source === 'downloaded' ? st.source : 'lite-pack';
      installPath = nodeBundled;
    }
    const rg = ctx.remoteGatewayStatus;
    const inUse = !!(rg && (rg.active || rg.deploying));
    return {
      id: assetId,
      label: def.label,
      kind: 'optional',
      installed,
      ready: installed,
      source,
      path: installPath,
      configured: true,
      inUse: inUse || isComponentInUse(assetId),
      canDownload: true,
      canManualInstall: true,
      installedCache: st.source === 'downloaded',
      remoteGateway: rg || null,
      detail: installed
        ? inUse
          ? 'Linux Node 已就绪，远程 Agent 运行中'
          : 'Linux Node 已就绪'
        : '首次 SSH 远程工作区或手动下载时安装'
    };
  }

  if (assetId === BGE_ASSET_ID) {
    const settings = loadModelSettings(userDataPath);
    const emb = getEmbeddingConfig(settings);
    const configured = !!(emb && emb.builtin && !emb.disabled);
    const inUse = isComponentInUse(assetId);
    let detail = '未安装。设置 → 组件下载，或手动安装 zip（约 100MB）';
    if (installed) {
      if (inUse) detail = '内置向量推理进行中';
      else if (source === 'bundled') detail = '旧安装包内置，升级后仍可使用';
      else if (source === 'dev') detail = '开发目录 models/ 已就绪';
      else if (source === 'local') detail = '本地模型已就绪';
      else detail = '已下载，用于 @Codebase / 记忆 / 技能召回';
    }
    return {
      id: assetId,
      label: def.label,
      kind: 'optional',
      installed,
      ready: installed,
      source,
      path: installPath,
      configured,
      inUse,
      canDownload: true,
      canManualInstall: true,
      installedCache: source === 'downloaded',
      detail
    };
  }

  const inUse = isComponentInUse(assetId);
  return {
    id: assetId,
    label: def.label,
    kind: 'optional',
    installed,
    ready: installed,
    source,
    path: installPath,
    configured: true,
    inUse,
    canDownload: true,
    canManualInstall: true,
    installedCache: source === 'downloaded',
    version: assetId === 'monaco-editor' ? MONACO_VERSION : REMOTE_NODE_VERSION,
    detail: installed
      ? inUse
        ? source === 'bundled'
          ? '安装包内置，编辑器已加载'
          : '已加载，编辑器正在使用'
        : source === 'bundled'
          ? '安装包内置，启动时预加载'
          : '已下载，打开代码文件时加载'
      : '未安装，打开代码文件或手动下载'
  };
}

function getAllComponentsStatus(ctx = {}) {
  return {
    components: [
      getOptionalComponentStatus(BGE_ASSET_ID, ctx),
      getOptionalComponentStatus('monaco-editor', ctx),
      getOptionalComponentStatus('remote-gateway-linux-node', ctx)
    ].filter(Boolean),
    inflight: ctx.inflight || {}
  };
}

module.exports = {
  BGE_MODEL_NAME,
  getAllComponentsStatus,
  getBgeComponentStatus,
  getOptionalComponentStatus,
  resolveMonacoDevPath
};

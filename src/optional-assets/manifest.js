'use strict';

const path = require('path');

const MONACO_VERSION = '0.52.2';
const BGE_MODEL_NAME = 'bge-base-zh-v1.5';
const BGE_ASSET_ID = 'bge-base-zh-v1.5';
const REMOTE_NODE_VERSION = process.env.DIEYUN_REMOTE_NODE_VERSION || 'v20.18.2';

/** @type {Record<string, { id: string, archive: string, kind: 'zip'|'tgz'|'npm-tgz', verifyRel: string, installDirName: string, label: string }>} */
const OPTIONAL_ASSETS = {
  [BGE_ASSET_ID]: {
    id: BGE_ASSET_ID,
    archive: `${BGE_MODEL_NAME}.zip`,
    kind: 'zip',
    verifyRel: path.join('onnx', 'model_quantized.onnx'),
    installDirName: BGE_MODEL_NAME,
    label: '内置向量模型 bge-base-zh-v1.5'
  },
  'monaco-editor': {
    id: 'monaco-editor',
    archive: `monaco-editor-${MONACO_VERSION}.tgz`,
    kind: 'npm-tgz',
    verifyRel: path.join('min', 'vs', 'editor', 'editor.main.js'),
    installDirName: 'monaco-editor',
    label: 'Monaco 代码编辑器'
  },
  'remote-gateway-linux-node': {
    id: 'remote-gateway-linux-node',
    archive: `node-${REMOTE_NODE_VERSION}-linux-x64.tar.gz`,
    kind: 'tgz',
    verifyRel: path.join('bin', 'node'),
    installDirName: `remote-gateway-node-${REMOTE_NODE_VERSION}`,
    label: 'SSH 远程 Agent（Linux Node）'
  }
};

module.exports = {
  OPTIONAL_ASSETS,
  MONACO_VERSION,
  BGE_MODEL_NAME,
  BGE_ASSET_ID,
  REMOTE_NODE_VERSION
};

'use strict';

const fs = require('fs');
const path = require('path');

const { getEmbeddingConfig } = require('../model-settings');
const { buildLlmHeadersFromConfig } = require('./llm-request');

/**
 * 向量后端的**唯一装配点**：把「设置里的远端端点」+「本地模型/运行时在哪」合成
 * 一份 Rust `EmbeddingConfig`（`core.configure` 的 `embedding` 字段），外加给 Node 侧
 * 客户端用的粗判字段。
 *
 * 为什么要合并成一处：此前三处（`gateway/server.js`、`gateway/rpc.js`、
 * `remote/remote-index-core.js`）各拼一份 payload，本地模型一上线就会出现「本地 core 走本地、
 * 远端 core 走远端」的静默分叉——两边向量空间不同，相似度只会变差、不会报错。
 *
 * 判定口径分工（勿越界）：
 * - **走哪条路由 Rust 决定**（`crates/dieyun-core/src/embedding/mod.rs::plan`，看
 *   `provider` + 本地模型/运行时是否真的在 + 远端是否配齐）；
 * - 这里只负责**如实告诉它事实**：远端配置、本地模型目录、onnxruntime 路径。
 */

const LOCAL_MODEL_NAME = 'bge-base-zh-v1.5';
const LOCAL_DIMENSIONS = 768;

function ortLibName(platform = process.platform) {
  if (platform === 'win32') return 'onnxruntime.dll';
  if (platform === 'darwin') return 'libonnxruntime.dylib';
  return 'libonnxruntime.so';
}

/**
 * 模型根目录：`DIEYUN_MODELS_DIR` 优先（开发时指向仓库 `models/`），否则 `<userData>/models`。
 * 打包产物里 userData 那份才是「可选下载」的落点；`models/` 在仓库里不进安装包。
 */
function modelsRoot(userData, env = process.env) {
  const explicit = String(env.DIEYUN_MODELS_DIR || '').trim();
  if (explicit) return explicit;
  return userData ? path.join(userData, 'models') : '';
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 权限/网络盘抖一下不影响判定：当作不存在
    }
  }
  return '';
}

/** 本地模型目录（含 `onnx/*.onnx` 与 `tokenizer.json` 才算数）。 */
function resolveLocalModelDir(userData, env = process.env) {
  const root = modelsRoot(userData, env);
  if (!root) return '';
  const dir = firstExisting([path.join(root, LOCAL_MODEL_NAME), root]);
  if (!dir) return '';
  const hasOnnx = firstExisting([
    path.join(dir, 'onnx', 'model_quantized.onnx'),
    path.join(dir, 'onnx', 'model.onnx')
  ]);
  if (!hasOnnx) return '';
  if (!firstExisting([path.join(dir, 'tokenizer.json')])) return '';
  return dir;
}

/** onnxruntime 动态库：`DIEYUN_ORT_LIB` 优先，否则找 `<models>/onnxruntime/<平台名>`。 */
function resolveLocalRuntimeLib(userData, env = process.env) {
  const explicit = String(env.DIEYUN_ORT_LIB || '').trim();
  if (explicit) return firstExisting([explicit]) || explicit;
  const root = modelsRoot(userData, env);
  if (!root) return '';
  return firstExisting([path.join(root, 'onnxruntime', ortLibName())]);
}

function normalizeProvider(raw) {
  const p = String(raw || '').trim().toLowerCase();
  return p === 'local' || p === 'remote' ? p : 'auto';
}

/**
 * 「这一版运行时的向量后端事实」：由 [`buildEmbeddingCoreConfig`] 每次装配时顺手记下。
 *
 * 为什么需要它：`createEmbeddingClient(...)` 有六个调用点（main-entry / headless /
 * 技能召回 / 工具召回 / 共享记忆），其中几处拿到的是 Renderer 递下来的旧式远端配置。
 * 让它们各自去拼「有没有本地模型」必然漂移；这里只保留**最后一次装配出的事实**，
 * 客户端一律读它 —— 与推给 Rust 的那份逐字一致。
 */
let currentCoreConfig = null;

function setEmbeddingCoreConfig(cfg) {
  currentCoreConfig = cfg && typeof cfg === 'object' ? cfg : null;
}

function currentEmbeddingCoreConfig() {
  return currentCoreConfig;
}

/**
 * `core.configure.embedding` 的载荷。
 *
 * @param {object} settings model-settings（磁盘快照）
 * @param {{ userData?: string, allowLocal?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 *   `allowLocal: false` 给**远端** core 用：远端主机上有没有模型由那台机器决定，
 *   宿主的本地目录不能替它声明（声明了就会指向一个不存在的路径）。
 */
function buildEmbeddingCoreConfig(settings, opts = {}) {
  const env = opts.env || process.env;
  const userData = opts.userData || '';
  const allowLocal = opts.allowLocal !== false;
  const remote = getEmbeddingConfig(settings) || {};
  const localModelDir = allowLocal ? resolveLocalModelDir(userData, env) : '';
  const localRuntimeLib = allowLocal ? resolveLocalRuntimeLib(userData, env) : '';
  const provider = normalizeProvider(settings && settings.embeddingProvider);

  const payload = {
    // 只有显式关掉才 disabled：走不走得通由 Rust 的 plan() 判（远端没配 + 本地不可用 → Disabled）
    disabled: settings && settings.embeddingDisabled === true,
    provider,
    baseUrl: remote.baseUrl || '',
    apiKey: remote.apiKey || '',
    model: remote.model || '',
    dimensions: Number(remote.dimensions) || 1024,
    // 请求头由 llm-request 装配后交给 Rust 直接用（Rust 不自行推导鉴权）
    headers: buildLlmHeadersFromConfig(remote),
    authMode: String(remote.authMode || '').trim()
  };
  if (localModelDir) payload.localModelDir = localModelDir;
  if (localRuntimeLib) payload.localRuntimeLib = localRuntimeLib;
  // 装配即事实：客户端读这里，不各自再拼一份
  setEmbeddingCoreConfig(payload);
  return payload;
}

/**
 * Node 侧客户端的**粗判**：值不值得发一次向量请求。
 *
 * 权威判定在 Rust（`embedding.plan`）；这里只是避免「明知没有通道还每轮打一次 RPC」。
 * 因此宁可宽一点：本地模型在 → true；远端配齐 → true；两样都没有 → false。
 */
function embeddingChannelLikelyAvailable(coreCfg) {
  if (!coreCfg || coreCfg.disabled) return false;
  if (coreCfg.localModelDir) return true;
  return !!(String(coreCfg.model || '').trim() && String(coreCfg.baseUrl || '').trim());
}

/** 与 Rust `EmbeddingConfig::signature` 同口径的本地签名（UI 展示 / 存量库判过期用）。 */
function localEmbeddingSignature() {
  return `${LOCAL_MODEL_NAME}@${LOCAL_DIMENSIONS}|cls`;
}

module.exports = {
  LOCAL_MODEL_NAME,
  LOCAL_DIMENSIONS,
  ortLibName,
  modelsRoot,
  resolveLocalModelDir,
  resolveLocalRuntimeLib,
  buildEmbeddingCoreConfig,
  setEmbeddingCoreConfig,
  currentEmbeddingCoreConfig,
  embeddingChannelLikelyAvailable,
  localEmbeddingSignature
};

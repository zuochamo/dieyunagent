'use strict';

const fs = require('fs');
const path = require('path');
const { dieyunHome } = require('./agent-home');

const FILENAME = 'dieyun.md';
const MAX_CHARS = 12000;
const ASSISTANT_IDENTITY = '叠云会计服务 AI 助理';
const USER_RULES_SECTION = '## 身份与称呼';

function bundledTemplatePath() {
  return path.join(__dirname, '..', 'assets', FILENAME);
}

/** C:\Users\<用户名>\.dieyun\dieyun.md */
function dieyunMdPath() {
  return path.join(dieyunHome(), FILENAME);
}

/**
 * 用户主目录 ~/.dieyun 下无 dieyun.md 时，从内置模板复制一份。
 * @returns {{ created: boolean, path: string }}
 */
function ensureDieyunMdInHome() {
  const target = dieyunMdPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      return { created: false, path: target };
    }
    const src = bundledTemplatePath();
    if (!fs.existsSync(src)) return { created: false, path: target };
    fs.copyFileSync(src, target);
    return { created: true, path: target };
  } catch {
    return { created: false, path: target };
  }
}

/**
 * 读取 ~/.dieyun/dieyun.md，供系统提示注入。
 * @returns {{ content: string, path: string, exists: boolean }}
 */
function loadDieyunInstructions() {
  const filePath = dieyunMdPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { content: '', path: filePath, exists: false };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const content = String(raw || '').trim().slice(0, MAX_CHARS);
    return { content, path: filePath, exists: !!content };
  } catch {
    return { content: '', path: filePath, exists: false };
  }
}

function formatDieyunSystemBlock() {
  const { content, path: filePath, exists } = loadDieyunInstructions();
  if (!exists || !content) return '';
  return `【全局用户规则 · dieyun.md】\n（文件：${filePath}）\n跨项目个人偏好，优先于长期记忆；与 AGENTS.md 并存，与用户本轮输入冲突时以用户输入为准。\n\n${content}`;
}

/**
 * 确保 dieyun.md 存在并用系统默认编辑器打开。
 * @returns {Promise<{ ok: boolean, path: string }>}
 */
async function openDieyunMdInEditor() {
  const { shell } = require('electron');
  const { path: filePath } = ensureDieyunMdInHome();
  const err = await shell.openPath(filePath);
  if (err) {
    const e = new Error(err || '无法打开 dieyun.md');
    e.code = 'OPEN_DIEYUN_MD_FAILED';
    throw e;
  }
  return { ok: true, path: filePath };
}

module.exports = {
  FILENAME,
  MAX_CHARS,
  ASSISTANT_IDENTITY,
  USER_RULES_SECTION,
  bundledTemplatePath,
  dieyunMdPath,
  ensureDieyunMdInHome,
  loadDieyunInstructions,
  formatDieyunSystemBlock,
  openDieyunMdInEditor
};

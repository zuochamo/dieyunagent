'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENT_DIR_NAME = '.dieyun';

/**
 * 预装技能种子顶层目录（~/.dieyun/skills 下 minimax / curated 等）。
 * 其下技能视为内置：列表只允许隐藏，不允许物理删除。
 * 单一来源：scanner 的 builtin 标记与 skills:delete 的可删性判定都读这里。
 */
const SEEDED_SKILL_CATEGORIES = new Set(['minimax', 'curated', 'dieyun', 'weather']);

const README_SKILLS = `# 用户技能目录

每个技能使用单独子文件夹，内含 \`SKILL.md\`（YAML frontmatter 需含 name、description）。

示例：\`my-skill/SKILL.md\`
`;

const README_MEMORY = `# 记忆笔记（可选）

可存放 Markdown 笔记；对话长期记忆主要保存在应用 SQLite。
`;

const README_WORKSPACE = `# 默认工作目录

未在应用中单独选择工作空间时，对话通过 fs_write_file 等工具生成的文件（如 .py）会写入此目录。
选择工作空间后，文件默认写入所选项目目录；此目录、用户主目录与系统临时目录仍可读写，
可作为工作空间之外的落脚点。
`;

/** 用户主目录下的叠云 Agent 数据根：C:\\Users\\<用户名>\\.dieyun */
function dieyunHome() {
  return path.join(os.homedir(), AGENT_DIR_NAME);
}

/**
 * 用户主目录本身（本地宽松档的可读写根之一）。
 * 单独成函数是为了让「本机可访问范围」只有一个定义处（见 gateway/server.js 白名单组装）。
 */
function dieyunUserHome() {
  return os.homedir();
}

/** 系统临时目录（本地宽松档的可读写根之一）。 */
function systemTempDir() {
  return os.tmpdir();
}

function dieyunSkillsDir() {
  return path.join(dieyunHome(), 'skills');
}

function dieyunMemoryDir() {
  return path.join(dieyunHome(), 'memory');
}

/** 未选工作空间时的默认可写目录：C:\\Users\\<用户名>\\.dieyun\\workspace */
function dieyunDefaultWorkspaceDir() {
  return path.join(dieyunHome(), 'workspace');
}

/**
 * 历史兼容：Cursor 等工具常用 ~/.agents/skills。
 * 叠云 Agent 以 ~/.dieyun 为唯一数据根；启动时会将 .agents/skills 一次性复制到 .dieyun/skills，不再默认扫描 .agents。
 */
function agentsHome() {
  return path.join(os.homedir(), '.agents');
}

function globalSkillsDir() {
  return path.join(agentsHome(), 'skills');
}

function globalMemoryDir() {
  return path.join(agentsHome(), 'memory');
}

function userDataSkillsDir(userData) {
  return path.join(userData, 'skills', 'user');
}

/** 仅扫描已存在的工作空间 .dieyun（不再自动创建） */
function workspaceSkillsDir(workspacePath) {
  if (!workspacePath) return null;
  const dir = path.join(path.resolve(String(workspacePath)), AGENT_DIR_NAME, 'skills');
  try {
    if (fs.existsSync(dir)) return dir;
  } catch {
    // ignore
  }
  return null;
}

function workspaceMemoryDir(workspacePath) {
  if (!workspacePath) return null;
  const dir = path.join(path.resolve(String(workspacePath)), AGENT_DIR_NAME, 'memory');
  try {
    if (fs.existsSync(dir)) return dir;
  } catch {
    // ignore
  }
  return null;
}

function writeReadmeIfMissing(dir, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'README.md');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content, 'utf8');
  }
}

/**
 * 初始化用户主目录 ~/.dieyun、应用数据 skills/user 等（不在工作空间下创建 .dieyun；不再创建 ~/.agents）。
 * @param {string} userData
 * @param {string | null | undefined} [_workspacePath] 保留参数兼容调用方，仅用于扫描已有工作空间目录
 */
function ensureAgentHomeDirs(userData, _workspacePath) {
  const { migrateAgentsSkillsToDieyun } = require('./agents-skills-migrate');
  const migration = migrateAgentsSkillsToDieyun();

  const pairs = [
    [dieyunSkillsDir(), README_SKILLS],
    [dieyunMemoryDir(), README_MEMORY],
    [dieyunDefaultWorkspaceDir(), README_WORKSPACE]
  ];

  const dirs = [];
  for (const [dir, readme] of pairs) {
    writeReadmeIfMissing(dir, readme);
    dirs.push(dir);
  }
  return {
    dirs,
    dieyunHome: dieyunHome(),
    dieyunSkills: dieyunSkillsDir(),
    dieyunMemory: dieyunMemoryDir(),
    dieyunWorkspace: dieyunDefaultWorkspaceDir(),
    agentsSkillsMigration: migration,
    userSkills: userDataSkillsDir(userData)
  };
}

/**
 * @param {string} userData
 * @param {string | null | undefined} workspacePath
 */
function getScanRoots(userData, workspacePath) {
  const roots = [dieyunSkillsDir()];
  if (userData) roots.push(userDataSkillsDir(userData));
  const wsSkills = workspaceSkillsDir(workspacePath);
  if (wsSkills) roots.push(wsSkills);
  return roots;
}

/**
 * @param {string} root
 */
function isSkillRootAccessible(root) {
  if (!root || typeof root !== 'string') return false;
  try {
    fs.accessSync(path.resolve(root.trim()), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} roots
 */
function filterAccessibleSkillRoots(roots) {
  return (roots || []).filter((r) => isSkillRootAccessible(r));
}

/**
 * 技能目录命中的扫描根（取最长匹配，避免嵌套根误判）。
 * @param {string} dir
 * @param {string[]} roots
 * @returns {string} 命中的根绝对路径；未命中返回 ''
 */
function matchSkillRoot(dir, roots) {
  if (!dir || typeof dir !== 'string') return '';
  const resolved = path.resolve(dir);
  let best = '';
  for (const root of roots || []) {
    if (!root) continue;
    const resolvedRoot = path.resolve(String(root));
    const under = resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    if (under && resolvedRoot.length > best.length) best = resolvedRoot;
  }
  return best;
}

/** 预装技能种子根；只有这些根下的种子分类目录才算「内置」并受删除保护 */
function seededSkillRoots() {
  return [dieyunSkillsDir()];
}

/**
 * root 是否就是种子根（~/.dieyun/skills）。
 * 其它扫描根（userData / 工作空间）下出现同名 minimax 等目录属于用户自己的技能，不参与内置判定。
 * @param {string} root
 */
function isSeededSkillRoot(root) {
  if (!root) return false;
  const resolved = path.resolve(String(root));
  return seededSkillRoots().some((r) => path.resolve(r) === resolved);
}

/**
 * 目录是否位于 root 下的种子分类目录内（内置技能判定）。
 * @param {string} dir
 * @param {string} root
 */
function isSeededSkillDir(dir, root) {
  if (!dir || !root) return false;
  const resolved = path.resolve(String(dir));
  const resolvedRoot = path.resolve(String(root));
  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) return false;
  const top = path
    .relative(resolvedRoot, resolved)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)[0];
  return SEEDED_SKILL_CATEGORIES.has(top || '');
}

/**
 * 「删除技能」可删性判定的唯一来源：仅扫描根内、非根本身、非种子分类目录的技能可物理删除。
 * @param {string} dir 技能目录绝对路径
 * @param {string[]} roots 当前生效的扫描根（getScanRoots 的结果）
 * @returns {{ deletable: boolean, reason: '' | 'INVALID_DIR' | 'OUTSIDE_ROOTS' | 'ROOT_DIR' | 'SEEDED', root: string }}
 */
function evaluateSkillDeletable(dir, roots) {
  if (!dir || typeof dir !== 'string') return { deletable: false, reason: 'INVALID_DIR', root: '' };
  const resolved = path.resolve(dir);
  const root = matchSkillRoot(resolved, roots);
  if (!root) return { deletable: false, reason: 'OUTSIDE_ROOTS', root: '' };
  if (resolved === root) return { deletable: false, reason: 'ROOT_DIR', root };
  if (isSeededSkillRoot(root) && isSeededSkillDir(resolved, root)) {
    return { deletable: false, reason: 'SEEDED', root };
  }
  return { deletable: true, reason: '', root };
}

function sanitizeSkillFolderName(name) {
  return (
    String(name || 'custom-skill')
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 64) || 'custom-skill'
  );
}

/** 在用户主目录 ~/.dieyun/skills 创建 SKILL.md。 */
function createUserSkill(userData, workspacePath, payload) {
  const name = payload && payload.name != null ? String(payload.name).trim() : '';
  const description =
    payload && payload.description != null ? String(payload.description).trim() : '';
  const content = payload && payload.content != null ? String(payload.content).trim() : '';
  if (!name) throw new Error('技能名称必填');

  ensureAgentHomeDirs(userData, workspacePath);
  const baseDir = dieyunSkillsDir();
  const folderName = sanitizeSkillFolderName(name);
  let finalDir = path.join(baseDir, folderName);
  let n = 1;
  while (fs.existsSync(finalDir)) {
    finalDir = path.join(baseDir, `${folderName}-${n++}`);
  }
  fs.mkdirSync(finalDir, { recursive: true });
  const body =
    content || '（由叠云 Agent 创建，请在此补充技能说明与操作步骤。）';
  const descLine = description.replace(/\r?\n/g, ' ');
  const skillKey = `user:${path.basename(finalDir)}`;
  const md = `---\nname: ${name}\ndescription: ${descLine}\ncategory: 用户添加\nskillKey: ${skillKey}\n---\n\n${body}\n`;
  const skillPath = path.join(finalDir, 'SKILL.md');
  fs.writeFileSync(skillPath, md, 'utf8');
  return { dir: finalDir, skillPath, name, description, skillKey };
}

function describeAgentHome(userData, workspacePath) {
  ensureAgentHomeDirs(userData, workspacePath);
  return {
    dieyunHome: dieyunHome(),
    dieyunSkills: dieyunSkillsDir(),
    dieyunMemory: dieyunMemoryDir(),
    dieyunWorkspace: dieyunDefaultWorkspaceDir(),
    legacyAgentsSkills: globalSkillsDir(),
    userSkills: userDataSkillsDir(userData),
    workspaceSkills: workspaceSkillsDir(workspacePath)
  };
}

module.exports = {
  AGENT_DIR_NAME,
  SEEDED_SKILL_CATEGORIES,
  seededSkillRoots,
  isSeededSkillRoot,
  matchSkillRoot,
  isSeededSkillDir,
  evaluateSkillDeletable,
  dieyunHome,
  dieyunUserHome,
  systemTempDir,
  dieyunSkillsDir,
  dieyunMemoryDir,
  dieyunDefaultWorkspaceDir,
  agentsHome,
  globalSkillsDir,
  globalMemoryDir,
  userDataSkillsDir,
  workspaceSkillsDir,
  ensureAgentHomeDirs,
  getScanRoots,
  isSkillRootAccessible,
  filterAccessibleSkillRoots,
  createUserSkill,
  describeAgentHome,
  sanitizeSkillFolderName
};

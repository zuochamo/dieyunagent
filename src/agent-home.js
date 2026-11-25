'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
// 启用状态的权威存储在 Main（`skills/enabled-store.js`）：新建技能要顺手在那里启用，
// 否则无人值守轮次（频道 / 计划 / headless）里它永远不注入。见下面 createUserSkill 的说明。
const { setSkillEnabled: setSkillEnabledInStore } = require('./skills/enabled-store');

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

**这里是落脚点，不是长期仓库**：应用会自动回收它 ——
超过「默认工作区保留天数」（默认 30 天）没动过的条目会被删除；
总容量超过上限（默认 1 GB）时从最旧的开始继续清。
含工程标记（.git / package.json / Cargo.toml / pyproject.toml / go.mod / requirements.txt / SKILL.md）
或最近 24 小时内动过的条目永不自动删除。
要长期保留的产出请放进自选工作空间，别停在这里。
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
  // 新建即启用：**写在这里**而不是各个调用点（设置页按钮 / Agent 工具 / 频道轮次），
  // 否则只有带 Renderer 的那条路会启用它，`skill_create` 在频道 / 计划 / headless 里
  // 造出来的技能等于没建。键是扫描 id（`scanner.js#resolveBundledSkillId` 把 skillKey
  // 加 `builtin:` 前缀），与本函数产出的 skillKey 同一份命名。写状态失败不影响创建本身。
  try {
    setSkillEnabledInStore(userData, `builtin:${skillKey}`, true);
  } catch {
    // 状态文件写不进去（只读 userData 等）时，技能仍然存在，只是要用户在设置页手动启用
  }
  return { dir: finalDir, skillPath, name, description, skillKey };
}

/**
 * 删除技能目录的**唯一实现**：IPC（设置页删除按钮）与 Agent 工具 `skill_delete` 共用。
 *
 * 判定用 `evaluateSkillDeletable`（可删范围 = 扫描根内、非根本身、非种子技能），
 * 再加一条「目录里真有 SKILL.md」加固 —— 防伪造 dir 误删根内其它目录。
 * @param {string} userData userData 目录
 * @param {string|null} workspacePath 当前工作空间（决定扫描根）
 * @param {string} dir 要删的技能目录
 * @returns {{ ok: true, dir: string }}
 */
async function deleteUserSkill(userData, workspacePath, dir) {
  if (!dir || typeof dir !== 'string') throw new Error('dir 必填');
  const roots = filterAccessibleSkillRoots(getScanRoots(userData, workspacePath).map((r) => path.resolve(r)));
  const verdict = evaluateSkillDeletable(dir, roots);
  if (!verdict.deletable) {
    if (verdict.reason === 'ROOT_DIR') throw new Error('不能删除技能根目录');
    if (verdict.reason === 'SEEDED') throw new Error('预装内置技能不可删除');
    throw new Error('仅可删除当前扫描范围内的技能目录');
  }
  const resolved = path.resolve(dir);
  try {
    await fsp.access(path.join(resolved, 'SKILL.md'));
  } catch {
    throw new Error('目标目录不是技能目录（缺少 SKILL.md）');
  }
  await fsp.rm(resolved, { recursive: true, force: true });
  return { ok: true, dir: resolved };
}

/**
 * 改技能的 **SKILL.md**（目录不重命名、`skillKey` 不变）。
 *
 * 为什么需要它：`createUserSkill` 每次都**新建**一个目录（同名会派生 `name-1`），
 * 所以「把这条技能改一下」以前只能删了重建 —— 重建换目录 = 换 `skillKey` = 启用状态丢失，
 * 模型还会在技能列表里留下 `foo` / `foo-1` / `foo-2`。改内容不该是这个成本。
 *
 * 判定与删除共用同一套（`evaluateSkillDeletable`：扫描根内、非根本身、非种子技能），
 * 理由也一样：种子里的是随包更新的只读内容，写进去下次升级就没了。
 *
 * @param {string} userData userData 目录
 * @param {string|null} workspacePath 当前工作空间（决定扫描根）
 * @param {{ dir: string, name?: string, description?: string, content?: string }} payload
 * @returns {Promise<{ dir: string, skillPath: string, before: string, after: string }>}
 */
async function updateUserSkill(userData, workspacePath, payload) {
  const dir = String((payload && payload.dir) || '').trim();
  if (!dir) throw new Error('dir 必填（先列出技能目录，别猜路径）');
  const roots = filterAccessibleSkillRoots(getScanRoots(userData, workspacePath).map((r) => path.resolve(r)));
  const verdict = evaluateSkillDeletable(dir, roots);
  if (!verdict.deletable) {
    if (verdict.reason === 'ROOT_DIR') throw new Error('不能改技能根目录');
    if (verdict.reason === 'SEEDED') throw new Error('预装内置技能不可修改（它随包更新，改了下次升级就丢）');
    throw new Error('仅可修改当前扫描范围内的技能目录');
  }
  const resolved = path.resolve(dir);
  const skillPath = path.join(resolved, 'SKILL.md');
  let before = '';
  try {
    before = await fsp.readFile(skillPath, 'utf8');
  } catch {
    throw new Error('目标目录不是技能目录（缺少 SKILL.md）');
  }

  // frontmatter 只做「键值行」级处理：这是我们自己写出去的格式（见 createUserSkill），
  // 不引 YAML 库、也不重排未知键 —— 保住 `skillKey` 与用户手加的字段。
  const parsed = parseSkillFrontmatter(before);
  const nextName =
    payload && payload.name != null
      ? String(payload.name).replace(/\r?\n/g, ' ').trim()
      : parsed.meta.name || '';
  const nextDesc =
    payload && payload.description != null ? String(payload.description).trim() : parsed.meta.description || '';
  const nextBody = payload && payload.content != null ? String(payload.content) : parsed.body;
  if (!nextName) throw new Error('技能名称不能为空');

  const meta = {
    ...parsed.meta,
    name: nextName,
    description: nextDesc.replace(/\r?\n/g, ' ')
  };
  const after = `---\n${Object.entries(meta)
    .filter(([, v]) => String(v || '').trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/\r?\n/g, ' ')}`)
    .join('\n')}\n---\n\n${String(nextBody || '').trim()}\n`;

  await fsp.writeFile(skillPath, after, 'utf8');
  return { dir: resolved, skillPath, before, after };
}

/** `---\nkey: value\n---\nbody` → `{ meta, body }`（没有 frontmatter 时 meta 为空、body 是全文）。 */
function parseSkillFrontmatter(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const meta = {};
  if (!raw.startsWith('---\n')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { meta, body: raw };
  const head = raw.slice(4, end);
  for (const line of head.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  const body = raw.slice(end + 4).replace(/^\n+/, '');
  return { meta, body };
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
  SEEDED_SKILL_CATEGORIES,
  seededSkillRoots,
  isSeededSkillDir,
  evaluateSkillDeletable,
  dieyunHome,
  dieyunUserHome,
  systemTempDir,
  dieyunSkillsDir,
  dieyunMemoryDir,
  dieyunDefaultWorkspaceDir,
  globalSkillsDir,
  userDataSkillsDir,
  workspaceSkillsDir,
  ensureAgentHomeDirs,
  getScanRoots,
  filterAccessibleSkillRoots,
  createUserSkill,
  deleteUserSkill,
  updateUserSkill,
  describeAgentHome,
  sanitizeSkillFolderName
};

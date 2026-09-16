#!/usr/bin/env node
/**
 * 将 MiniMax-AI/skills 仓库中的 skills/* 同步到 skills/bundled/minimax/
 * 构建前或开发环境可手动/自动执行：node scripts/vendor-minimax-skills.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { CORE_MINIMAX_IDS } from './core-bundled-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destRoot = path.join(root, 'skills', 'bundled', 'minimax');
const tmp = path.join(root, '.tmp-minimax-skills');
const repo = 'https://github.com/MiniMax-AI/skills.git';

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 预装展示名（文档办公等在新装机器上更易辨认） */
const BUNDLED_DISPLAY_NAMES = {
  'minimax-docx': 'MiniMax · Word 文档',
  'minimax-pdf': 'MiniMax · PDF 文档',
  'minimax-xlsx': 'MiniMax · Excel 表格',
  'pptx-generator': 'MiniMax · PPT 幻灯片',
  'minimax-multimodal-toolkit': 'MiniMax · 多模态工具包',
  'vision-analysis': 'MiniMax · 图像分析',
  'frontend-dev': 'MiniMax · 前端开发',
  'fullstack-dev': 'MiniMax · 全栈开发',
  'minimax-music-gen': 'MiniMax · 音乐生成',
  'buddy-sings': 'MiniMax · 歌声合成'
};

function patchSkillMd(file) {
  if (!fs.existsSync(file)) return;
  let raw = fs.readFileSync(file, 'utf8');
  if (!raw.startsWith('---')) return;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return;
  const body = raw.slice(m[0].length);
  let meta = m[1];
  const folder = path.basename(path.dirname(file));
  const displayName = BUNDLED_DISPLAY_NAMES[folder];
  if (displayName) {
    if (/^name:/m.test(meta)) meta = meta.replace(/^name:.*$/m, `name: ${displayName}`);
    else meta = `name: ${displayName}\n${meta}`;
  }
  if (!/^category:/m.test(meta)) {
    meta = `${meta.trimEnd()}\ncategory: MiniMax\n`;
  }
  if (!/^skillKey:/m.test(meta)) {
    meta = `${meta.trimEnd()}\nskillKey: minimax:${folder}\n`;
  }
  fs.writeFileSync(file, `---\n${meta.trim()}\n---${body}`, 'utf8');
}

rmrf(tmp);
fs.mkdirSync(path.dirname(destRoot), { recursive: true });
console.log('[vendor-minimax] cloning', repo);
execSync(`git clone --depth 1 --filter=blob:none --sparse ${repo} "${tmp}"`, {
  stdio: 'inherit',
  cwd: root
});
execSync('git sparse-checkout set skills', { stdio: 'inherit', cwd: tmp });

const srcSkills = path.join(tmp, 'skills');
if (!fs.existsSync(srcSkills)) {
  console.error('[vendor-minimax] skills/ not found in clone');
  process.exit(1);
}

rmrf(destRoot);
fs.mkdirSync(destRoot, { recursive: true });
for (const id of CORE_MINIMAX_IDS) {
  const from = path.join(srcSkills, id);
  if (!fs.existsSync(from)) {
    console.warn('[vendor-minimax] missing skill dir:', id);
    continue;
  }
  const to = path.join(destRoot, id);
  copyDir(from, to);
  patchSkillMd(path.join(to, 'SKILL.md'));
  console.log('[vendor-minimax]', id);
}

rmrf(tmp);
console.log('[vendor-minimax] done ->', destRoot);

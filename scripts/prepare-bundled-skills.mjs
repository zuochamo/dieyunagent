#!/usr/bin/env node
/**
 * 构建前准备核心预装技能：裁剪非核心技能；缺失时尝试 vendor / curated 同步。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  CORE_MINIMAX_IDS,
  CORE_CURATED_IDS,
  CORE_REQUIRED
} from './core-bundled-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledRoot = path.join(root, 'skills', 'bundled');

function missing() {
  return CORE_REQUIRED.filter((rel) => !fs.existsSync(path.join(bundledRoot, rel)));
}

function listMinimaxSkills() {
  const dir = path.join(bundledRoot, 'minimax');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

try {
  execSync('node scripts/prune-bundled-to-core.mjs', { stdio: 'inherit', cwd: root });
} catch (e) {
  console.warn('[prepare-bundled-skills] prune 跳过:', e.message || e);
}

let miss = missing();
if (miss.length) {
  console.log('[prepare-bundled-skills] 缺少核心技能，尝试同步…', miss.join(', '));
  try {
    if (miss.some((m) => m.startsWith('minimax/'))) {
      execSync('node scripts/vendor-minimax-skills.mjs', { stdio: 'inherit', cwd: root });
    }
    if (miss.some((m) => m.startsWith('curated/'))) {
      execSync('node scripts/bundle-curated-skills.mjs', { stdio: 'inherit', cwd: root });
    }
    execSync('node scripts/prune-bundled-to-core.mjs', { stdio: 'inherit', cwd: root });
  } catch (e) {
    console.error('[prepare-bundled-skills] 同步失败:', e.message || e);
  }
  miss = missing();
}

if (miss.length) {
  console.error('[prepare-bundled-skills] 仍缺少:', miss.join(', '));
  process.exit(1);
}

const minimax = listMinimaxSkills();
const curatedPresent = CORE_CURATED_IDS.filter((id) =>
  fs.existsSync(path.join(bundledRoot, 'curated', id, 'SKILL.md'))
);

const manifest = {
  generatedAt: new Date().toISOString(),
  coreOnly: true,
  minimaxCount: minimax.length,
  minimaxSkills: minimax,
  officeSkills: ['minimax-docx', 'minimax-pdf', 'minimax-xlsx', 'pptx-generator'].filter((n) =>
    minimax.includes(n)
  ),
  curatedIds: CORE_CURATED_IDS,
  curatedPresent,
  dieyunCount: 0,
  required: CORE_REQUIRED
};

fs.writeFileSync(
  path.join(bundledRoot, 'BUNDLED-MANIFEST.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);

console.log(
  `[prepare-bundled-skills] OK：核心 MiniMax ${minimax.length}，精选 ${curatedPresent.length}/${CORE_CURATED_IDS.length}，天气 1，dieyun 0`
);

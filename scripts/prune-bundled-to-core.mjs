#!/usr/bin/env node
/** 删除 skills/bundled 中非核心预装（dieyun 全删、minimax/curated 白名单外删除） */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CORE_MINIMAX_IDS, CORE_CURATED_IDS } from './core-bundled-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = path.join(root, 'skills', 'bundled');

function rmDir(p) {
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

function pruneCategory(cat, keepIds) {
  const dir = path.join(bundled, cat);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (keepIds.has(ent.name)) continue;
    rmDir(path.join(dir, ent.name));
    removed += 1;
    console.log('[prune-bundled]', `removed ${cat}/${ent.name}`);
  }
  return removed;
}

if (rmDir(path.join(bundled, 'dieyun'))) {
  console.log('[prune-bundled] removed dieyun/');
}

function pruneOrWipe(cat, keepIds) {
  if (keepIds.size === 0) {
    if (rmDir(path.join(bundled, cat))) {
      console.log(`[prune-bundled] removed ${cat}/`);
    }
    return 0;
  }
  return pruneCategory(cat, keepIds);
}

const n1 = pruneOrWipe('minimax', new Set(CORE_MINIMAX_IDS));
const n2 = pruneOrWipe('curated', new Set(CORE_CURATED_IDS));
console.log(`[prune-bundled] done: minimax -${n1}, curated -${n2}`);

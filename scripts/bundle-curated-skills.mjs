#!/usr/bin/env node
/**
 * 将精选技能复制到 skills/bundled/curated/ 并打上 builtin:curated:* 标记（随安装包预装）。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { CORE_CURATED_IDS } from './core-bundled-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destRoot = path.join(root, 'skills', 'bundled', 'curated');
const home = os.homedir();

/** @type {{ id: string, displayName: string, relPaths: string[] }[]} */
const CURATED = [
  {
    id: 'skill-vetter',
    displayName: 'Skill Vetter · 技能安全审查',
    relPaths: [
      '.dieyun/skills/skill-vetter-1.0.0',
      '.agents/skills/skill-vetter-1.0.0'
    ]
  },
  {
    id: 'skill-creator',
    displayName: 'Skill Creator · 技能创作',
    relPaths: ['.dieyun/skills/skill-creator-0.1.0', '.agents/skills/skill-creator-0.1.0']
  },
  {
    id: 'multi-search-engine',
    displayName: 'Multi Search Engine · 多引擎搜索',
    relPaths: [
      '.workbuddy/skills-marketplace/skills/multi-search-engine',
      '.codebuddy/skills-marketplace/skills/multi-search-engine'
    ]
  }
];

const STUBS = {
  'weather-china': {
    displayName: 'Weather China · 中国天气',
    body: `当用户询问中国城市天气、气温、降水、风力时，**必须用 \`web_fetch\` 查询 Open-Meteo**（禁止编造）。

1. \`web_fetch\` → \`https://geocoding-api.open-meteo.com/v1/search?name={城市}&count=1&language=zh\`
2. 取 \`results[0]\` 的经纬度与地名
3. \`web_fetch\` → \`https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto\`

将返回整理为简短中文；若无匹配城市或接口失败，说明原因并建议更具体的地名。`
  },
  'baidu-search': {
    displayName: 'Baidu Search · 百度搜索',
    body: `用户需要百度网页搜索时：

1. 优先使用 \`host_open_url\` 打开 \`https://www.baidu.com/s?wd=\` + URL 编码后的关键词，供用户查看结果。
2. 若已启用「多引擎搜索」能力，可配合 \`multi-search-engine\` 技能中的 Baidu 引擎说明，用 \`host_exec\` / 抓取方式获取摘要（遵守站点规则）。
3. 不要伪造搜索结果列表；无法抓取时说明已打开搜索页请用户查看。`
  }
};

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function resolveSource(relPaths) {
  for (const rel of relPaths) {
    const p = path.join(home, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function patchSkillMd(dir, id, displayName) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return;
  let raw = fs.readFileSync(file, 'utf8');
  if (!raw.startsWith('---')) {
    raw = `---\nname: ${displayName}\ndescription: 预装精选技能\ncategory: 预装精选\nskillKey: curated:${id}\n---\n\n${raw}`;
    fs.writeFileSync(file, raw, 'utf8');
    return;
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return;
  const body = raw.slice(m[0].length);
  let meta = m[1];
  meta = meta.replace(/^name:.*$/m, `name: ${displayName}`);
  if (!/^name:/m.test(meta)) meta = `name: ${displayName}\n${meta}`;
  if (!/^category:/m.test(meta)) meta = `${meta.trimEnd()}\ncategory: 预装精选\n`;
  else meta = meta.replace(/^category:.*$/m, 'category: 预装精选');
  meta = meta.replace(/^skillKey:.*$/m, `skillKey: curated:${id}`);
  if (!/^skillKey:/m.test(meta)) meta = `${meta.trimEnd()}\nskillKey: curated:${id}\n`;
  fs.writeFileSync(file, `---\n${meta.trim()}\n---${body}`, 'utf8');
}

function writeStub(id, spec) {
  const dir = path.join(destRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${spec.displayName}\ndescription: 叠云 Agent 预装精选技能\ncategory: 预装精选\nskillKey: curated:${id}\n---\n\n${spec.body}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
}

function main() {
  fs.mkdirSync(destRoot, { recursive: true });
  const report = { copied: [], stubs: [], missing: [] };
  const coreSet = new Set(CORE_CURATED_IDS);
  const items = CURATED.filter((item) => coreSet.has(item.id));

  for (const item of items) {
    const dest = path.join(destRoot, item.id);
    const src = resolveSource(item.relPaths);
    if (!src) {
      report.missing.push(item.id);
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(src, dest);
    patchSkillMd(dest, item.id, item.displayName);
    report.copied.push(item.id);
    console.log('[bundle-curated]', item.id, '<-', src);
  }

  for (const [id, spec] of Object.entries(STUBS)) {
    if (!coreSet.has(id)) continue;
    const dest = path.join(destRoot, id);
    if (fs.existsSync(path.join(dest, 'SKILL.md'))) {
      patchSkillMd(dest, id, spec.displayName);
      report.copied.push(id);
      continue;
    }
    writeStub(id, spec);
    report.stubs.push(id);
    console.log('[bundle-curated] stub', id);
  }

  fs.writeFileSync(
    path.join(destRoot, 'CURATED-MANIFEST.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2),
    'utf8'
  );

  if (report.missing.length) {
    console.warn('[bundle-curated] 未找到本地源（将依赖仓库内已提交副本）:', report.missing.join(', '));
  }
  console.log(
    `[bundle-curated] 完成：复制 ${report.copied.length}，新建 ${report.stubs.length}`
  );
}

main();

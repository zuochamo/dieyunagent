'use strict';

/**
 * 打包内置默认凭据层：把本机 deploy.packaged.json 的 openApi 段
 * 写成 build/deploy-packaged.json，供 electron-builder 的 extraResources 打进安装包。
 *
 * 该文件在运行时由 src/deploy-config.js 作为**最低优先级**文件层读取，
 * 优先级低于 ~/.dieyun/deploy.json 与项目 deploy.local.json（运维仍可覆盖）。
 *
 * 注意：asar / extraResources 都不是加密，安装包内的 key 可被提取。
 * 仅用于内网只读服务、且接受此前提时使用。
 *
 * 用法：
 *   node scripts/pack-deploy-defaults.cjs                 # 仅注入 openApi
 *   node scripts/pack-deploy-defaults.cjs --all           # 注入全部段落
 *   node scripts/pack-deploy-defaults.cjs --in <path>     # 指定源文件
 *   环境变量 DIEYUN_DEPLOY_PACKAGED=<path> 亦可指定源文件
 *
 * 源文件缺失时写出空对象 {} 并告警：不中断构建，也不会把上一次的密钥残留进本次安装包。
 * 源文件存在但不是合法 JSON 时构建失败：避免把坏掉的凭据层发出去。
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const outFile = path.join(repoRoot, 'build', 'deploy-packaged.json');
const DEFAULT_SECTIONS = ['openApi'];

function parseArgs(argv) {
  const out = { input: '', all: false };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--all') out.all = true;
    else if (arg === '--in') out.input = String(list[i + 1] || '').trim();
    else if (arg.startsWith('--in=')) out.input = arg.slice('--in='.length).trim();
  }
  return out;
}

function pickSource(input) {
  const candidates = [];
  if (input) candidates.push(path.resolve(repoRoot, input));
  const envPath = String(process.env.DIEYUN_DEPLOY_PACKAGED || '').trim();
  if (envPath) candidates.push(path.resolve(repoRoot, envPath));
  candidates.push(path.join(repoRoot, 'deploy.packaged.json'));
  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) return file;
    } catch {
      // ignore
    }
  }
  return '';
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`源文件不是合法 JSON：${file}（${err && err.message}）`);
  }
}

/** 只保留需要的段落，避免把 sqlServer 等无关密钥一并打进安装包 */
function pickSections(config, { all }) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (all) return cfg;
  const out = {};
  for (const section of DEFAULT_SECTIONS) {
    if (cfg[section] && typeof cfg[section] === 'object') out[section] = cfg[section];
  }
  return out;
}

function maskKey(value) {
  const text = String(value || '').trim();
  if (!text) return '(空)';
  return `****(len=${text.length})`;
}

function describe(config) {
  const lines = [];
  const openApi = config && config.openApi && typeof config.openApi === 'object' ? config.openApi : {};
  for (const [service, row] of Object.entries(openApi)) {
    if (!row || typeof row !== 'object') continue;
    const url = String(row.url || '').trim();
    const key = row.key || row.apiKey || '';
    lines.push(`  openApi.${service}: url=${url || '(空)'} key=${maskKey(key)}`);
  }
  return lines;
}

function writeOut(payload) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = pickSource(args.input);

  if (!source) {
    writeOut({});
    console.warn(
      '[pack-deploy-defaults] 未找到 deploy.packaged.json，本次安装包不含内置默认凭据。'
    );
    console.warn(
      '[pack-deploy-defaults] 需要内置时：复制 deploy.defaults.example.json 为 deploy.packaged.json 并填入 key（已 gitignore）。'
    );
    return;
  }

  let config;
  try {
    config = readJson(source);
  } catch (err) {
    writeOut({});
    console.error(`[pack-deploy-defaults] ${err && err.message ? err.message : err}`);
    console.error('[pack-deploy-defaults] 已写出空配置，本次安装包不含内置默认凭据。');
    process.exitCode = 1;
    return;
  }

  const picked = pickSections(config, args);
  const sections = Object.keys(picked);
  if (!sections.length) {
    writeOut({});
    console.warn(
      `[pack-deploy-defaults] 源文件 ${source} 未包含可注入段落（${DEFAULT_SECTIONS.join(' / ')}），已写出空配置。`
    );
    return;
  }

  writeOut(picked);
  if (args.all) {
    console.warn(
      '[pack-deploy-defaults] --all：源文件全部段落都会写入安装包（含 sqlServer 等敏感字段），请确认无误。'
    );
  }
  console.log(`[pack-deploy-defaults] 已注入默认凭据层 ← ${path.relative(repoRoot, source) || source}`);
  console.log(`[pack-deploy-defaults] 段落：${sections.join(', ')}`);
  for (const line of describe(picked)) console.log(line);
  console.log(`[pack-deploy-defaults] 输出：${path.relative(repoRoot, outFile)}`);
}

main();

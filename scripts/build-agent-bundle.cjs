'use strict';
/**
 * 把 src/renderer/agent/agent-bundle-entry.js 打包成 src/renderer/dist/agent-bundle.js。
 *
 * 这是 renderer 侧获得 agent 层 API 的唯一途径：index.html 只加载该产物，
 * 不再逐个 <script src="../agent/*.js">。agent 源文件本身保持纯 CJS，供 Main require。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'renderer', 'agent', 'agent-bundle-entry.js');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'dist');
const OUT_FILE = path.join(OUT_DIR, 'agent-bundle.js');

async function buildAgentBundle({ minify = false } = {}) {
  let esbuild = null;
  try {
    esbuild = require('esbuild');
  } catch {
    throw new Error('esbuild not installed; run `npm install` before building the renderer agent bundle');
  }
  if (!fs.existsSync(ENTRY)) throw new Error(`missing entry file: ${ENTRY}`);

  try {
    const result = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: ['chrome120'],
      outfile: OUT_FILE,
      minify,
      sourcemap: minify ? false : 'inline',
      legalComments: 'none',
      logLevel: 'silent'
    });
    for (const w of result.warnings || []) {
      console.warn(`[agent-bundle] warn: ${w.text}`);
    }
  } catch (err) {
    const detail = (err && err.errors ? err.errors : [])
      .map((e) => `  ${e.location ? `${e.location.file}:${e.location.line}` : ''} ${e.text}`)
      .join('\n');
    throw new Error(`esbuild failed for agent-bundle\n${detail || (err && err.message)}`);
  }

  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`[agent-bundle] built src/renderer/dist/agent-bundle.js (${kb} KB, minify=${minify})`);
  return OUT_FILE;
}

module.exports = { buildAgentBundle, ENTRY, OUT_FILE };

if (require.main === module) {
  buildAgentBundle({ minify: process.argv.includes('--minify') }).catch((err) => {
    console.error('[agent-bundle] failed:', err.message || err);
    process.exit(1);
  });
}

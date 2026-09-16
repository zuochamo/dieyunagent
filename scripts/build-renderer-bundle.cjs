'use strict';

const fs = require('fs');
const path = require('path');

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch {
  // optional: without esbuild we still concat sources (unminified)
}

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');
const INDEX = path.join(RENDERER, 'index.html');
const OUT_DIR = path.join(RENDERER, 'dist');
const OUT_BUNDLE = path.join(OUT_DIR, 'bundle.js');
const OUT_MAP = path.join(OUT_DIR, 'bundle.js.map');
const OUT_INDEX = path.join(RENDERER, 'index.bundled.html');

const HEAD_SCRIPTS = new Set([
  './renderer-theme-bootstrap.js',
  '../../node_modules/mermaid/dist/mermaid.min.js',
  '../../node_modules/mammoth/mammoth.browser.min.js',
  '../../node_modules/xlsx/dist/xlsx.full.min.js'
]);

function parseBodyScripts(html) {
  const re = /<script\s+src="([^"]+)"><\/script>/gi;
  const scripts = [];
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (!HEAD_SCRIPTS.has(src)) scripts.push(src);
  }
  return scripts;
}

function resolveScript(src) {
  if (src.startsWith('./')) return path.join(RENDERER, src.slice(2));
  if (src.startsWith('../')) return path.join(ROOT, 'src', src.slice(3));
  throw new Error(`unsupported script src: ${src}`);
}

function generateBundledHtml(html) {
  const parts = html.split('</head>');
  if (parts.length !== 2) throw new Error('index.html: missing </head>');
  let body = parts[1];
  body = body.replace(/\s*<script\s+src="[^"]+"><\/script>\s*/g, '\n');
  const bundleTag = '    <script src="./dist/bundle.js"></script>\n';
  if (!body.includes('</body>')) throw new Error('index.html: missing </body>');
  body = body.replace('</body>', `${bundleTag}  </body>`);
  return `${parts[0]}</head>${body}`;
}

async function main() {
  const wantMinify = process.argv.includes('--minify');
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = parseBodyScripts(html);
  if (!scripts.length) throw new Error('no body scripts found in index.html');

  const chunks = [];
  for (const src of scripts) {
    const file = resolveScript(src);
    if (!fs.existsSync(file)) throw new Error(`missing script file: ${file} (${src})`);
    const code = fs.readFileSync(file, 'utf8');
    chunks.push(`\n;/* === ${src} === */\n${code}\n`);
  }

  const combined = chunks.join('\n');
  let outCode = combined;
  let outMap = null;
  let minify = false;

  if (wantMinify && esbuild) {
    const result = await esbuild.transform(combined, {
      loader: 'js',
      minify: true,
      sourcemap: 'external',
      target: ['chrome120'],
      legalComments: 'none'
    });
    outCode = result.code;
    outMap = result.map || null;
    minify = true;
  } else if (wantMinify && !esbuild) {
    console.warn('[build:renderer] esbuild 未安装，跳过 minify（功能仍完整）; npm i -D esbuild');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_BUNDLE, `${outCode}\n`);
  if (outMap) fs.writeFileSync(OUT_MAP, outMap);
  else if (fs.existsSync(OUT_MAP)) fs.unlinkSync(OUT_MAP);
  fs.writeFileSync(OUT_INDEX, generateBundledHtml(html));

  const { spawnSync } = require('child_process');
  const check = spawnSync(process.execPath, ['--check', OUT_BUNDLE], { encoding: 'utf8' });
  if (check.status !== 0) {
    console.error(check.stdout || check.stderr);
    throw new Error('bundle.js failed node --check');
  }

  const kb = (Buffer.byteLength(outCode, 'utf8') / 1024).toFixed(1);
  console.log(
    `[build:renderer] ${scripts.length} scripts -> src/renderer/dist/bundle.js (${kb} KB, minify=${minify})`
  );
  console.log(`[build:renderer] wrote src/renderer/index.bundled.html`);
}

main().catch((err) => {
  console.error('[build:renderer] failed:', err.message || err);
  process.exit(1);
});

'use strict';

const fs = require('fs');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const root = path.join(__dirname, '..', 'src', 'mobile', 'public');
const htmlPath = path.join(root, 'index.html');
const appPath = path.join(root, 'app.js');
const manifestPath = path.join(root, 'manifest.json');
const cssPath = path.join(root, 'styles.css');

assert(fs.existsSync(htmlPath), 'index.html');
assert(fs.existsSync(appPath), 'app.js');
assert(fs.existsSync(manifestPath), 'manifest.json');

const html = fs.readFileSync(htmlPath, 'utf8');
assert(/id=["']composer["']/.test(html), 'composer');
assert(/id=["']send["']/.test(html), 'send button');
assert(/id=["']messages["']/.test(html), 'messages');
assert(/id=["']think-sheet-body["']/.test(html), 'think-sheet-body scroll container');
assert(/src=["']\.\/app\.js/.test(html), 'loads app.js');
assert(/rel=["']manifest["']/.test(html), 'manifest link');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert(manifest.name, 'manifest.name');
assert(manifest.start_url, 'manifest.start_url');
assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.icons');
for (const icon of manifest.icons) {
  const rel = String(icon.src || '').replace(/^\.\//, '');
  assert(rel, 'icon src');
  assert(fs.existsSync(path.join(root, rel)), `icon file ${rel}`);
}

const appJs = fs.readFileSync(appPath, 'utf8');
assert(/WebSocket/.test(appJs), 'app.js uses WebSocket');
assert(/composer/.test(appJs), 'app.js wires composer');
// 思考区/对话区共用同一套贴底跟随状态，且由滚动事件维护（内容增高不会误判为离开底部）
assert(/bindFollowScrolling\(\)/.test(appJs), 'app.js binds follow-scroll listeners at startup');
assert(/'think-sheet-body'/.test(appJs), 'follow state covers the think sheet');
assert(/scheduleFollowScroll\('traceSheet'\)/.test(appJs), 'trace rendering schedules follow scroll');
assert(/jumpToFollowTail\('traceSheet'\)/.test(appJs), 'opening the think sheet jumps to the newest thought');

// composer：四个按键在同一行并联，每个槽位同一时刻只暴露一个可用动作
assert(/class=["']composer-row["']/.test(html), 'composer single parallel row');
assert(/composer-slot-left[\s\S]{0,400}id=["']voice-toggle["']/.test(html), 'left slot holds the mic key');
assert(/composer-slot-left[\s\S]{0,900}id=["']composer-voice-cancel["']/.test(html), 'left slot holds the cancel key');
assert(/composer-slot-right[\s\S]{0,900}id=["']send["']/.test(html), 'right slot holds the send key');
assert(/composer-slot-right[\s\S]{0,900}id=["']stop["']/.test(html), 'right slot holds the stop key');
assert(/composer-slot-right[\s\S]{0,1400}id=["']composer-voice-confirm["']/.test(html), 'right slot holds the transcribe key');
assert(!/composer-voice-panel/.test(html), 'voice panel no longer stacked above the input');
assert(/id=["']composer-recording["']/.test(html) && /id=["']composer-transcribing["']/.test(html), 'recording/transcribing live inside the input slot');

const css = fs.readFileSync(cssPath, 'utf8');
assert(/\.composer-row\s*\{[\s\S]{0,200}display:\s*flex/.test(css), 'composer row is a flexible parallel line');
assert(/\.composer-action-cancel,[\s\S]{0,80}\.composer-action-stop,[\s\S]{0,80}\.composer-action-confirm\s*\{[\s\S]{0,60}display:\s*none/.test(css), 'secondary actions hidden by default');
assert(/\.composer\.is-running \.composer-action-stop[\s\S]{0,200}display:\s*inline-flex/.test(css), 'running state swaps in the stop key');
assert(/\.composer\.is-recording \.composer-action-confirm[\s\S]{0,400}display:\s*inline-flex/.test(css), 'recording state swaps in the transcribe key');
assert(!/\.composer-voice-panel/.test(css), 'dead voice panel styles removed');

// R 角：尺度集中在 :root，全站不再出现直角
assert(/--radius-xs:\s*8px/.test(css) && /--radius-lg:\s*16px/.test(css) && /--radius-pill:\s*999px/.test(css), 'radius scale declared once in :root');
assert(/button\s*\{[\s\S]{0,60}border-radius:\s*var\(--radius-md\)/.test(css), 'base button uses the radius scale');
assert(!/border-radius:\s*0(px)?\s*;/.test(css), 'no square-corner leftovers');
assert(/\.think-sheet\s*\{[\s\S]{0,400}border-radius:\s*var\(--radius-xl\) var\(--radius-xl\) 0 0/.test(css), 'bottom sheet keeps square feet, rounded head');

console.log('test-mobile-smoke.cjs ok');

'use strict';

/**
 * Renderer CSP 能力探针：把 `src/renderer/index.html` 里的 CSP **原样**套在一个真实
 * Chromium 页面上，验证「收紧之后渲染层仍然能用」。
 *
 * 为什么需要它：CSP 的每个放宽项都是为了让某个库能跑，但没人记得是哪个库、还会不会用到。
 * 猜错的代价是静默坏掉（编辑器打不开、docx 导入失败、图表不渲染），而且只在真机上才看得见。
 * 这里用 Playwright 起真 Chromium 跑一遍：
 *
 *   1. `eval` / `new Function` 必须被拦（若仍放行，说明 'unsafe-eval' 还在 —— 那就是 CRITICAL）；
 *   2. mermaid 渲染出 <svg>（它注入 <style>，需要 style-src 'unsafe-inline'）；
 *   3. xlsx 读写工作簿；
 *   4. mammoth 把一份真 .docx 转成 HTML（它内嵌的 bluebird / lodash 是唯一带 `new Function`
 *      的第三方代码 —— 两者都在 `canEvaluate` / 模板未使用的路径上，CSP 下不走）；
 *   5. 跨目录 file:// 脚本仍能加载（Monaco 从 resources/monaco-editor 加载，不是同目录）；
 *   6. 跨源 fetch 被拦（connect-src 收窄的意义）。
 *
 * 用法：`npm run test:renderer-csp`。缺 Playwright 浏览器时明确跳过而不是假装通过。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

function fail(msg) {
  console.error('✗ ' + msg);
  process.exitCode = 1;
  return false;
}

/** CSP 从 index.html 取，避免测试与产品各写一份（改了产品没改测试才是真事故）。 */
function readCsp() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  // CSP 里含单引号（'self'），所以按**外层引号**配对取，不能写成 [^"']+
  const m =
    html.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"/i) ||
    html.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*content='([^']+)'/i) ||
    html.match(/<meta\s+content="([^"]+)"[^>]*http-equiv=["']Content-Security-Policy["']/i);
  if (!m) throw new Error('index.html 里找不到 CSP meta');
  return m[1].replace(/\s+/g, ' ').trim();
}

function cspDirective(csp, name) {
  const parts = csp.split(';').map((s) => s.trim());
  const hit = parts.find((p) => p.toLowerCase().startsWith(name.toLowerCase() + ' '));
  return hit ? hit.split(/\s+/).slice(1) : null;
}

/** 最小可用的 .docx（jszip 造的），给 mammoth 做真实转换。 */
function buildDocx() {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>csp docx probe</w:t></w:r></w:p>' +
      '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  const csp = readCsp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-csp-'));
  const vendor = (rel) => 'file:///' + path.join(ROOT, 'node_modules', rel).replace(/\\/g, '/');

  // 5) 跨目录脚本：故意放在另一个目录下的一个文件，模拟 Monaco 从 resources/ 加载
  const otherDir = path.join(tmpDir, 'elsewhere');
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'cross-dir.js'), 'window.__CROSS_DIR_OK = true;\n', 'utf8');
  // 探针页：eval / new Function 能不能跑，只能在页内试（CDP 的 evaluate 不受页面 CSP 约束）。
  // 与「正常用法」分两个页面，免得我们**故意**触发的拦截把「加载期有没有被拦」这条判断淹掉。
  const evalProbe = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body>
<script src="./harness.js"></script>
</body></html>`;
  const harness = `
window.__CSP_RESULT = { evalBlocked: null, newFunctionBlocked: null };
try { eval('1+1'); window.__CSP_RESULT.evalBlocked = false; } catch (e) { window.__CSP_RESULT.evalBlocked = true; }
try { new Function('return 1'); window.__CSP_RESULT.newFunctionBlocked = false; } catch (e) { window.__CSP_RESULT.newFunctionBlocked = true; }
`;
  fs.writeFileSync(path.join(tmpDir, 'harness.js'), harness, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'evalprobe.html'), evalProbe, 'utf8');

  const page1 = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body>
<script src="${vendor('mermaid/dist/mermaid.min.js')}"></script>
<script src="${vendor('mammoth/mammoth.browser.min.js')}"></script>
<script src="${vendor('xlsx/dist/xlsx.full.min.js')}"></script>
<script src="file:///${path.join(otherDir, 'cross-dir.js').replace(/\\/g, '/')}"></script>
</body></html>`;
  const pagePath = path.join(tmpDir, 'probe.html');
  fs.writeFileSync(pagePath, page1, 'utf8');

  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    console.log('SKIP test:renderer-csp（未安装 playwright-core）');
    return;
  }

  const docx = await buildDocx();
  let browser;
  const attempts = [];
  // 浏览器来源与 `src/browser/playwright-runner.js` 同一套顺序：先系统 Chromium 系
  // （msedge / chrome），再 Playwright 自带的那份，最后扫 ms-playwright 目录兜底。
  const launchOpts = [
    { headless: true },
    { headless: true, channel: 'msedge' },
    { headless: true, channel: 'chrome' }
  ];
  for (const opts of launchOpts) {
    try {
      browser = await chromium.launch(opts);
      break;
    } catch (err) {
      attempts.push(`${opts.channel || 'bundled'}: ${String(err.message || err).split('\n')[0]}`);
    }
  }
  if (!browser) {
    const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
    const found = [];
    const scan = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(p);
        else if (/^(chrome|chrome-headless-shell)\.exe$/i.test(entry.name)) found.push(p);
      }
    };
    scan(base);
    if (found.length) {
      try {
        browser = await chromium.launch({ headless: true, executablePath: found[0] });
      } catch (err) {
        attempts.push(`executablePath: ${String(err.message || err).split('\n')[0]}`);
      }
    }
    if (!browser) {
      console.log(`SKIP test:renderer-csp（找不到可用浏览器：${attempts.join(' / ')}）`);
      return;
    }
  }

  let ok = true;
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await page.goto('file:///' + pagePath.replace(/\\/g, '/'));
    // 加载期的拦截先记下来：这一阶段页面只做「正常加载三个 vendor 库 + 一个跨目录脚本」，
    // 任何 CSP refused 都意味着收紧把这几个库/加载方式挡坏了。
    const loadRefusals = consoleErrors.filter((t) => /Content Security Policy/i.test(t));

    const res = await page.evaluate(() => ({ crossDir: window.__CROSS_DIR_OK === true }));
    // 1) eval 必须在另一个页面单独验（见 evalprobe.html）
    const probePage = await browser.newPage();
    await probePage.goto('file:///' + path.join(tmpDir, 'evalprobe.html').replace(/\\/g, '/'));
    const probed = await probePage.evaluate(() => window.__CSP_RESULT || {});
    await probePage.close();
    if (probed.evalBlocked !== true) ok = fail(`eval 仍可执行 —— CSP 里还在放 'unsafe-eval'（当前：${csp}）`);
    else console.log('✓ eval 被拦（script-src 不含 unsafe-eval）');
    if (probed.newFunctionBlocked !== true) ok = fail('new Function 仍可执行');
    else console.log('✓ new Function 被拦');
    // 5) 跨目录 file:// 脚本
    if (res.crossDir !== true) ok = fail('跨目录 file:// 脚本加载被拦（Monaco 从 resources/ 加载，会坏）');
    else console.log('✓ 跨目录 file:// 脚本可加载');

    // 2) mermaid
    const mermaidSvg = await page.evaluate(async () => {
      try {
        mermaid.initialize({ startOnLoad: false });
        const { svg } = await mermaid.render('csp-graph', 'graph TD; A-->B');
        return svg && svg.includes('<svg') ? 'ok' : 'no-svg';
      } catch (e) {
        return 'err: ' + (e && e.message);
      }
    });
    if (mermaidSvg !== 'ok') ok = fail(`mermaid 渲染失败：${mermaidSvg}`);
    else console.log('✓ mermaid 渲染出 svg');

    // 3) xlsx
    const xlsxOk = await page.evaluate(() => {
      try {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 1]]), 'S1');
        const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        const back = XLSX.read(buf, { type: 'array' });
        return back.SheetNames.includes('S1') ? 'ok' : 'no-sheet';
      } catch (e) {
        return 'err: ' + (e && e.message);
      }
    });
    if (xlsxOk !== 'ok') ok = fail(`xlsx 读写失败：${xlsxOk}`);
    else console.log('✓ xlsx 读写工作簿');

    // 4) mammoth
    const mammothOut = await page.evaluate(async (b64) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const out = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
        return out && out.value && out.value.includes('csp docx probe') ? 'ok' : 'no-text: ' + (out && out.value);
      } catch (e) {
        return 'err: ' + (e && e.message);
      }
    }, docx.toString('base64'));
    if (mammothOut !== 'ok') ok = fail(`mammoth 转换 docx 失败：${mammothOut}`);
    else console.log('✓ mammoth 转换 docx');

    // 6) 跨源 fetch 必须被拦（connect-src 收窄的验收点）。
    //    必须起一个**真的会应答**的本地服务：否则「连接被拒」和「被 CSP 拦」看起来一样，
    //    测出来的绿灯是假的。服务带 ACAO:*，放行就会成功拿到 body。
    const http = require('http');
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('probe-ok');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const probeUrl = `http://127.0.0.1:${srv.address().port}/probe`;
    const fetchOutcome = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        return 'allowed:' + (await r.text());
      } catch (e) {
        return 'blocked:' + ((e && e.message) || e);
      }
    }, probeUrl);
    await new Promise((r) => srv.close(r));
    if (String(fetchOutcome).startsWith('allowed')) {
      ok = fail(`跨源 fetch 能成功（${fetchOutcome}）—— connect-src 还是 *，收窄没生效`);
    } else {
      console.log('✓ 跨源 fetch 被拦（connect-src 已收窄）');
    }

    // 7) Monaco：真从 node_modules 加载一次编辑器。
    //    它是最容易「收紧后静默打不开」的一块：AMD loader 跨目录加载、worker 用 blob:、
    //    loader.js 里还有两处 `new Function`（能力探测 + 跨源 worker 兜底，CSP 下走不到）。
    //    真加载失败 = 产物编辑面板会空着，所以这条不允许跳过。
    const monacoPage = await browser.newPage();
    const monacoErrors = [];
    monacoPage.on('console', (m) => {
      if (m.type() === 'error') monacoErrors.push(m.text());
    });
    const monacoVs = 'file:///'
      + path.join(ROOT, 'node_modules', 'monaco-editor', 'min', 'vs').replace(/\\/g, '/');
    fs.writeFileSync(
      path.join(tmpDir, 'monaco.html'),
      `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<script src="${monacoVs}/loader.js"></script>
</head><body><div id="host" style="width:400px;height:200px"></div></body></html>`,
      'utf8'
    );
    await monacoPage.goto('file:///' + path.join(tmpDir, 'monaco.html').replace(/\\/g, '/'));
    const monacoOut = await monacoPage.evaluate(
      ({ vsBase }) =>
        new Promise((resolve) => {
          try {
            window.require.config({ paths: { vs: vsBase } });
            window.require(
              ['vs/editor/editor.main'],
              () => {
                try {
                  const host = document.getElementById('host');
                  const editor = window.monaco.editor.create(host, {
                    value: 'const a = 1;',
                    language: 'javascript'
                  });
                  resolve(editor && editor.getModel() ? 'ok' : 'no-model');
                } catch (e) {
                  resolve('create-err: ' + ((e && e.message) || e));
                }
              },
              (e) => resolve('require-err: ' + ((e && e.message) || e))
            );
          } catch (e) {
            resolve('bootstrap-err: ' + ((e && e.message) || e));
          }
        }),
      { vsBase: monacoVs }
    );
    await monacoPage.close();
    if (monacoOut !== 'ok') {
      ok = fail(
        `Monaco 在收紧后的 CSP 下加载/建编辑器失败：${monacoOut}${monacoErrors.length ? ' | ' + monacoErrors.slice(0, 2).join(' | ') : ''}`
      );
    } else {
      console.log('✓ Monaco 能从跨目录 file:// 加载并建编辑器');
    }

    // 8) 网页版（headless --web）用的是**同源 WebSocket**：`ws://<host>/gateway`、`/ws`。
    //    CSP 里 `connect-src 'self'` 是否覆盖 ws: 属细节但一旦不覆盖，网页端会静默连不上
    //    Gateway（面板空白、RPC 全失败）。这里真的起一个 http + ws 服务验一遍。
    const httpMod = require('http');
    const { WebSocketServer } = require('ws');
    const server = httpMod.createServer((req, res) => {
      if (req.url === '/wsprobe.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          window.__WS_OK = null;
          const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
          try {
            const ws = new WebSocket(proto + location.host + '/ws');
            ws.onopen = () => { window.__WS_OK = true; ws.close(); };
            ws.onerror = () => { window.__WS_OK = false; };
          } catch (e) { window.__WS_OK = false; }
        `);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body><script src="/wsprobe.js"></script></body></html>`);
    });
    const wss = new WebSocketServer({ server, path: '/ws' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const webPage = await browser.newPage();
    await webPage.goto(origin + '/');
    await webPage.waitForFunction(() => window.__WS_OK !== null, { timeout: 5000 }).catch(() => {});
    const wsOk = await webPage.evaluate(() => window.__WS_OK);
    await webPage.close();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    if (wsOk !== true) {
      ok = fail("同源 WebSocket 被拦：connect-src 'self' 没覆盖 ws:（网页版会连不上 Gateway）");
    } else {
      console.log('✓ 同源 WebSocket 可用（headless --web 的 /gateway、/ws）');
    }

    // 不该被拦的东西都过了，再看加载期有没有「CSP refused」类噪音
    if (loadRefusals.length) {
      ok = fail(`加载期仍有 CSP 拦截：${loadRefusals.slice(0, 3).join(' | ')}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (!ok) throw new Error('renderer CSP 探针未通过');
  console.log('test-renderer-csp.cjs ok');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});

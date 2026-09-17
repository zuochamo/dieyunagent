'use strict';

/**
 * 手动排障工具：探测某个模型在已配置供应商上的真实上下文窗口。
 * 不接入 npm scripts / CI / smoke 链路，会向配置的 API 发起真实请求。
 *
 * Usage: node scripts/dev/probe-context-window.cjs [modelName]
 * 读取 %APPDATA%/dieyunagent/model-settings.json（可用 DIEYUN_USER_DATA 覆盖）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_DATA =
  process.env.DIEYUN_USER_DATA ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'dieyunagent');
const SETTINGS_FILE = path.join(USER_DATA, 'model-settings.json');

const MODEL = process.argv[2] || 'gpt-5.5';

function loadSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

function resolveEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

function pickSupplier(settings, modelName) {
  for (const s of settings.modelSuppliers || []) {
    if (!s.baseUrl) continue;
    const em = s.enabledModels || {};
    if (!Object.keys(em).length || em[modelName] !== false) {
      return { baseUrl: s.baseUrl, apiKey: s.apiKey || '', supplier: s.name || s.id };
    }
  }
  const custom = (settings.customModels || []).find((m) => m.name === modelName);
  if (custom) return { baseUrl: custom.baseUrl, apiKey: custom.apiKey || '', supplier: 'custom' };
  return {
    baseUrl: settings.builtinBaseUrl || settings.baseUrl,
    apiKey: settings.builtinApiKey || settings.apiKey || '',
    supplier: 'default'
  };
}

function fillerChars(n) {
  // ~3 chars per token heuristic for mixed ASCII padding
  return 'x'.repeat(Math.max(0, n));
}

function isContextError(status, bodyText, json) {
  const blob = `${bodyText || ''} ${JSON.stringify(json || {})}`.toLowerCase();
  if (status === 413) return true;
  return /context|token.*(limit|exceed|maximum|too many|overflow)|max.*tokens|length.*exceed|input.*too long|request too large|content_policy|invalid.*prompt/i.test(
    blob
  );
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function listModels(baseUrl, apiKey) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url = /\/v1$/i.test(root) ? `${root}/models` : `${root}/v1/models`;
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const { res, json } = await fetchJson(url, { method: 'GET', headers });
    if (!res.ok) return { ok: false, status: res.status, url };
    const data = Array.isArray(json?.data) ? json.data : [];
    const hit = data.find((m) => m.id === MODEL || m.id?.endsWith(`/${MODEL}`));
    return { ok: true, url, count: data.length, model: hit || null, ids: data.slice(0, 20).map((m) => m.id) };
  } catch (e) {
    return { ok: false, error: e.message, url };
  }
}

async function probeInputTokens(baseUrl, apiKey, estInputTokens) {
  const url = resolveEndpoint(baseUrl);
  const charLen = Math.floor(estInputTokens * 3.2);
  const userContent = `Repeat marker: BEGIN\n${fillerChars(charLen)}\nEND marker. Reply with exactly: OK`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 8,
    temperature: 0
  };
  const t0 = Date.now();
  const { res, text, json } = await fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const ms = Date.now() - t0;
  const usage = json?.usage || {};
  const ok = res.ok && !json?.error;
  const ctxErr = isContextError(res.status, text, json);
  const content = json?.choices?.[0]?.message?.content || '';
  return {
    estInputTokens,
    charLen,
    status: res.status,
    ok,
    ctxErr,
    ms,
    promptTokens: usage.prompt_tokens,
    totalTokens: usage.total_tokens,
    err: json?.error?.message || json?.error?.code || (ok ? null : text.slice(0, 200)),
    content: String(content).trim().slice(0, 40)
  };
}

async function binarySearchMax(baseUrl, apiKey, lo, hi) {
  let best = lo;
  let lastFail = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    process.stderr.write(`  probe ~${mid} input tokens… `);
    const r = await probeInputTokens(baseUrl, apiKey, mid);
    if (r.ok && !r.ctxErr) {
      process.stderr.write(`ok (prompt=${r.promptTokens ?? '?'})\n`);
      best = mid;
      lo = mid + Math.max(256, Math.floor((hi - mid) / 4));
    } else {
      process.stderr.write(`fail (${r.status}: ${r.err || 'context'})\n`);
      lastFail = r;
      hi = mid - Math.max(256, Math.floor((mid - best) / 4));
    }
  }
  return { best, lastFail };
}

async function main() {
  const settings = loadSettings();
  const { baseUrl, apiKey, supplier } = pickSupplier(settings, MODEL);
  if (!baseUrl) {
    console.error('No baseUrl in model-settings.json');
    process.exit(1);
  }

  console.log('=== Context window probe ===');
  console.log(`Model:     ${MODEL}`);
  console.log(`Supplier:  ${supplier}`);
  console.log(`Base URL:  ${baseUrl}`);
  console.log(`Endpoint:  ${resolveEndpoint(baseUrl)}`);
  console.log('');

  // Sanity: minimal request
  const mini = await probeInputTokens(baseUrl, apiKey, 50);
  console.log('Sanity (50 est. tokens):', mini.ok ? 'OK' : `FAIL ${mini.status} ${mini.err}`);
  if (!mini.ok && !mini.ctxErr) {
    console.error('Basic request failed — check URL/key/model name.');
    process.exit(2);
  }
  console.log('');

  const modelsInfo = await listModels(baseUrl, apiKey);
  if (modelsInfo.ok) {
    console.log(`Models API: ${modelsInfo.url} (${modelsInfo.count} models)`);
    if (modelsInfo.model) {
      console.log('Model metadata:', JSON.stringify(modelsInfo.model, null, 2));
    } else {
      console.log('Sample ids:', modelsInfo.ids.join(', '));
    }
  } else {
    console.log('Models API: unavailable', modelsInfo.error || modelsInfo.status || '');
  }
  console.log('');

  // Spot checks at common tiers (estimated input tokens)
  const spots = [2000, 4000, 6000, 8000, 12000, 16000, 24000, 32000, 48000, 64000, 96000, 128000];
  console.log('Spot checks (estimated input tokens → result):');
  let lastOk = 0;
  let firstFail = null;
  for (const t of spots) {
    const r = await probeInputTokens(baseUrl, apiKey, t);
    const label = r.ok && !r.ctxErr ? 'OK' : 'FAIL';
    console.log(
      `  ~${String(t).padStart(6)} → ${label}  status=${r.status}  prompt_tokens=${r.promptTokens ?? '-'}  ${r.err ? `err=${String(r.err).slice(0, 80)}` : ''}`
    );
    if (r.ok && !r.ctxErr) lastOk = Math.max(lastOk, r.promptTokens || t);
    else if (!firstFail) firstFail = r;
    if (!r.ok || r.ctxErr) break; // stop escalating after first failure to save time
  }
  console.log('');

  if (lastOk > 0 && firstFail) {
    const lo = Math.max(500, lastOk - 2000);
    const hi = firstFail.promptTokens || firstFail.estInputTokens;
    console.log(`Binary search between ~${lo} and ~${hi} prompt tokens…`);
    const { best, lastFail } = await binarySearchMax(baseUrl, apiKey, lo, hi);
    console.log('');
    console.log('=== Result ===');
    console.log(`Last successful spot: ~${lastOk} prompt tokens (API-reported where available)`);
    console.log(`Refined upper bound:  ~${best} estimated input tokens`);
    if (lastFail) {
      console.log(`First failure hint:   ${lastFail.err || lastFail.status}`);
    }
    const tier =
      best >= 1500000
        ? 'ctx-2m'
        : best >= 700000
          ? 'ctx-1m'
          : best >= 400000
            ? 'ctx-512k'
            : best >= 160000
              ? 'ctx-200k'
              : best >= 100000
                ? 'ctx-128k'
                : best >= 60000
                  ? 'ctx-64k'
                  : best >= 28000
                    ? 'ctx-32k'
                    : 'ctx-16k';
    console.log(`Suggested app tier:   ${tier}`);
  } else if (lastOk > 0 && !firstFail) {
    console.log('=== Result ===');
    console.log(`All spot checks passed up to ~${lastOk}. Relay likely supports 128k+ or no strict limit enforced.`);
    console.log('Suggested app tier: ctx-128k, ctx-200k or ctx-1m (verify with real agent workload)');
  } else {
    console.log('=== Result ===');
    console.log('Could not determine context window — even small requests may fail or limits are very low.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

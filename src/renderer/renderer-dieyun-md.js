/* global $, gatewayCall, getComposerAgentMode, CTX_LIMITS */
'use strict';

const dieyunApi = window.diecloud || {};

const DIEYUN_MD_INJECT_MODE_KEY = 'dieyun.dieyunMd.injectMode';

/** 从用户查询动态抽词元，用于与章节正文打分（非固定意图词表） */
function extractDieyunQueryTokens(text) {
  const raw = String(text || '').toLowerCase();
  const tokens = raw.match(/[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_-]{2,}|[a-z0-9_]{3,}/gi) || [];
  return [...new Set(tokens)].slice(0, 48);
}

function getDieyunMdInjectMode() {
  try {
    const v = window.localStorage.getItem(DIEYUN_MD_INJECT_MODE_KEY);
    if (v === 'auto' || v === 'always' || v === 'manual') return v;
  } catch {
    // ignore
  }
  return 'auto';
}

function setDieyunMdInjectMode(mode) {
  try {
    window.localStorage.setItem(
      DIEYUN_MD_INJECT_MODE_KEY,
      mode === 'always' || mode === 'manual' ? mode : 'auto'
    );
  } catch {
    // ignore
  }
}

function userMentionedDieyunMd(userQuery) {
  return /@dieyun(?:\.md)?/i.test(String(userQuery || ''));
}

function shouldInjectDieyunMd(userQuery) {
  if (userMentionedDieyunMd(userQuery)) return true;
  const mode = getDieyunMdInjectMode();
  if (mode === 'always') return true;
  if (mode === 'manual') return false;
  return !!String(userQuery || '').trim();
}

function splitDieyunMdSections(content) {
  const text = String(content || '');
  const sections = [];
  let title = '';
  let body = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (title || body.length) sections.push({ title, body: body.join('\n').trim() });
      title = m[1].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  if (title || body.length) sections.push({ title, body: body.join('\n').trim() });
  return sections.filter((s) => s.title || s.body);
}

function pickDieyunMdSections(sections, userQuery) {
  if (!sections.length) return [];
  const tokens = extractDieyunQueryTokens(userQuery);
  if (!tokens.length) return [];
  const scored = sections
    .map((sec) => {
      const blob = `${sec.title}\n${sec.body}`.toLowerCase();
      const score = tokens.reduce((n, tok) => n + (blob.includes(tok) ? 1 : 0), 0);
      return { sec, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map((x) => x.sec);
}

function trimDieyunMdForInject(content, userQuery) {
  const raw = String(content || '').trim();
  if (!raw) return '';
  if (userMentionedDieyunMd(userQuery) || getDieyunMdInjectMode() === 'always') return raw;
  if (getDieyunMdInjectMode() === 'manual') return raw;
  const sections = splitDieyunMdSections(raw);
  if (!sections.length) return '';
  const picked = pickDieyunMdSections(sections, userQuery);
  if (!picked.length) return '';
  return picked.map((s) => (s.title ? `## ${s.title}\n\n${s.body}` : s.body)).join('\n\n').trim();
}

function formatDieyunMdInjectBlock(body) {
  const text = String(body || '').trim();
  if (!text) return '';
  const max = (CTX_LIMITS && CTX_LIMITS.DIEYUN_MD_MAX) || 6000;
  const capped = text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
  const mode = getDieyunMdInjectMode();
  const modeHint =
    mode === 'auto'
      ? '（自动注入：与本轮任务相关的条目）'
      : mode === 'manual'
        ? '（手动 @dieyun.md 注入）'
        : '';
  return (
    `【全局用户规则 · dieyun.md】${modeHint}\n` +
    '跨项目个人偏好；与 AGENTS.md 并存，与用户本轮输入冲突时以用户输入为准。\n\n' +
    capped
  );
}

async function buildDieyunMdSystemBlock(userQuery) {
  if (!shouldInjectDieyunMd(userQuery)) return '';
  if (!dieyunApi.getDieyunMd) return '';
  try {
    const d = await dieyunApi.getDieyunMd();
    if (!d || !d.exists || !d.content) return '';
    const body = trimDieyunMdForInject(d.content, userQuery);
    if (!body) return '';
    return formatDieyunMdInjectBlock(body);
  } catch {
    return '';
  }
}

function setDieyunMdSettingsHint(text) {
  const el = $('dieyun-md-settings-hint');
  if (!el) return;
  el.textContent = text || '';
  if (text) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }
}

async function openDieyunMdInEditorUi() {
  let filePath = '';
  if (dieyunApi.getDieyunMd) {
    const d = await dieyunApi.getDieyunMd();
    filePath = (d && d.path) || '';
  }
  if (dieyunApi.openDieyunMd) {
    try {
      return await dieyunApi.openDieyunMd();
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (!/No handler registered/i.test(msg)) throw err;
    }
  }
  if (!filePath) throw new Error('无法获取 dieyun.md 路径');
  if (typeof gatewayCall !== 'function') {
    throw new Error('请完全退出叠云 Agent 后重新启动');
  }
  const cmd = `cmd /c start "" ${JSON.stringify(filePath)}`;
  const result = await gatewayCall('host.exec', { command: cmd, timeoutMs: 15000 });
  if (result && result.code !== 0 && result.code != null) {
    throw new Error(result.stderr || `打开失败 (code ${result.code})`);
  }
  return { ok: true, path: filePath };
}

function syncDieyunMdInjectModeTabs(mode) {
  document.querySelectorAll('.dieyun-md-inject-tab').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function initDieyunMdSettingsUI() {
  const openBtn = $('dieyun-md-open');
  const pathEl = $('dieyun-md-path');
  const injectTabs = document.querySelectorAll('.dieyun-md-inject-tab');

  if (pathEl && dieyunApi.getDieyunMd) {
    dieyunApi
      .getDieyunMd()
      .then((d) => {
        if (d && d.path) pathEl.textContent = d.path;
      })
      .catch(() => {
        pathEl.textContent = '~/.dieyun/dieyun.md';
      });
  }

  if (injectTabs.length) {
    syncDieyunMdInjectModeTabs(getDieyunMdInjectMode());
    injectTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode || mode === getDieyunMdInjectMode()) return;
        setDieyunMdInjectMode(mode);
        syncDieyunMdInjectModeTabs(mode);
        setDieyunMdSettingsHint('注入模式已保存');
      });
    });
  }

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      openDieyunMdInEditorUi()
        .then((r) => {
          if (r && r.path && pathEl) pathEl.textContent = r.path;
          setDieyunMdSettingsHint('已在编辑器中打开');
        })
        .catch((err) => setDieyunMdSettingsHint(`打开失败：${err.message || err}`));
    });
  }
}

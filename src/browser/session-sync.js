'use strict';

const { session } = require('electron');

const BROWSER_SESSION_PARTITION = 'persist:dieyun-browser';

function sanitizeSessionPartitionId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function browserPartitionForSession(sessionId) {
  return sessionId
    ? `persist:dieyun-browser-${sanitizeSessionPartitionId(sessionId)}`
    : BROWSER_SESSION_PARTITION;
}

function electronBrowserSession(sessionId) {
  return session.fromPartition(browserPartitionForSession(sessionId));
}

function mapSameSiteForPlaywright(sameSite) {
  const s = String(sameSite || '').toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'strict') return 'Strict';
  return 'Lax';
}

/**
 * @param {{ url?: string, sessionId?: string }} [opts]
 */
async function exportCookiesForPlaywright(opts = {}) {
  const ses = electronBrowserSession(opts.sessionId);
  const filter = opts.url ? { url: String(opts.url) } : {};
  /** @type {import('electron').Cookie[]} */
  let cookies = [];
  try {
    cookies = await ses.cookies.get(filter);
  } catch {
    return [];
  }
  const out = [];
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const row = {
      name: c.name,
      value: c.value != null ? String(c.value) : '',
      domain: c.domain || '',
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: mapSameSiteForPlaywright(c.sameSite)
    };
    if (c.expirationDate && c.expirationDate > 0) {
      row.expires = Math.floor(c.expirationDate);
    }
    if (!row.domain && !row.url) continue;
    out.push(row);
  }
  return out;
}

/**
 * @param {import('playwright-core').BrowserContext} context
 * @param {{ url?: string, sessionId?: string, log?: (msg: string) => void }} [opts]
 */
async function syncElectronCookiesToPlaywrightContext(context, opts = {}) {
  const log = opts.log || (() => {});
  if (!context) return { synced: 0, skipped: true };
  const cookies = await exportCookiesForPlaywright({ url: opts.url, sessionId: opts.sessionId });
  if (!cookies.length) return { synced: 0 };
  try {
    await context.addCookies(cookies);
    return { synced: cookies.length };
  } catch (e) {
    const valid = [];
    for (const c of cookies) {
      try {
        await context.addCookies([c]);
        valid.push(c);
      } catch {
        // skip invalid cookie rows
      }
    }
    if (valid.length < cookies.length) {
      log(`browser session-sync: ${valid.length}/${cookies.length} cookies applied`);
    }
    return { synced: valid.length, partial: valid.length < cookies.length };
  }
}

function mapSameSiteForElectron(sameSite) {
  const s = String(sameSite || '').toLowerCase();
  if (s === 'none' || s === 'no_restriction') return 'no_restriction';
  if (s === 'strict') return 'strict';
  return 'lax';
}

function cookieSetUrl(row) {
  if (row.url) return String(row.url);
  const domain = String(row.domain || '').replace(/^\./, '');
  if (!domain) return '';
  const path = row.path || '/';
  const proto = row.secure ? 'https' : 'http';
  return `${proto}://${domain}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * @param {Array<Record<string, unknown>>} cookies
 * @param {{ sessionId?: string }} [opts]
 */
async function importCookiesToElectron(cookies, opts = {}) {
  const ses = electronBrowserSession(opts?.sessionId);
  let applied = 0;
  let failed = 0;
  for (const raw of cookies || []) {
    if (!raw || !raw.name) continue;
    const url = cookieSetUrl(raw);
    if (!url) {
      failed += 1;
      continue;
    }
    /** @type {import('electron').CookiesSetDetails} */
    const details = {
      url,
      name: String(raw.name),
      value: raw.value != null ? String(raw.value) : '',
      path: raw.path ? String(raw.path) : '/',
      secure: !!raw.secure,
      httpOnly: !!raw.httpOnly,
      sameSite: mapSameSiteForElectron(raw.sameSite)
    };
    if (raw.domain) details.domain = String(raw.domain);
    const exp = raw.expirationDate ?? raw.expires;
    if (exp && Number(exp) > 0) details.expirationDate = Number(exp);
    try {
      await ses.cookies.set(details);
      applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { applied, failed, total: (cookies || []).length };
}

/**
 * 删除指定 Cookie（每项需含 name，以及 url 或 domain 用于定位来源）。
 * @param {Array<Record<string, unknown>>} targets
 * @param {{ sessionId?: string }} [opts]
 */
async function removeCookiesFromElectron(targets, opts = {}) {
  const ses = electronBrowserSession(opts?.sessionId);
  let removed = 0;
  let failed = 0;
  for (const raw of targets || []) {
    if (!raw || !raw.name) {
      failed += 1;
      continue;
    }
    const url = cookieSetUrl(raw);
    if (!url) {
      failed += 1;
      continue;
    }
    try {
      await ses.cookies.remove(url, String(raw.name));
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed, total: (targets || []).length };
}

module.exports = {
  BROWSER_SESSION_PARTITION,
  browserPartitionForSession,
  sanitizeSessionPartitionId,
  electronBrowserSession,
  exportCookiesForPlaywright,
  syncElectronCookiesToPlaywrightContext,
  importCookiesToElectron,
  removeCookiesFromElectron
};

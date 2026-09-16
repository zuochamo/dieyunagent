'use strict';

const { buildA11yDomScanScript } = require('./snapshot-script');

function readAxValue(field) {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  if (typeof field.value === 'string') return field.value;
  if (field.value != null) return String(field.value);
  return '';
}

/**
 * Flatten CDP Accessibility.getFullAXTree nodes for agent consumption.
 * @param {Array<object>} nodes
 * @param {number} maxNodes
 */
function simplifyCdpAxNodes(nodes, maxNodes = 200) {
  const out = [];
  for (const n of nodes || []) {
    if (!n || n.ignored) continue;
    const role = readAxValue(n.role).trim();
    const name = readAxValue(n.name).trim();
    const value = readAxValue(n.value).trim();
    const description = readAxValue(n.description).trim();
    if (!role && !name && !value) continue;
    const props = Array.isArray(n.properties) ? n.properties : [];
    const states = {};
    for (const p of props) {
      const key = p && p.name ? String(p.name) : '';
      if (!key) continue;
      const pv = p.value && p.value.value != null ? p.value.value : p.value;
      if (pv === true || pv === false || typeof pv === 'string' || typeof pv === 'number') {
        states[key] = pv;
      }
    }
    out.push({
      role: role.slice(0, 80),
      name: name.slice(0, 200),
      value: value.slice(0, 120),
      description: description.slice(0, 120),
      states: Object.keys(states).length ? states : undefined
    });
    if (out.length >= maxNodes) break;
  }
  return out;
}

async function fetchAxTreeViaCdp(sendCommand, { maxNodes = 200 } = {}) {
  await sendCommand('Accessibility.enable');
  const result = await sendCommand('Accessibility.getFullAXTree');
  const nodes = simplifyCdpAxNodes(result?.nodes || [], maxNodes);
  return {
    source: 'cdp',
    nodes,
    count: nodes.length
  };
}

/**
 * @param {import('electron').WebContents} wc
 */
async function a11ySnapshotBrowserView(wc, opts = {}, evaluateDom) {
  const maxNodes = Math.min(400, Math.max(20, Number(opts.maxNodes) || 200));
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attached = true;
    }
    const data = await fetchAxTreeViaCdp((cmd, params) => wc.debugger.sendCommand(cmd, params), { maxNodes });
    return { ok: true, engine: 'browserview', ...data };
  } catch (e) {
    if (typeof evaluateDom === 'function') {
      const dom = await evaluateDom(maxNodes);
      return {
        ok: true,
        engine: 'browserview',
        source: 'dom',
        fallbackReason: e && e.message ? e.message : String(e),
        ...dom
      };
    }
    throw e;
  } finally {
    if (attached && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * @param {import('playwright-core').Page} page
 */
async function a11ySnapshotPlaywright(page, opts = {}) {
  const maxNodes = Math.min(400, Math.max(20, Number(opts.maxNodes) || 200));
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    const data = await fetchAxTreeViaCdp((cmd, params) => client.send(cmd, params), { maxNodes });
    return { ok: true, engine: 'playwright', ...data };
  } catch (e) {
    const dom = await page.evaluate(buildA11yDomScanScript({ maxNodes }));
    return {
      ok: true,
      engine: 'playwright',
      source: 'dom',
      fallbackReason: e && e.message ? e.message : String(e),
      ...dom
    };
  } finally {
    if (client) {
      try {
        await client.detach();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = {
  simplifyCdpAxNodes,
  a11ySnapshotBrowserView,
  a11ySnapshotPlaywright
};

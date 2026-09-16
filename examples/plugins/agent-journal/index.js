'use strict';

const fs = require('fs');
const path = require('path');

function activate(ctx) {
  const logPath = path.join(ctx.installPath, 'agent-journal.log');

  function appendLine(line) {
    const cfg = ctx.readConfig();
    if (cfg.enabled === false) return { skipped: true };
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${line}\n`;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, entry, 'utf8');
    const maxKb = Math.max(64, Math.min(4096, Number(cfg.maxFileKb) || 512));
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > maxKb * 1024) {
        const buf = fs.readFileSync(logPath, 'utf8');
        const keep = buf.slice(-Math.floor(maxKb * 512));
        fs.writeFileSync(logPath, keep, 'utf8');
      }
    } catch {
      // ignore
    }
    return { ok: true };
  }

  function readRecent(limit) {
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    if (!fs.existsSync(logPath)) return { entries: [], count: 0 };
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    return { entries: lines.slice(-lim), count: lines.length };
  }

  return {
    handleTool(name, args) {
      if (name !== 'read_recent') throw new Error(`未知工具: ${name}`);
      return readRecent(args && args.limit);
    },
    onAgentTurnEnd(event) {
      const summary = (event && event.summary) || '';
      const sid = (event && event.sessionId) || '';
      const ok = !!(event && event.ok);
      const line = `session=${sid} ok=${ok} ${summary}`.trim();
      return appendLine(line);
    }
  };
}

module.exports = { activate };

'use strict';

const fs = require('fs');
const path = require('path');

function checkpointsDir(dieyunHome) {
  const dir = path.join(dieyunHome, 'agent-checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveCheckpoint(dieyunHome, runId, data) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('缺少 runId');
  const file = path.join(checkpointsDir(dieyunHome), `${id}.json`);
  const payload = {
    runId: id,
    updatedAt: Date.now(),
    ...data
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, path: file };
}

function loadCheckpoint(dieyunHome, runId) {
  const id = String(runId || '').trim();
  const file = path.join(checkpointsDir(dieyunHome), `${id}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: 'not_found' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function deleteCheckpoint(dieyunHome, runId) {
  const id = String(runId || '').trim();
  const file = path.join(checkpointsDir(dieyunHome), `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { ok: true };
}

function listCheckpoints(dieyunHome, limit = 20) {
  const dir = checkpointsDir(dieyunHome);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        data = null;
      }
      return {
        runId: f.replace(/\.json$/, ''),
        updatedAt: st.mtimeMs,
        sessionId: data?.sessionId || null,
        planSummary: data?.planSummary || '',
        status: data?.status || 'unknown',
        subagentId: data?.lastSubagentId || null
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return { ok: true, items: files };
}

module.exports = {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  listCheckpoints
};

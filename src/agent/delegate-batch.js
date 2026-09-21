'use strict';

const path = require('path');
const { isMutatingAgentTool } = require('./tool-classify');
const { isAbortError, throwIfAborted, raceAbortable } = require('../llm-reconnect-retry');
const { FILE_PATH_KEYED_WRITE_TOOL_NAMES } = require('./guardrails-shared');

function mutationFileKey(d) {
  const name = String((d && d.name) || '');
  if (!FILE_PATH_KEYED_WRITE_TOOL_NAMES.has(name)) return null;
  const a = (d && d.arguments) || {};
  const p = a.filePath || a.path || a.file || a.filename;
  if (!p || !String(p).trim()) return `__missing_${d && d.id != null ? d.id : 'file'}`;
  return path.normalize(String(p)).replace(/\\/g, '/').toLowerCase();
}

function runFileMutationGroups(items, runOne, onPhase, runId, signal) {
  const queues = new Map();
  for (const d of items) {
    const key = mutationFileKey(d);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(d);
  }
  onPhase('delegate_file_parallel', {
    runId,
    files: queues.size,
    count: items.length,
    names: items.map((d) => d.name)
  });
  const chains = [];
  for (const group of queues.values()) {
    chains.push(
      (async () => {
        const rows = [];
        for (const d of group) {
          throwIfAborted(signal);
          rows.push(await runOne(d));
        }
        return rows;
      })()
    );
  }
  return Promise.all(chains).then((batches) => batches.flat());
}

/**
 * 只读并行；连续的 fs_edit/fs_write_file 按文件排队、跨文件并行；其余写操作串行。
 * @param {Array<{ id: string, name: string, arguments?: object }>} delegates
 * @param {(name: string, args: object) => Promise<object>} delegateTool
 * @param {(phase: string, data: object) => void} [onPhase]
 * @param {string} [runId]
 * @param {{ aborted?: boolean }} [signal]
 */
async function executeDelegateBatch(delegates, delegateTool, onPhase = () => {}, runId = '', signal = null) {
  const list = Array.isArray(delegates) ? delegates : [];
  const resultsById = new Map();

  async function runOne(d) {
    try {
      throwIfAborted(signal);
      const result = await raceAbortable(delegateTool(d.name, d.arguments || {}), signal);
      throwIfAborted(signal);
      const row = { id: d.id, result };
      onPhase('delegate_result', {
        runId,
        id: d.id,
        name: d.name,
        arguments: d.arguments || {},
        result
      });
      return row;
    } catch (e) {
      if (isAbortError(e)) throw e;
      const error = e && e.message ? e.message : String(e);
      const row = { id: d.id, result: {}, error };
      onPhase('delegate_result', {
        runId,
        id: d.id,
        name: d.name,
        arguments: d.arguments || {},
        error
      });
      return row;
    }
  }

  const readOnly = list.filter((d) => !isMutatingAgentTool(d.name));
  const mutating = list.filter((d) => isMutatingAgentTool(d.name));

  throwIfAborted(signal);
  if (readOnly.length) {
    onPhase('delegate_parallel', { runId, count: readOnly.length, names: readOnly.map((d) => d.name) });
    const batch = await Promise.all(readOnly.map((d) => runOne(d)));
    for (const row of batch) resultsById.set(row.id, row);
  }

  let fileRun = [];
  async function flushFileRun() {
    if (!fileRun.length) return;
    const rows = await runFileMutationGroups(fileRun, runOne, onPhase, runId, signal);
    for (const row of rows) resultsById.set(row.id, row);
    fileRun = [];
  }

  for (const d of mutating) {
    throwIfAborted(signal);
    if (mutationFileKey(d)) {
      fileRun.push(d);
      continue;
    }
    await flushFileRun();
    resultsById.set(d.id, await runOne(d));
  }
  await flushFileRun();

  return list.map((d) => resultsById.get(d.id)).filter(Boolean);
}

module.exports = {
  executeDelegateBatch,
  isMutatingAgentTool
};

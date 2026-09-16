'use strict';

const { executeDelegateBatch, isMutatingAgentTool } = require('../src/agent/delegate-batch');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function main() {
  const order = [];
  const delegateTool = async (name, args) => {
    order.push(name);
    await new Promise((r) => setTimeout(r, name === 'fs_read_file' ? 30 : 5));
    return { ok: true, name, args };
  };

  const delegates = [
    { id: '1', name: 'fs_read_file', arguments: { path: 'a' } },
    { id: '2', name: 'fs_list_dir', arguments: { dirPath: 'src' } },
    { id: '3', name: 'host_exec', arguments: { command: 'echo hi' } },
    { id: '4', name: 'web_search', arguments: { query: 'x' } }
  ];

  assert(isMutatingAgentTool('host_exec'), 'host_exec mutating');
  assert(isMutatingAgentTool('browser_click'), 'browser_click mutating');
  assert(!isMutatingAgentTool('fs_read_file'), 'read not mutating');

  const phases = [];
  const results = await executeDelegateBatch(delegates, delegateTool, (p, d) => {
    phases.push({ p, ...d });
  }, 'run-1');

  assert(results.length === 4, 'four results');
  assert(results.every((r) => r.id && r.result?.ok), 'all ok');

  assert(order[order.length - 1] === 'host_exec', 'mutating runs last');
  assert(order.filter((n) => n !== 'host_exec').length === 3, 'three read-only');

  assert(phases.some((x) => x.p === 'delegate_parallel' && x.count === 3), 'parallel phase for 3 read-only');

  const fileOrder = [];
  const started = [];
  const fileDelegate = async (name, args) => {
    started.push(args.filePath);
    const delay = args.filePath === 'b.js' ? 20 : 5;
    await new Promise((r) => setTimeout(r, delay));
    fileOrder.push(args.filePath);
    return { ok: true };
  };
  const fileResults = await executeDelegateBatch(
    [
      { id: 'a1', name: 'fs_edit', arguments: { filePath: 'a.js', oldString: '1', newString: '2' } },
      { id: 'b1', name: 'fs_write_file', arguments: { filePath: 'b.js', content: 'x' } },
      { id: 'a2', name: 'fs_edit', arguments: { filePath: 'a.js', oldString: '2', newString: '3' } },
      { id: 'e1', name: 'host_exec', arguments: { command: 'echo' } }
    ],
    fileDelegate,
    () => {},
    'run-2'
  );
  assert(fileResults.length === 4, 'file batch four results');
  const a1 = fileOrder.indexOf('a.js');
  const a2 = fileOrder.lastIndexOf('a.js');
  const b = fileOrder.indexOf('b.js');
  assert(a1 >= 0 && a2 > a1, 'same file serial');
  assert(b >= 0, 'other file ran');
  assert(started.includes('b.js') && started.includes('a.js'), 'both files started');

  console.log('ok delegate-batch tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

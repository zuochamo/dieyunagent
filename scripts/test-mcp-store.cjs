'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMcpStore } = require('../src/mcp/store');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-store-'));
const store = createMcpStore({
  safeStorage: {
    isEncryptionAvailable: () => false
  }
});

async function main() {
  const listed = store.addMcpServer(tmp, {
    id: 'custom-echo',
    name: 'Echo',
    description: 'test',
    command: 'npx',
    args: ['-y', 'demo-mcp']
  });
  assert(listed.some((s) => s.id === 'custom-echo' && s.builtin === false), 'custom listed');

  let threw = false;
  try {
    store.addMcpServer(tmp, { id: 'custom-echo', name: 'Dup', command: 'npx' });
  } catch (e) {
    threw = /已存在/.test(e.message);
  }
  assert(threw, 'duplicate id rejected');

  const cfg = store.getMcpServerConfigForUi(tmp, 'custom-echo');
  assert(cfg.command === 'npx', 'config command');
  assert(cfg.packageName === 'demo-mcp' || cfg.args.includes('demo-mcp'), 'npm meta from args');

  const afterDelete = store.deleteMcpServer(tmp, 'custom-echo');
  assert(!afterDelete.some((s) => s.id === 'custom-echo'), 'deleted custom');

  const repair = await store.repairMcpEnvironment(tmp, { repairKind: 'npm-cache-busy' });
  assert(repair.ok === false, 'unsupported repair');

  console.log('test-mcp-store.cjs ok');
}

const empty = store.loadMcpStore(tmp);
assert(empty.custom.length === 0, 'empty custom');

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

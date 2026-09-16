'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const keyPath = path.join(os.homedir(), '.ssh', 'id_ed25519_dieyunagent');
const pubPath = `${keyPath}.pub`;

function run(args, opts = {}) {
  return spawnSync('ssh-keygen', args, {
    stdio: opts.inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeoutMs || 10000,
    input: opts.input
  });
}

function isEncryptedPrivateKey(filePath) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 6).join('\n');
    return /bcrypt|aes\d+-/.test(head);
  } catch {
    return false;
  }
}

function verifyNoPassphrase() {
  const tries = ['', '""'];
  for (const pass of tries) {
    const r = run(['-y', '-f', keyPath, '-P', pass], { timeoutMs: 5000 });
    if (r.status === 0 && r.stdout && r.stdout.includes('ssh-')) return true;
  }
  return false;
}

function generateKey() {
  for (const f of [keyPath, pubPath]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
  const r = run(
    ['-t', 'ed25519', '-f', keyPath, '-N', '', '-m', 'PEM', '-C', 'dieyunagent-linux-build', '-q'],
    { inherit: true, timeoutMs: 30000 }
  );
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

if (!fs.existsSync(keyPath)) {
  console.log('[dieyun-ssh-key] generating key:', keyPath);
  generateKey();
} else if (!verifyNoPassphrase()) {
  console.log('[dieyun-ssh-key] replacing key (passphrase mismatch or encrypted):', keyPath);
  generateKey();
}

if (!fs.existsSync(pubPath)) {
  console.error('[dieyun-ssh-key] missing public key:', pubPath);
  process.exit(1);
}

if (!verifyNoPassphrase()) {
  console.error('[dieyun-ssh-key] key still not usable without passphrase');
  process.exit(1);
}

console.log('[dieyun-ssh-key] OK (no passphrase):', pubPath);

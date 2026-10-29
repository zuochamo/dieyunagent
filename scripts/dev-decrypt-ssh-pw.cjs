'use strict';
/**
 * 开发用：把应用里存的那条 SSH 密码交给真机验收脚本。
 *
 * 存的是 Electron `safeStorage`（Chromium OSCrypt v10 / AES-GCM，密钥由 DPAPI 保护），
 * 所以**必须**在 Electron 里解、且 userData 指向应用自己的目录（`Local State` 里那把 key）。
 * 裸 node + DPAPI 解不出来。
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe scripts/dev-decrypt-ssh-pw.cjs "host:port:user" [输出文件]
 *
 * 默认输出 `%TEMP%\dy_ssh_pw`（0600 由 ACL 兜着；用完删掉）。
 * 只打印长度，不打印内容。
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APPDIR = path.join(process.env.APPDATA || '', 'dieyunagent');
const TARGET = process.argv[2] || '';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'dy_ssh_pw');

app.setPath('userData', APPDIR);
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  try {
    if (!TARGET) throw new Error('用法: dev-decrypt-ssh-pw.cjs "host:port:user" [out]');
    const store = JSON.parse(fs.readFileSync(path.join(APPDIR, 'ssh-profiles.json'), 'utf8'));
    const row = store[TARGET];
    if (!row) {
      throw new Error(`找不到 profile: ${TARGET}（现有 key: ${Object.keys(store).join(', ')}）`);
    }
    if (!row.secretEnc) throw new Error(`profile ${TARGET} 没有存密码（remember=false 或用了密钥认证）`);
    const plain = safeStorage.decryptString(Buffer.from(row.secretEnc, 'base64'));
    fs.writeFileSync(OUT, plain, { mode: 0o600 });
    console.log(`DECRYPT_OK len=${plain.length} → ${OUT}`);
  } catch (e) {
    console.log(`DECRYPT_FAIL ${e && e.message}`);
  }
  app.exit(0);
});

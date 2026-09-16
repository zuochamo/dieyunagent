#!/usr/bin/env node
/**
 * 将 electron-builder 在 dist/ 中生成的 generic 更新相关文件复制到 updates-published/。
 * 复制规则：latest*.yml、*.exe、*.blockmap、*.7z（与 NSIS/blockmap 相关），以及手机端 APK 更新文件。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'updates-published');
const mobileDist = path.join(dist, 'mobile');

const patterns = [/\.yml$/i, /\.yaml$/i, /\.exe$/i, /\.blockmap$/i, /\.7z$/i, /\.apk$/i];

function shouldCopy(name) {
  if (name === 'builder-debug.yml' || name === 'builder-effective-config.yaml') return false;
  if (/^dieyunagent-portable-/i.test(name)) return false;
  return patterns.some((re) => re.test(name));
}

function main() {
  if (!fs.existsSync(dist)) {
    console.error('[sync-updates] 缺少 dist/，请先 npm run build:nsis 或 npm run build');
    process.exit(1);
  }
  fs.mkdirSync(out, { recursive: true });
  const names = fs.readdirSync(dist);
  let n = 0;
  for (const name of names) {
    if (!shouldCopy(name)) continue;
    const src = path.join(dist, name);
    const st = fs.statSync(src);
    if (!st.isFile()) continue;
    fs.copyFileSync(src, path.join(out, name));
    console.log('[sync-updates]', name);
    n++;
  }
  if (fs.existsSync(mobileDist)) {
    for (const name of fs.readdirSync(mobileDist)) {
      if (name !== 'mobile-latest.json' && !/\.apk$/i.test(name)) continue;
      const src = path.join(mobileDist, name);
      const st = fs.statSync(src);
      if (!st.isFile()) continue;
      fs.copyFileSync(src, path.join(out, name));
      console.log('[sync-updates]', `mobile/${name}`);
      n++;
    }
  }
  if (n === 0) {
    console.warn('[sync-updates] dist/ 中未找到 yml/exe/blockmap/7z；请确认已成功打包 NSIS。');
  } else {
    console.log('[sync-updates] 已复制', n, '个文件到', out);
    const published = fs.readdirSync(out);
    const hasYml = published.some((name) => /^latest.*\.yml$/i.test(name));
    if (!hasYml) {
      console.warn(
        '[sync-updates] 未包含 latest.yml；electron-updater 需要它。请在 Windows 上成功执行 npm run build:nsis 后再执行本脚本。'
      );
    }
  }
  const optionalSrc = path.join(dist, 'optional');
  if (fs.existsSync(optionalSrc)) {
    const optionalOut = path.join(out, 'optional');
    fs.mkdirSync(optionalOut, { recursive: true });
    for (const name of fs.readdirSync(optionalSrc)) {
      const srcFile = path.join(optionalSrc, name);
      if (!fs.statSync(srcFile).isFile()) continue;
      fs.copyFileSync(srcFile, path.join(optionalOut, name));
      console.log('[sync-updates]', `optional/${name}`);
    }
  }
}

main();

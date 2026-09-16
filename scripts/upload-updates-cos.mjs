#!/usr/bin/env node
/**
 * Upload dist/ update artifacts to Tencent COS, then delete previous
 * versioned Setup.exe / blockmap / APK objects (keep latest.yml, *-latest.exe, optional/).
 * Env: COS_SECRET_ID, COS_SECRET_KEY, optional COS_BUCKET, COS_REGION
 * COS_KEEP_OLD=1 skips stale cleanup. COS_PC_ONLY skips APK upload and APK cleanup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import COS from 'cos-nodejs-sdk-v5';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { getBuildDistRoot } = require('./build-dist-root.cjs');
const src = getBuildDistRoot();
const mobileSrc = path.join(src, 'mobile');

const secretId = process.env.COS_SECRET_ID;
const secretKey = process.env.COS_SECRET_KEY;
const bucket = process.env.COS_BUCKET || 'dieyunagent-updates-1440856872';
const region = process.env.COS_REGION || 'ap-shanghai';

if (!secretId || !secretKey) {
  console.error('[cos] Missing COS_SECRET_ID or COS_SECRET_KEY');
  process.exit(1);
}

const latestYml = path.join(src, 'latest.yml');
if (!fs.existsSync(latestYml)) {
  console.error('[cos] Missing dist/latest.yml — run: npm run build:nsis');
  process.exit(1);
}

const verLine = fs.readFileSync(latestYml, 'utf8').split(/\r?\n/).find((l) => /^\s*version:\s*/.test(l));
const ver = verLine ? verLine.split(':').slice(1).join(':').trim() : '';
if (!ver) {
  console.error('[cos] Cannot read version from latest.yml');
  process.exit(1);
}

const exePath = path.join(src, `dieyunagent-Setup-${ver}.exe`);
const mapPath = path.join(src, `dieyunagent-Setup-${ver}.exe.blockmap`);

/** @type {{ local: string, key: string }[]} */
const uploads = [
  { local: exePath, key: path.basename(exePath) },
  { local: mapPath, key: path.basename(mapPath) },
  { local: latestYml, key: 'latest.yml' },
  { local: exePath, key: 'dieyunagent-Setup-latest.exe' }
];

const mobileManifest = path.join(mobileSrc, 'mobile-latest.json');
if (!process.env.COS_PC_ONLY && fs.existsSync(mobileManifest)) {
  uploads.push({ local: mobileManifest, key: 'mobile-latest.json' });
  for (const name of fs.readdirSync(mobileSrc)) {
    if (/^dieyun-mobile-.*\.apk$/i.test(name)) {
      uploads.push({ local: path.join(mobileSrc, name), key: name });
    }
  }
}

const optionalDir = path.join(src, 'optional');
if (fs.existsSync(optionalDir)) {
  for (const name of fs.readdirSync(optionalDir)) {
    const local = path.join(optionalDir, name);
    if (!fs.statSync(local).isFile()) continue;
    uploads.push({ local, key: `optional/${name}` });
  }
}

for (const { local } of uploads) {
  if (!fs.existsSync(local)) {
    console.error('[cos] Missing', local);
    process.exit(1);
  }
}

const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

function cosCall(method, params) {
  return new Promise((resolve, reject) => {
    cos[method](params, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function putObject(localPath, key) {
  const objectKey = key || path.basename(localPath);
  const stat = fs.statSync(localPath);
  return cosCall('putObject', {
    Bucket: bucket,
    Region: region,
    Key: objectKey,
    Body: fs.createReadStream(localPath),
    ContentLength: stat.size,
    ACL: 'public-read',
  });
}

/** Versioned installer / APK keys; aliases like dieyunagent-Setup-latest.exe are kept via `keep`. */
const STALE_KEY_RE = /^(dieyunagent-Setup-.+\.exe(\.blockmap)?|dieyun-mobile-.+\.apk)$/i;

async function listKeys(prefix) {
  const keys = [];
  let marker = '';
  for (;;) {
    const data = await cosCall('getBucket', {
      Bucket: bucket,
      Region: region,
      Prefix: prefix,
      Marker: marker,
      MaxKeys: 1000,
    });
    for (const item of data.Contents || []) {
      if (item.Key) keys.push(item.Key);
    }
    const truncated = data.IsTruncated === true || data.IsTruncated === 'true';
    if (!truncated) break;
    marker = data.NextMarker || keys[keys.length - 1];
    if (!marker) break;
  }
  return keys;
}

/**
 * After a successful upload, drop previous Setup.exe / blockmap / APK objects.
 * Keeps latest.yml, *-latest.exe, optional/, icons, and keys just uploaded.
 * Set COS_KEEP_OLD=1 to skip. COS_PC_ONLY skips APK cleanup.
 */
async function deleteStaleVersionedObjects(keepKeys) {
  if (process.env.COS_KEEP_OLD) {
    console.log('[cos] Skip stale cleanup (COS_KEEP_OLD)');
    return;
  }
  const prefixes = ['dieyunagent-Setup-'];
  if (!process.env.COS_PC_ONLY) prefixes.push('dieyun-mobile-');

  const stale = [];
  for (const prefix of prefixes) {
    for (const key of await listKeys(prefix)) {
      if (keepKeys.has(key) || !STALE_KEY_RE.test(key)) continue;
      stale.push(key);
    }
  }
  if (!stale.length) {
    console.log('[cos] No stale versioned objects');
    return;
  }

  console.log(`[cos] Delete ${stale.length} previous version object(s)`);
  const batchSize = 1000;
  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize);
    for (const key of batch) console.log(`  - ${key}`);
    await cosCall('deleteMultipleObject', {
      Bucket: bucket,
      Region: region,
      Objects: batch.map((Key) => ({ Key })),
      Quiet: true,
    });
  }
}

console.log(`[cos] Upload v${ver} to cos://${bucket}/ (${region})`);
for (let i = 0; i < uploads.length; i++) {
  const { local, key } = uploads[i];
  process.stdout.write(`  [${i + 1}/${uploads.length}] ${key} ... `);
  await putObject(local, key);
  console.log('OK');
}

await deleteStaleVersionedObjects(new Set(uploads.map((u) => u.key)));

console.log(`[cos] Done: https://${bucket}.cos.${region}.myqcloud.com/`);
console.log(`[cos] Website download: https://${bucket}.cos.${region}.myqcloud.com/dieyunagent-Setup-latest.exe`);

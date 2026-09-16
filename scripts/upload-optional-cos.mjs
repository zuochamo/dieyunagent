#!/usr/bin/env node
/**
 * Upload dist/optional/ (BGE zip + Monaco zip + Linux Node tarball) to Tencent COS.
 * Env: COS_SECRET_ID, COS_SECRET_KEY, optional COS_BUCKET, COS_REGION
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import COS from 'cos-nodejs-sdk-v5';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const optionalDir = path.join(__dirname, '..', 'dist', 'optional');

const secretId = process.env.COS_SECRET_ID;
const secretKey = process.env.COS_SECRET_KEY;
const bucket = process.env.COS_BUCKET || 'dieyunagent-updates-1440856872';
const region = process.env.COS_REGION || 'ap-shanghai';

if (!secretId || !secretKey) {
  console.error('[cos] Missing COS_SECRET_ID or COS_SECRET_KEY');
  process.exit(1);
}

if (!fs.existsSync(optionalDir)) {
  console.error('[cos] Missing dist/optional — run: npm run pack:optional-assets');
  process.exit(1);
}

const files = fs.readdirSync(optionalDir).filter((name) => {
  const local = path.join(optionalDir, name);
  return fs.statSync(local).isFile();
});

if (!files.length) {
  console.error('[cos] dist/optional is empty — run: npm run pack:optional-assets');
  process.exit(1);
}

const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

function putObject(localPath, key) {
  const stat = fs.statSync(localPath);
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: bucket,
        Region: region,
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentLength: stat.size,
        ACL: 'public-read'
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data);
      }
    );
  });
}

console.log(`[cos] Upload optional assets to cos://${bucket}/optional/ (${region})`);
for (let i = 0; i < files.length; i++) {
  const name = files[i];
  const local = path.join(optionalDir, name);
  const key = `optional/${name}`;
  const mb = (fs.statSync(local).size / (1024 * 1024)).toFixed(1);
  process.stdout.write(`  [${i + 1}/${files.length}] ${key} (${mb} MB) ... `);
  await putObject(local, key);
  console.log('OK');
}

const base = `https://${bucket}.cos.${region}.myqcloud.com/optional/`;
console.log('[cos] Done. Public URLs:');
for (const name of files) {
  console.log(`  ${base}${name}`);
}

#!/usr/bin/env node
/**
 * 本机静态「升级文件」服务：托管 latest.yml、NSIS 安装包、blockmap 等，供 electron-updater generic 使用。
 *
 * 用法：
 *   1) npm run sync:updates   （把 dist 里本次构建产物拷到 updates-published/）
 *   2) npm run serve:updates  （在本机起 HTTP，默认端口 3099）
 *
 * Windows 客户端设置环境变量 UPDATE_URL 为本机地址，例如：
 *   http://192.168.1.100:3099/
 * （末尾建议带 /，与 generic 目录根一致）
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.UPDATES_ROOT
  ? path.resolve(process.env.UPDATES_ROOT)
  : path.resolve(__dirname, '..', 'updates-published');
fs.mkdirSync(ROOT, { recursive: true });
const PORT = Number(process.env.UPDATES_PORT || process.env.PORT || 3099);
const HOST = process.env.UPDATES_HOST || '0.0.0.0';

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.7z': 'application/x-7z-compressed',
  '.blockmap': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8'
};

function localIPv4s() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const e of nets[name] || []) {
      if (e.family === 'IPv4' && !e.internal) out.push(e.address);
    }
  }
  return out;
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const rel = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = path.join(root, rel);
  if (!abs.startsWith(root)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  let urlPath = req.url || '/';
  if (urlPath === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let body = '<!doctype html><meta charset="utf-8"><title>updates</title><pre>';
    try {
      const files = fs.readdirSync(ROOT).filter((n) => !n.startsWith('.'));
      body += files.length ? files.join('\n') : '(目录为空，请先 npm run sync:updates)';
    } catch (e) {
      body += String(e.message);
    }
    body += '</pre>';
    res.writeHead(200);
    res.end(body);
    return;
  }
  const abs = safeJoin(ROOT, urlPath);
  if (!abs) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(err && err.code === 'ENOENT' ? 404 : 403);
      res.end(err && err.code === 'ENOENT' ? 'Not found' : 'Forbidden');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', st.size);
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': st.size });
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  const ips = localIPv4s();
  console.log('[update-static-server] 目录:', ROOT);
  console.log('[update-static-server] 监听:', `http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}/`);
  if (ips.length) {
    console.log('[update-static-server] 局域网内 Windows 可把 UPDATE_URL 设为（示例）:');
    for (const ip of ips) {
      console.log(`    http://${ip}:${PORT}/`);
    }
  } else {
    console.log('[update-static-server] 未检测到非公网 IPv4；本机可试: http://127.0.0.1:' + PORT + '/');
  }
});

server.on('error', (err) => {
  console.error('[update-static-server] 启动失败:', err && err.message ? err.message : err);
  process.exit(1);
});

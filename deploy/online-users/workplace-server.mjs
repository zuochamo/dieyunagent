#!/usr/bin/env node
/**
 * 叠云 Agent 工位监控服务（内网 LAN，Socket.IO 实时）
 * 客户端 SERVER_URL 指向本服务。
 */
import http from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

const PORT = Number(process.env.PORT || process.env.ONLINE_USERS_PORT || 3003);
const HOST = process.env.HOST || '0.0.0.0';
const OFFLINE_MS = Number(process.env.OFFLINE_MS || 35000);
const GEO_CACHE_TTL_MS = Number(process.env.GEO_CACHE_TTL_MS || 6 * 3600 * 1000);

/** @type {Map<string, object>} */
const clients = new Map();
/** @type {Map<string, { data: object, at: number }>} */
const geoCache = new Map();

const PROVINCE_COORDS = {
  北京: [116.4074, 39.9042],
  天津: [117.201, 39.0842],
  上海: [121.4737, 31.2304],
  重庆: [106.5516, 29.563],
  河北: [114.5149, 38.0428],
  山西: [112.5489, 37.8706],
  辽宁: [123.4315, 41.8057],
  吉林: [125.3235, 43.8171],
  黑龙江: [126.642, 45.756],
  江苏: [118.7969, 32.0603],
  浙江: [120.1551, 30.2741],
  安徽: [117.2272, 31.8206],
  福建: [119.2965, 26.0745],
  江西: [115.8581, 28.6832],
  山东: [117.0208, 36.6683],
  河南: [113.6254, 34.7466],
  湖北: [114.3055, 30.5928],
  湖南: [112.9388, 28.2282],
  广东: [113.2644, 23.1291],
  海南: [110.3492, 20.0174],
  四川: [104.0665, 30.5728],
  贵州: [106.6302, 26.647],
  云南: [102.8329, 24.8801],
  陕西: [108.9398, 34.3416],
  甘肃: [103.8343, 36.0611],
  青海: [101.7782, 36.6171],
  台湾: [121.5091, 25.0443],
  内蒙古: [111.6708, 40.8183],
  广西: [108.3275, 22.815],
  西藏: [91.1172, 29.6469],
  宁夏: [106.2309, 38.4872],
  新疆: [87.6168, 43.8256],
  香港: [114.1694, 22.3193],
  澳门: [113.5439, 22.1987]
};

function isPrivateIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return true;
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function normalizeProvince(name) {
  if (!name) return '未知';
  let s = String(name).trim();
  s = s.replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区)$/u, '');
  if (s.startsWith('内蒙古')) return '内蒙古';
  if (s.startsWith('黑龙江')) return '黑龙江';
  return s || '未知';
}

function coordsForProvince(province) {
  const key = normalizeProvince(province);
  const base = PROVINCE_COORDS[key];
  if (!base) return [104.0665, 30.5728];
  const jitter = () => (Math.random() - 0.5) * 0.6;
  return [base[0] + jitter(), base[1] + jitter()];
}

async function fetchGeo(ip) {
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) return cached.data;

  if (isPrivateIp(ip)) {
    const data = {
      country: '中国',
      province: '内网',
      city: '局域网',
      lng: 116.4074,
      lat: 39.9042,
      source: 'private'
    };
    geoCache.set(ip, { data, at: Date.now() });
    return data;
  }

  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,lat,lon`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const json = await res.json();
    if (json.status === 'success') {
      const province = normalizeProvince(json.regionName || '未知');
      const lng = Number(json.lon);
      const lat = Number(json.lat);
      const data = {
        country: json.country || '',
        province,
        city: json.city || province,
        lng: Number.isFinite(lng) ? lng : coordsForProvince(province)[0],
        lat: Number.isFinite(lat) ? lat : coordsForProvince(province)[1],
        source: 'ip-api'
      };
      geoCache.set(ip, { data, at: Date.now() });
      return data;
    }
  } catch {
    // fallback
  }

  const data = {
    country: '中国',
    province: '未知',
    city: '未知',
    lng: 104.0665,
    lat: 30.5728,
    source: 'fallback'
  };
  geoCache.set(ip, { data, at: Date.now() });
  return data;
}

function clientKey(payload) {
  return String(payload.computerId || payload.hostname || payload.mac || '').trim();
}

function geoIpForClient(client) {
  const pub = String(client.publicIp || '').trim();
  if (pub && !isPrivateIp(pub)) return pub;
  return String(client.clientIp || '').trim();
}

function mergeClient(existing, payload, socketId) {
  const key = clientKey(payload);
  if (!key) return null;
  const now = Date.now();
  const ip = String(payload.clientIp || existing?.clientIp || '').trim();
  const publicIp = String(payload.publicIp || existing?.publicIp || '').trim();
  const base = existing || { id: key, firstSeen: now, geo: null };
  return {
    ...base,
    id: key,
    socketId,
    computerId: payload.computerId || key,
    hostname: payload.hostname || base.hostname || key,
    mac: payload.mac || base.mac || '',
    clientIp: ip || base.clientIp || '',
    publicIp: publicIp || base.publicIp || '',
    cpu: Number(payload.cpu ?? base.cpu ?? 0),
    memory: Number(payload.memory ?? base.memory ?? 0),
    uptime: Number(payload.uptime ?? base.uptime ?? 0),
    keystrokesToday: Number(payload.keystrokesToday ?? payload.keystrokes ?? base.keystrokesToday ?? 0),
    mouseClicksToday: Number(payload.mouseClicksToday ?? payload.mouseClicks ?? base.mouseClicksToday ?? 0),
    clientVersion: payload.clientVersion || base.clientVersion || '',
    tokensToday: Number(payload.tokensToday ?? base.tokensToday ?? 0),
    lastSeen: now,
    online: true
  };
}

async function enrichGeo(client) {
  const geoIp = geoIpForClient(client);
  if (!geoIp) {
    client.geo = { province: '未知', city: '未知', lng: 104.0665, lat: 30.5728 };
    return client;
  }
  if (client.geo && client.geo.ip === geoIp) return client;
  const geo = await fetchGeo(geoIp);
  client.geo = { ...geo, ip: geoIp };
  return client;
}

function pruneOffline() {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > OFFLINE_MS) clients.delete(id);
  }
}

function listOnlineUsers() {
  pruneOffline();
  return [...clients.values()]
    .filter((c) => c.online !== false)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((c) => ({
      id: c.id,
      computerId: c.computerId,
      hostname: c.hostname,
      mac: c.mac,
      clientIp: c.clientIp,
      publicIp: c.publicIp || '',
      cpu: c.cpu,
      memory: c.memory,
      uptime: c.uptime,
      keystrokesToday: c.keystrokesToday,
      mouseClicksToday: c.mouseClicksToday,
      clientVersion: c.clientVersion,
      tokensToday: c.tokensToday,
      province: c.geo?.province || '未知',
      city: c.geo?.city || '未知',
      lng: c.geo?.lng ?? 104.0665,
      lat: c.geo?.lat ?? 30.5728,
      lastSeen: c.lastSeen,
      online: true
    }));
}

function broadcastUsers(io) {
  const users = listOnlineUsers();
  io.emit('users:update', {
    users,
    total: users.length,
    at: Date.now()
  });
}

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT, mode: 'workplace-monitor', online: listOnlineUsers().length });
});

app.get('/api/users/online', (_req, res) => {
  res.json({ users: listOnlineUsers(), total: listOnlineUsers().length, at: Date.now() });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000
});

io.on('connection', (socket) => {
  const isDashboard = socket.handshake.query.role === 'dashboard';

  if (isDashboard) {
    socket.emit('users:update', {
      users: listOnlineUsers(),
      total: listOnlineUsers().length,
      at: Date.now()
    });
    return;
  }

  async function upsert(payload) {
    const key = clientKey(payload);
    if (!key) return;
    let merged = mergeClient(clients.get(key), payload, socket.id);
    if (!merged) return;
    merged = await enrichGeo(merged);
    clients.set(key, merged);
    broadcastUsers(io);
  }

  socket.on('register', (payload) => {
    void upsert(payload || {});
  });

  socket.on('status-update', (payload) => {
    void upsert(payload || {});
  });

  socket.on('disconnect', () => {
    for (const [id, c] of clients) {
      if (c.socketId === socket.id) {
        c.lastSeen = Date.now();
      }
    }
    setTimeout(() => broadcastUsers(io), 500);
  });
});

setInterval(() => broadcastUsers(io), 10000);

server.listen(PORT, HOST, () => {
  console.log(`[workplace-monitor] http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log('[workplace-monitor] Socket.IO register / status-update · GET /api/users/online');
});

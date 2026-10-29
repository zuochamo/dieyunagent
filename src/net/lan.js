'use strict';

// @ts-check
/**
 * 局域网地址枚举（**唯一来源**）。
 *
 * 手机桥（`src/mobile/bridge.js`）与内网 peer 互通（`src/peer/`）都要回答同一个问题：
 * 「这台机器在内网里应该让对端用哪个地址找我」。两处各写一份必然漂移（评分规则、保留段、
 * 虚拟网卡过滤只要有一处忘了改，就会出现「手机上打得开、同事连不上」这种互相矛盾的现网故障），
 * 所以判定与排序只在这里做，其它模块只消费 `lanAddresses()` / `lanHosts()`。
 *
 * 约束：
 * - 纯函数 + `os.networkInterfaces()`，不做 DNS、不发起探测；
 * - 返回顺序即优先级（评分高在前），调用方不要自己再排一遍。
 */

const os = require('os');

/**
 * @param {string} address
 * @returns {number[] | null}
 */
function ipv4Parts(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

/** 保留 / 不可路由 / 不应对外宣告的 IPv4 段。 */
function isReservedIpv4(parts) {
  const [a, b, c] = parts;
  if (a === 0 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/**
 * 打分：RFC1918 私网 > CGNAT > 其它；名字像物理网卡的加分，像虚拟网卡的减分。
 * 分数只用于排序，不代表「可用」——可用性由调用方的连接结果决定。
 */
function ipv4Score(parts, ifName) {
  const [a, b] = parts;
  let score = 10;
  if (a === 192 && b === 168) score = 100;
  else if (a === 10) score = 90;
  else if (a === 172 && b >= 16 && b <= 31) score = 80;
  else if (a === 100 && b >= 64 && b <= 127) score = 20;

  const name = String(ifName || '').toLowerCase();
  if (/wi-?fi|wlan|wireless|以太网|ethernet/.test(name)) score += 10;
  if (/virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|zerotier|clash|tun|tap|vpn/.test(name)) score -= 50;
  return score;
}

/**
 * 有序局域网地址列表（去重、评分降序）。
 * @returns {{ address: string, score: number }[]}
 */
function lanAddresses() {
  const candidates = [];
  const nets = os.networkInterfaces();
  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos || []) {
      if (!info || info.internal || info.family !== 'IPv4') continue;
      const parts = ipv4Parts(info.address);
      if (!parts || isReservedIpv4(parts)) continue;
      candidates.push({
        address: info.address,
        score: ipv4Score(parts, name)
      });
    }
  }
  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address, 'en', { numeric: true }))
    .filter((item) => {
      if (seen.has(item.address)) return false;
      seen.add(item.address);
      return true;
    });
}

/**
 * 有序局域网 IPv4 地址。
 * @returns {string[]}
 */
function lanHosts() {
  return lanAddresses().map((item) => item.address);
}

/**
 * 每个网卡所在子网的定向广播地址（用于 UDP 发现）。
 *
 * 为什么需要它：`255.255.255.255` 在部分交换机 / 无线控制器上被丢弃，而按子网广播
 * （`192.168.31.255`）几乎总能到达。两者都发，代价只是几个数据报。
 *
 * @returns {string[]}
 */
function subnetBroadcastAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [, infos] of Object.entries(nets)) {
    for (const info of infos || []) {
      if (!info || info.internal || info.family !== 'IPv4') continue;
      const parts = ipv4Parts(info.address);
      if (!parts || isReservedIpv4(parts)) continue;
      const prefixRaw = typeof info.cidr === 'string' ? Number(String(info.cidr).split('/')[1]) : NaN;
      const prefix = Number.isInteger(prefixRaw) && prefixRaw >= 0 && prefixRaw <= 32 ? prefixRaw : 24;
      // /31、/32 没有广播语义
      if (32 - prefix < 2) continue;
      const ip =
        ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
      const hostMask = (~0 << (32 - prefix)) >>> 0;
      const broadcast = (ip | (~hostMask >>> 0)) >>> 0;
      out.push([24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 255).join('.'));
    }
  }
  return [...new Set(out)];
}

module.exports = {
  ipv4Parts,
  isReservedIpv4,
  ipv4Score,
  lanAddresses,
  lanHosts,
  subnetBroadcastAddresses
};

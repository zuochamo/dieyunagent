'use strict';

/**
 * 技能包完整性基线：**安装时**记下 SKILL.md 的 sha256，**扫描时**比对。
 *
 * 为什么需要：SKILL.md 是**会被当作指令执行**的文本，而技能市场（skills.sh）下载链路
 * 没有任何签名或校验和 —— 下载成功即落盘。MCP 预装产物在构建期强制校 sha256
 * （scripts/pack-mcp-bundled.cjs，「校验不过一律不产出」），技能侧此前连
 * 「装完之后有没有被改过」都无从判断：出了怪行为分不清「技能本身有问题」和「本地被改过」。
 *
 * 边界（刻意不做的事）：
 * - 不阻止执行，也不假装置信：只把「与安装时不一致」标出来，让模型与用户都能看见。
 * - 不覆盖手写技能：`skill_create` 创建的是用户自己的文件，没有基线，state = 'untracked'。
 * - 不建中央索引：基线跟着技能目录走（`.dieyun-install.json`），删技能即自动消失，
 *   不会留下需要 GC 的孤儿条目。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const INSTALL_MARKER = '.dieyun-install.json';

/** @param {string} text */
function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** @param {string} skillDir */
function markerPath(skillDir) {
  return path.join(skillDir, INSTALL_MARKER);
}

/**
 * 读安装基线。扫描路径每轮都会走，因此保持 async —— 不要为了少写一个 await
 * 把它换成同步读，那会把 N 个技能的磁盘等待塞进主进程的帧内执行。
 *
 * @param {string} skillDir
 * @returns {Promise<{ source?: string, sha256?: string, installedAt?: number, files?: number } | null>}
 */
async function readInstallMarker(skillDir) {
  try {
    const data = JSON.parse(await fsp.readFile(markerPath(skillDir), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 写入安装基线。由安装方（skills/catalog.js）在文件落盘后调用。
 * @param {string} skillDir
 * @param {{ source?: string, sha256: string, files?: number }} info
 */
function writeInstallMarker(skillDir, info) {
  const payload = {
    version: 1,
    source: String(info.source || ''),
    sha256: String(info.sha256 || ''),
    installedAt: Date.now(),
    files: Number(info.files) || 0
  };
  fs.writeFileSync(markerPath(skillDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/**
 * 比对当前 SKILL.md 与安装基线。
 *
 * @param {string} skillDir
 * @param {string} rawSkillMd 已读到的 SKILL.md 原文（调用方本来就要读，避免二次 IO）
 * @returns {Promise<{ state: 'ok'|'changed'|'untracked', source: string, installedAt: number }>}
 */
async function verifySkillContent(skillDir, rawSkillMd) {
  const marker = await readInstallMarker(skillDir);
  if (!marker || !marker.sha256) {
    return { state: 'untracked', source: '', installedAt: 0 };
  }
  const actual = sha256Text(rawSkillMd);
  return {
    state: actual === marker.sha256 ? 'ok' : 'changed',
    source: String(marker.source || ''),
    installedAt: Number(marker.installedAt) || 0
  };
}

module.exports = {
  markerPath,
  sha256Text,
  writeInstallMarker,
  verifySkillContent
};

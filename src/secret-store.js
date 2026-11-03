'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./fs-atomic');

/**
 * 「密文凭据 JSON」的**唯一实现**：safeStorage 加解密 + 0600 落盘 + 读失败策略 + 损坏态。
 *
 * 仓库里有三份几乎逐字相同的拷贝（`channels/store.js`、`mcp/credentials-store.js`、
 * `ssh/credentials-store.js` 各一份 `canEncrypt` / `encryptSecret` / `decryptSecret`）。
 * 漂移已经发生过：三份里只有 channels 与 ssh 按 0600 落盘，MCP 的
 * `mcp-secrets.json` 是 umask 默认权限 —— 谁登录过、配了哪些 token 对同机其他用户可见。
 * 这类「同一件事三处各写一遍」的代价不是行数，而是**安全属性只能靠人记得每处都补**。
 *
 * 三处真正不同的只有**读失败策略**，因此它作为显式参数，而不是隐式默认：
 * - `'empty'`：解析不了就当空（MCP / SSH —— 读取在 Agent 轮内高频命中，抛错会打断工具调用）；
 * - `'throw'`：抛错并带上调用方给的 code（频道配置 —— 静默当空会让下一次保存覆盖掉
 *   用户所有频道与会话映射）。
 *
 * 但 `'empty'` 不等于「什么都不发生」：文件坏了这件事会被记下来（`getHealth()`），
 * **并且落一个旁路标记文件**（`<凭据文件>.corrupt.json`，见 `readFlag` 处注释），
 * 且此后本实例拒绝写入（`SECRET_STORE_CORRUPT`）—— 否则「读到空 + 保存一次」
 * 就会把用户其余条目静默抹掉，正是频道配置当初那个 bug 的形态。要恢复必须显式
 * `resetCorruptFile()`（把坏文件改名备份后重建），这对应设置页的「文件损坏，请重新填写」。
 * 标记落盘的意义是：重启后不必先「读到坏文件」才知道文件坏了，保存入口天然就是堵住的。
 *
 * 加密不可用时**一律抛** `CREDENTIALS_ENCRYPT_UNAVAILABLE`，不回退明文：三处调用点都在
 * 保存前先 `canEncrypt()` 预检，所以正常路径不受影响；真被调用到就说明有个分支漏了预检，
 * 这时抛错比静默存空更像它。
 */

const ENCRYPT_UNAVAILABLE_CODE = 'CREDENTIALS_ENCRYPT_UNAVAILABLE';
const CORRUPT_CODE = 'SECRET_STORE_CORRUPT';

/**
 * @param {{
 *   userDataPath: string,
 *   fileName: string,
 *   safeStorage?: import('electron').SafeStorage,
 *   log?: (msg: string) => void,
 *   label?: string,
 *   encryptUnavailableMessage?: string,
 *   onCorrupt?: 'empty' | 'throw',
 *   corruptCode?: string,
 * }} opts
 */
function createSecretStore(opts) {
  const userDataPath = String(opts.userDataPath || '');
  const filePath = path.join(userDataPath, opts.fileName);
  const label = String(opts.label || opts.fileName);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onCorrupt = opts.onCorrupt === 'throw' ? 'throw' : 'empty';
  /** 最近一次读到的损坏信息（null = 文件正常或不存在） */
  let corrupt = null;
  /** 损坏标记的旁路文件：让「这个文件坏了」跨进程 / 跨重启仍然成立 */
  const flagPath = `${filePath}.corrupt.json`;
  /** 本实例是否与标记文件打过交道（正常路径上因此不必每次都去 unlink） */
  let flagSeen = false;

  function canEncrypt() {
    const ss = opts.safeStorage;
    return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());
  }

  /** 空串原样返回；不能加密时抛错（不回退明文）。 */
  function encryptSecret(text) {
    const s = String(text || '');
    if (!s) return '';
    const ss = opts.safeStorage;
    if (!canEncrypt() || !ss) {
      const e = new Error(
        opts.encryptUnavailableMessage || `当前系统无法加密存储凭据（${label}）`
      );
      e.code = ENCRYPT_UNAVAILABLE_CODE;
      throw e;
    }
    return ss.encryptString(s).toString('base64');
  }

  /** 解不开就返回空串（调用方据此判断「已配置但不可用」），并在给了 log 时记一条。 */
  function decryptSecret(enc) {
    if (!enc) return '';
    const ss = opts.safeStorage;
    if (!canEncrypt() || !ss) return '';
    try {
      return ss.decryptString(Buffer.from(String(enc), 'base64'));
    } catch (e) {
      log(`[${label}] 密文无法解密（safeStorage 密钥与写入时不一致）：${(e && e.message) || e}`);
      return '';
    }
  }

  /**
   * 损坏标记的旁路文件（`<凭据文件>.corrupt.json`）。
   *
   * 为什么需要它：损坏态原本只活在本实例内存里，重启后要等**第一次读到坏文件**才重新成立。
   * 只要重启后先发生的是「保存」（懒加载的列表、脚本调用、将来某个新入口），闸门就晚了一拍 ——
   * 而晚一拍正好等于把用户其余条目覆盖掉。标记落盘后，「这个文件坏了」就是启动时就能看见的事实，
   * 不依赖任何读取顺序。
   *
   * 代价是标记可能过期（文件被外部修好 / 换掉之后它还在），所以：
   * - 读到正常文件、文件不存在、备份重建之后，一律清掉；
   * - `writeJson` 撞上标记时先**真读一次**文件，能解析就清标记继续写 —— 绝不相信过期标记。
   */
  function readFlag() {
    try {
      const raw = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      return { message: String(raw.message || `${label} 已损坏（${filePath}）`), at: Number(raw.at) || 0 };
    } catch {
      // 标记本身读不出来/不是 JSON：等于没有标记。真正的守卫仍是「读不出业务文件就拒绝写」。
      return null;
    }
  }

  /** 写标记（best-effort）。写不进去只降级回「本实例内存」，不影响读路径本身。 */
  function writeFlag(info) {
    try {
      atomicWriteFileSync(flagPath, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
      flagSeen = true;
    } catch (e) {
      log(
        `[${label}] 无法写入损坏标记 ${flagPath}（下次启动要重新读到坏文件才知道）：${(e && e.message) || e}`
      );
    }
  }

  function clearFlag() {
    if (!flagSeen) return;
    try {
      fs.unlinkSync(flagPath);
    } catch {
      // 不存在就是目标状态
    }
    flagSeen = false;
  }

  /** 内存里没有损坏态时用标记补上（重启后的第一次写入 / 查询健康度时发生）。 */
  function ensureCorruptState() {
    if (corrupt) return;
    const flag = readFlag();
    if (flag) {
      corrupt = flag;
      flagSeen = true;
    }
  }

  /** 这份文件此刻能解析吗 —— 只用来判断标记是否过期，不改任何状态。 */
  function fileParsesNow() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return !!(raw && typeof raw === 'object');
    } catch {
      return false;
    }
  }

  /**
   * 读并解析。文件不存在返回 `null`（调用方据此走「空态」，不要与「解析失败」混为一谈）。
   * @returns {object | null}
   */
  function readJson() {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        corrupt = null;
        clearFlag(); // 文件都没了，标记必然是过期的
        return null;
      }
      throw e;
    }
    try {
      const raw = JSON.parse(text);
      corrupt = null;
      clearFlag();
      return raw && typeof raw === 'object' ? raw : null;
    } catch (e) {
      const message = `${label} 解析失败（${filePath}）：${(e && e.message) || e}`;
      corrupt = { message, at: Date.now() };
      writeFlag(corrupt);
      if (onCorrupt === 'throw') {
        const err = new Error(message);
        err.code = opts.corruptCode || CORRUPT_CODE;
        log(`[${label}] ${message}`);
        throw err;
      }
      log(`[${label}] ${message}——本次按空处理；在设置页重新填写前不会再写入该文件`);
      return null;
    }
  }

  /**
   * 原子写 + 0600。
   *
   * 只存密文，但文件本身仍要收紧：密文挡不住「谁登录过哪台机器、配了哪些 token」这类元信息，
   * 而 0644（umask 默认）会把它们白送给同机其他用户。
   *
   * **损坏态下拒绝写入**：读到坏文件之后再保存一次，就会用「只有一条」的状态覆盖掉
   * 用户其余凭据（这正是频道配置曾经踩过的坑）。恢复必须走 `resetCorruptFile()`。
   */
  function writeJson(data) {
    ensureCorruptState();
    if (corrupt && fileParsesNow()) {
      // 标记/内存里的损坏态已经过期：文件现在能解析了（被外部修好或换掉），清掉继续写
      corrupt = null;
      clearFlag();
    }
    if (corrupt) {
      const err = new Error(
        `${label} 已损坏（${filePath}）：为免覆盖其余条目，本次保存被拒绝。` +
          '请先在设置页「备份并重建」，再重新填写。'
      );
      err.code = CORRUPT_CODE;
      throw err;
    }
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      // mode 只对新建文件生效：已存在的文件（历史版本建的 0644）要显式收紧
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows 上 chmod 语义有限，忽略
    }
  }

  /** 损坏态（给设置页显示「文件坏了，请重新填写」用；不需要先读过文件）。 */
  function getHealth() {
    ensureCorruptState();
    return {
      filePath,
      corrupt: !!corrupt,
      message: corrupt ? corrupt.message : ''
    };
  }

  /**
   * 把损坏的文件改名备份（`<file>.corrupt-<时间戳>`）并从空态重建 —— 用户点「备份并重建」时调用。
   * 不删原文件：里面可能有还能人工救回的密文，直接删掉是不可逆的数据损失。
   *
   * @returns {{ moved: boolean, backupPath: string }}
   */
  function resetCorruptFile() {
    if (!fs.existsSync(filePath)) {
      corrupt = null;
      clearFlag();
      return { moved: false, backupPath: '' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.corrupt-${stamp}`;
    fs.renameSync(filePath, backupPath);
    corrupt = null;
    clearFlag();
    log(`[${label}] 损坏的文件已备份为 ${backupPath}，将按空态重建`);
    return { moved: true, backupPath };
  }

  return {
    filePath,
    canEncrypt,
    encryptSecret,
    decryptSecret,
    readJson,
    writeJson,
    getHealth,
    resetCorruptFile
  };
}

module.exports = { createSecretStore, ENCRYPT_UNAVAILABLE_CODE, CORRUPT_CODE };

// @ts-check
'use strict';

/**
 * 【本轮能力事实】的**唯一来源**：能力 → 开关判定 + 人话标签 + 设置落点。
 *
 * 为什么需要这一份：权限关掉的工具**根本不会注入**（`renderer-tool-defs.js:171-215`），
 * 于是模型只看得见「工具表里没有」，分不清「这台机器没这个能力」和「用户把它关着」。
 * 结果就是它按惯性写代码、写方案、承诺一个自己做不了的动作，然后才发现工具不存在。
 *
 * 三条边界（别越）：
 * 1. **只管能力，不管工具名**。工具 → 开关的映射仍在 `renderer-tool-defs.js`（那是注入点），
 *    在这里再列一遍工具名就是第二份真相，早晚漂移。本表只回答「这个能力现在开没开」。
 * 2. **不判定、不建议**。这里只把 `permissions` 归一成 on/off 两列；「该不该开」是人和模型的事。
 * 3. **档位标签不在这里**。`label` / `desc` 由调用方从 `gateway/sandbox-policy.js#SANDBOX_MODE_META`
 *    取好传进来（那份是设置页同一份文案）；本模块不许 require gateway 侧代码 —— 它会被打进
 *    Renderer 的 agent-bundle。
 *
 * 判定口径与 `renderer-tool-defs.js#getHostToolFlags` 严格一致：
 * `hostControl` 是文件/命令/浏览器的总闸；`webFetch` 独立于总闸（只认 `!== false`）；
 * 摄像头与电脑控制必须**显式** `=== true`（默认关）。
 */

/**
 * @typedef {{ key: string, label: string }} Capability
 */

/** 展示顺序 = 这段话里的顺序（先日常、后越界）。 */
/** @type {ReadonlyArray<Capability>} */
const CAPABILITIES = Object.freeze([
  { key: 'fsRead', label: '读文件' },
  { key: 'fsWrite', label: '写文件' },
  { key: 'shellExec', label: '执行 Shell' },
  { key: 'browser', label: '浏览器自动化' },
  { key: 'webFetch', label: '联网抓取' },
  // 下面三项默认关。关着的时候模型必须知道「有这个能力、但现在关着」，
  // 否则它会把「我看不见 computer」理解成「这台机器没有电脑控制」。
  // 落点（哪个页面哪个开关）不写在这里 —— 唯一来源是 `CAPABILITY_GUIDE`。
  { key: 'osControl', label: '电脑控制（截屏/键鼠）' },
  { key: 'camera', label: '手机摄像头' },
  { key: 'desktopCamera', label: '本机摄像头' }
]);

/** @type {Record<string, Capability>} */
const CAPABILITY_BY_KEY = Object.freeze(
  CAPABILITIES.reduce((acc, c) => {
    /** @type {Record<string, Capability>} */ (acc)[c.key] = c;
    return acc;
  }, /** @type {Record<string, Capability>} */ ({}))
);

/**
 * 单个能力此刻开没开。
 *
 * @param {string} key
 * @param {object | null | undefined} permissions `permissions-store` 的权限快照
 * @returns {boolean}
 */
function capabilityEnabled(key, permissions) {
  const p = permissions && typeof permissions === 'object' ? permissions : null;
  if (!p) return false;
  const hostControl = p.hostControl === true;
  switch (key) {
    case 'fsRead':
      return hostControl && p.fsRead === true;
    case 'fsWrite':
      return hostControl && p.fsWrite === true;
    case 'shellExec':
      return hostControl && p.shellExec === true;
    case 'browser':
      return hostControl && p.browserAutomation !== false;
    case 'webFetch':
      // 联网抓取走系统代理、不碰本机文件，所以不受 hostControl 管（与工具注入同一口径）
      return p.webFetch !== false;
    case 'osControl':
      return hostControl && p.osControl === true;
    case 'camera':
      return hostControl && p.camera === true;
    case 'desktopCamera':
      return hostControl && p.desktopCamera === true;
    default:
      return false;
  }
}

/**
 * 两列：开着的、关着的（都是能力 key，顺序同 CAPABILITIES）。
 *
 * @param {object | null | undefined} permissions
 * @returns {{ on: string[], off: string[] }}
 */
function enabledCapabilities(permissions) {
  /** @type {string[]} */ const on = [];
  /** @type {string[]} */ const off = [];
  for (const c of CAPABILITIES) {
    if (capabilityEnabled(c.key, permissions)) on.push(c.key);
    else off.push(c.key);
  }
  return { on, off };
}

/**
 * @typedef {{
 *   mode?: string, label?: string, desc?: string,
 *   workspaceRoots?: string[], internalCount?: number,
 *   grantedPaths?: string[], remoteGoverned?: boolean
 * }} SandboxFacts
 */

function labelsOf(keys) {
  return keys
    .map((k) => (CAPABILITY_BY_KEY[k] ? CAPABILITY_BY_KEY[k].label : ''))
    .filter(Boolean)
    .join('、');
}

/**
 * 【本轮能力事实】文本块。没有权限快照（Renderer 兜底装配路径）时返回空串 —— 宁可不说，
 * 也不要拿缺省值编一份「假能力表」。
 *
 * @param {{ permissions?: object | null, sandbox?: SandboxFacts | null }} [input]
 * @returns {string}
 */
function formatCapabilityBlock(input = {}) {
  const permissions = input.permissions && typeof input.permissions === 'object' ? input.permissions : null;
  if (!permissions) return '';
  const sandbox = input.sandbox && typeof input.sandbox === 'object' ? input.sandbox : null;
  const { on, off } = enabledCapabilities(permissions);

  /** @type {string[]} */ const lines = ['【本轮能力事实】'];

  // 档位：label/desc 来自 SANDBOX_MODE_META（设置页同一份文案）；拿不到就只报原始档位名。
  const modeLabel = sandbox && sandbox.label ? String(sandbox.label) : '';
  const modeDesc = sandbox && sandbox.desc ? String(sandbox.desc) : '';
  const modeRaw = sandbox && sandbox.mode ? String(sandbox.mode) : String(permissions.sandboxMode || '');
  if (modeLabel || modeRaw) {
    lines.push(`沙箱：${modeLabel || modeRaw}${modeDesc ? `（${modeDesc}）` : ''}`);
  }

  // 可写根：工作区根是模型真正会动的地方；应用内部目录（账本/日志/技能）只报个数。
  // 远端会话一律不报本机根（`sandbox_state` 报的是本机档位的根，不参与远端写）。
  const remoteSession = !!(sandbox && sandbox.remoteGoverned);
  const roots = !remoteSession && Array.isArray(sandbox && sandbox.workspaceRoots)
    ? /** @type {string[]} */ (sandbox.workspaceRoots).map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const granted = !remoteSession && Array.isArray(sandbox && sandbox.grantedPaths)
    ? /** @type {string[]} */ (sandbox.grantedPaths).map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const internalCount = Number(sandbox && sandbox.internalCount) || 0;
  if (roots.length || granted.length) {
    const shown = [...roots, ...granted].slice(0, 4);
    const more = roots.length + granted.length - shown.length;
    lines.push(
      `可写根：${shown.join('、')}${more > 0 ? `（另 ${more} 处）` : ''}` +
        (internalCount > 0 ? '，另含应用内部目录（账本/日志/技能，任何档位都可写）' : '')
    );
  }
  if (sandbox && sandbox.remoteGoverned) {
    lines.push('当前工作空间在远端主机：文件/命令按远端规则判，本机档位不参与。');
  }

  lines.push(`已开：${on.length ? labelsOf(on) : '（无）'}`);
  if (off.length) {
    // 只说「用不了」，不说「不在工具表里」：弱模型会被精简工具表、子 Agent 只有白名单，
    // 那些场合「不在表里」并不等于「用户关掉了」。
    lines.push(`关着（这些能力现在用不了，需要用户去设置里打开）：${labelsOf(off)}`);
  }

  // 「完全放开路径限制」是权限里的派生视图：必须只说本机，远端恒为工作空间 + $HOME + /tmp
  // （执行侧 `gateway/path-policy.remoteAllowedRoots` 不认这个开关）。
  if (permissions.unrestrictedPaths === true) {
    lines.push(
      '路径限制：本机已完全放开（所有磁盘任意路径可读写，含系统目录）；远程工作空间不受此开关影响，仍是工作空间 + $HOME + /tmp。'
    );
  }

  if (permissions.hostControl === true) {
    lines.push(
      '工具名与参数见 schema。Windows 的 host_exec 是 cmd，不是 PowerShell；python -c 双引号内不要写分号。' +
        '失败看 errorCode/suggestedFix；大输出看 outputFile。'
    );
  }
  return lines.join('\n');
}

/**
 * 能力 → 「用户去哪儿打开它」。
 *
 * 这不是安全策略，而是**申请闭环**需要的事实：模型说「我需要摄像头」之后，得说得出
 * 「你去哪个页面点哪个开关」，否则它只能把话憋在正文里等用户自己找。
 * 页面 id / 控件 id 都取自 `src/renderer/index.html`（`data-settings` / `id="perm-*"`），
 * 只在这里出现一次 —— 渲染器的申请分发按这份描述符干活，不认能力名。
 */
const CAPABILITY_GUIDE = Object.freeze({
  fsRead: { page: 'perms', anchor: 'perm-host-control', text: '设置 → 本机权限 → 启用本机控制' },
  fsWrite: { page: 'perms', anchor: 'perm-host-control', text: '设置 → 本机权限 → 启用本机控制' },
  shellExec: { page: 'perms', anchor: 'perm-host-control', text: '设置 → 本机权限 → 启用本机控制' },
  browser: { page: 'perms', anchor: 'perm-host-control', text: '设置 → 本机权限 → 启用本机控制' },
  webFetch: { page: 'perms', anchor: 'perm-host-control', text: '设置 → 本机权限（联网抓取）' },
  osControl: { page: 'perms', anchor: 'perm-os-control', text: '设置 → 本机权限 → 启用电脑控制' },
  camera: { page: 'perms', anchor: 'perm-camera', text: '设置 → 本机权限 → 启用手机摄像头' },
  desktopCamera: { page: 'perms', anchor: 'perm-desktop-camera', text: '设置 → 本机权限 → 启用本机摄像头' }
});

/**
 * 不属于 `permissions` 的申请类型（同样只有这一份）。
 * `mcpCredential` 是唯一已经跑通的闭环（`mcp_manage.request_credential` → 用户填 → list 复查），
 * 这里把它也登记进来，好让「申请」只有一条通道。
 */
const EXTRA_REQUEST_KINDS = Object.freeze({
  mcpCredential: {
    label: 'MCP 服务凭据',
    guide: { page: 'skills', text: '设置 → 技能 → MCP：选中该服务，填 Token / 环境变量后保存' }
  }
});

/**
 * 申请项的解析（能力 key 或额外类型 → 统一的描述符）。
 *
 * @param {string} kind
 * @returns {{ key: string, label: string, guide: { page: string, anchor?: string, text: string } } | null}
 */
function resolveRequestKind(kind) {
  const key = String(kind || '').trim();
  const cap = CAPABILITY_BY_KEY[key];
  if (cap) {
    return { key, label: cap.label, guide: CAPABILITY_GUIDE[key] || { page: 'perms', text: '设置 → 本机权限' } };
  }
  const extra = EXTRA_REQUEST_KINDS[key];
  if (extra) return { key, label: extra.label, guide: extra.guide };
  return null;
}

/**
 * 把 Gateway `permissions.sandbox_state` 的原始返回**投影**成事实块 / 自检工具要的窄形状。
 *
 * 为什么投影放在这里：两处消费者（系统提示的能力块、`agent_inspect`）必须看到同一份口径，
 * 各投影一次早晚会漂成「提示里说三个可写根、自检里说五个」。档位文案不在这里写死 ——
 * 由调用方把 `SANDBOX_MODE_META` 传进来（那份是设置页同一份文案）。
 *
 * @param {any} raw `permissions.sandbox_state` 的返回
 * @param {Record<string, { label?: string, desc?: string }>} [sandboxModeMeta]
 * @returns {SandboxFacts | null}
 */
function projectSandboxState(raw, sandboxModeMeta) {
  if (!raw || typeof raw !== 'object' || raw.unavailable) return null;
  const mode = String(raw.mode || '');
  const meta = sandboxModeMeta && mode ? sandboxModeMeta[mode] : null;
  const remoteGoverned = raw.remoteGoverned === true;
  return {
    mode,
    label: meta && meta.label ? String(meta.label) : '',
    desc: meta && meta.desc ? String(meta.desc) : '',
    // 远端会话里 `sandbox_state` 报的根是**本机**的（档位判定不参与远端写），
    // 报给模型只会变成「这些是本机能写的地方」的误导 —— 远端范围由系统提示的 SSH 块说。
    workspaceRoots: remoteGoverned ? [] : Array.isArray(raw.workspaceRoots) ? raw.workspaceRoots : [],
    grantedPaths: remoteGoverned ? [] : Array.isArray(raw.grantedPaths) ? raw.grantedPaths : [],
    internalCount: Array.isArray(raw.internalRoots) ? raw.internalRoots.length : 0,
    remoteGoverned
  };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_BY_KEY,
  CAPABILITY_GUIDE,
  EXTRA_REQUEST_KINDS,
  capabilityEnabled,
  enabledCapabilities,
  resolveRequestKind,
  projectSandboxState,
  formatCapabilityBlock
};

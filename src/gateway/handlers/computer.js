'use strict';

const { decideOsControlAction } = require('../sandbox-policy');
const { getAgentLimits } = require('../../agent/agent-limits');
const {
  viewPointToScreenPhysical,
  viewRectToPhysicalRect,
  regionView
} = require('../../computer/coordinate-map');
const { encodeWithinBudget } = require('../../computer/capture');
const { ABSOLUTE_READ_MAX_BYTES } = require('../fs-read-limits');
const { shellQuoteSingle } = require('../../ssh/remote-path');
const {
  REMOTE_TMP_ROOT,
  REMOTE_SCREEN_TIMEOUT_MS,
  buildProbeScript,
  parseProbeOutput,
  describeProbe,
  buildCaptureCommand,
  buildInputCommand,
  pngSize,
  frameSignature
} = require('../../remote/ssh-screen');

/**
 * computer 工具的 gateway handler：开关断言 → 沙箱判定/审批 → 调执行体。
 *
 * 判定单一来源在 `sandbox-policy.js`（decideOsControlAction），这里不做任何白名单判断。
 * 执行体有**两台机器**，由 `target` 明确指定（不再用「工作空间是不是远端」去猜）：
 * - `local`（默认）：跑叠云这台机器，`src/computer/service.js`；
 * - `remote`：会话工作空间的 SSH 主机，走 `src/remote/ssh-screen.js` 的能力探测 +
 *   截图（远端临时文件 → 远端文件通道取回）+ 键鼠注入。
 */

function createComputerHandlers(d) {
  const {
    computer,
    assertOsControlEnabled,
    sandbox,
    getActiveCallSessionId,
    getRemoteFs,
    requireSshForCall,
    resolveCallWorkspaceTarget,
    ctx
  } = d;

  /** 远端屏幕的探测结果 / 坐标空间 / 上一帧指纹：按 SSH 目标缓存（换机器就重新探）。 */
  const remoteScreens = new Map();

  function screenError(code, message, suggestedFix) {
    const e = new Error(message);
    e.code = code;
    e.retryable = false;
    if (suggestedFix) e.suggestedFix = suggestedFix;
    return e;
  }

  /**
   * 限制值的唯一来源仍是 agent-limits：视觉预算（截图缩放）与等待窗口都在这里解析，
   * 不能只在 capture 里读默认值 —— 否则设置页调了不生效。
   */
  function resolveLimits() {
    const userDataPath = ctx && ctx.userDataPath;
    const limits = (userDataPath && getAgentLimits(userDataPath)) || {};
    return limits;
  }

  function visionBudget(limits) {
    return { maxEdge: limits.visionShotMaxEdge, maxBase64Chars: limits.visionMaxBase64Chars };
  }

  /**
   * 沙箱档位对 computer 动作的判定（输入动作 → 问一次；截屏 → 开关即同意）。
   * @param {string} action
   * @param {string} sessionId
   */
  async function guardComputer(action, sessionId, opts = {}) {
    if (!sandbox) {
      // fail-closed：与 host.exec 同一立场——装配错误不能静默放行成无限制提权面。
      const e = new Error('沙箱未就绪，已拒绝执行（请重启应用；装配问题不该由用户承担风险）');
      e.code = 'SANDBOX_UNAVAILABLE';
      e.retryable = false;
      throw e;
    }
    const decision = decideOsControlAction(action, {
      mode: sandbox.context().mode,
      // 远端屏幕的输入动作同样是「操作系统输入」：措辞说清是哪台机器，档位口径不变；
      // hostKey 让「哪台远端」也进授权粒度（换主机要重新问）
      remote: opts.remote === true,
      hostKey: opts.hostKey || ''
    });
    const blocked = await sandbox.guard(decision, {
      tool: 'computer',
      sessionId: sessionId || getActiveCallSessionId()
    });
    if (blocked) {
      const e = new Error(blocked.error);
      e.code = blocked.errorCode;
      e.sandboxMode = blocked.sandboxMode;
      e.retryable = false;
      throw e;
    }
  }

  //#region 远端屏幕
  function decodeNativeImage(buffer) {
    try {
      const { nativeImage } = require('electron');
      if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
      const img = nativeImage.createFromBuffer(buffer);
      return img && !(typeof img.isEmpty === 'function' && img.isEmpty()) ? img : null;
    } catch {
      return null;
    }
  }

  /**
   * 把远端原生截图缩进视觉预算（与本地 capture 同一套 `encodeWithinBudget`）。
   *
   * 为什么必须在**这里**缩：模型看到的图必须和注入坐标同一个空间。若交给下游视觉管线缩，
   * 这边记录的坐标空间还是原生尺寸，模型按缩小后的图点下去就会落在别处。
   */
  function fitToVisionBudget(shot, budget) {
    const maxEdge = Number(budget && budget.maxEdge) || 0;
    const maxChars = Number(budget && budget.maxBase64Chars) || 0;
    const withinEdge = !maxEdge || Math.max(shot.width, shot.height) <= maxEdge;
    const withinChars = !maxChars || shot.base64.length <= maxChars;
    if (withinEdge && withinChars) return shot;
    const image = decodeNativeImage(Buffer.from(shot.base64, 'base64'));
    if (!image) return shot; // 解不出来就原样交回：下游会按预算如实说「这张图没进来」
    const enc = encodeWithinBudget(image, { maxEdge, maxBase64Chars: maxChars });
    if (!enc || !enc.base64 || enc.overBudget) return shot;
    return { base64: enc.base64, width: enc.width, height: enc.height, mime: enc.mime };
  }

  function remoteTargetOrThrow() {
    const target = typeof resolveCallWorkspaceTarget === 'function' ? resolveCallWorkspaceTarget() : null;
    if (!target || target.kind !== 'ssh') {
      throw screenError(
        'REMOTE_SCREEN_REQUIRES_SSH',
        'target=remote 需要当前会话挂着 SSH 工作空间（现在没有远端主机可看）',
        '本机屏幕用默认 target=local；要连远端先用 ssh 工具连上并把工作空间切过去。'
      );
    }
    const remoteFs = typeof getRemoteFs === 'function' ? getRemoteFs() : null;
    if (!remoteFs) {
      throw screenError('SSH_NOT_CONNECTED', 'SSH 未连接，无法看远端屏幕', '在主界面重连远端主机后重试。');
    }
    return { target, remoteFs };
  }

  function screenKey(target, sessionId) {
    // 带上会话：坐标空间与「上一帧指纹」是**每个会话各自**的，
    // 两个会话连同一台主机时共用一个视图会互相把坐标/指纹冲掉。
    const sid = String(sessionId || getActiveCallSessionId() || '-');
    return `${target.username || ''}@${target.host || ''}:${Number(target.port) || 22}#${sid}`;
  }

  async function execRemote(ssh, command, cwd) {
    const r = await ssh.exec(command, cwd, REMOTE_SCREEN_TIMEOUT_MS);
    return r || { code: 1, stdout: '', stderr: '' };
  }

  /** 探测一次并缓存：远端能力不会在一个会话里变，探一次就够（探不到不缓存）。 */
  async function ensureCaps(state, ssh, cwd) {
    if (state.caps) return state.caps;
    const probe = await execRemote(ssh, buildProbeScript(), cwd);
    const out = String(probe.stdout || '');
    if (!/PROBE_OK=1/.test(out)) {
      throw screenError(
        'REMOTE_SCREEN_PROBE_FAILED',
        '远端屏幕能力探测失败（远端没跑通探测脚本，可能不是 POSIX shell）',
        `远端输出：${(out || probe.stderr || '(空)').slice(0, 200)}。Windows 远端暂未接入，请用 VNC/RDP 或 target=local。`
      );
    }
    state.caps = parseProbeOutput(out);
    return state.caps;
  }

  /** 截一张远端原生图（落远端 /tmp → 走远端文件通道读回来，不占 stdout；读完即删）。 */
  async function captureNative(state, ssh, caps, cwd, regionNative) {
    // 文件名带「主机 + 会话」：同一台机器上两个会话同时截图不会互相覆盖
    const outPath = `${REMOTE_TMP_ROOT}/.dieyun-screen-${String(state.slug || 'x')}.png`;
    // macOS 的 `-R` 与注入工具吃的是**逻辑点**，而模型看到的图是物理像素（Retina 上是 2 倍）
    const ratio = caps.os === 'Darwin' && state.ratio > 0 ? state.ratio : 1;
    const regionForCmd =
      regionNative && ratio !== 1
        ? {
            x: Math.round(regionNative.x / ratio),
            y: Math.round(regionNative.y / ratio),
            width: Math.max(1, Math.round(regionNative.width / ratio)),
            height: Math.max(1, Math.round(regionNative.height / ratio))
          }
        : regionNative || null;
    const built = buildCaptureCommand(caps, outPath, regionForCmd);
    if (built.error) throw screenError(built.code, built.error, built.suggestedFix);
    const r = await execRemote(ssh, `mkdir -p ${shellQuoteSingle(REMOTE_TMP_ROOT)}; ${built.cmd}`, cwd);
    if (r.code !== 0) {
      throw screenError(
        'REMOTE_SCREEN_CAPTURE_FAILED',
        `远端截图失败：${(r.stderr || r.stdout || '').trim().slice(0, 200) || `exit ${r.code}`}`,
        '确认远端当前有活动的图形会话（X/Wayland），并且 DISPLAY 可用；详细能力见 action=screenshot 的首个错误。'
      );
    }
    let read;
    try {
      read = await state.remoteFs.readFile(outPath, 'base64', { maxBytes: ABSOLUTE_READ_MAX_BYTES });
    } finally {
      // 读完就删：远端临时文件是我们自己的中间产物，留着只会占地方（失败也不影响本次结论）
      void execRemote(ssh, `rm -f ${shellQuoteSingle(outPath)}`, cwd).catch(() => {});
    }
    const buf = Buffer.from(String((read && read.data) || ''), 'base64');
    if (read && read.truncated === true) {
      // 读回来的是**截断的** PNG：头还在、像素没了。交给视觉管线只会得到一张坏图，
      // 模型据此判断界面会全错 —— 宁可如实报错。
      throw screenError(
        'REMOTE_SCREEN_TOO_LARGE',
        `远端截图超过 ${ABSOLUTE_READ_MAX_BYTES} 字节上限，读回来的副本不完整`,
        '远端分辨率/缩放太大：先用 region 只截一块，或把远端显示缩放调小；不要原样重试。'
      );
    }
    const size = pngSize(buf);
    if (!size) {
      throw screenError(
        'REMOTE_SCREEN_CAPTURE_FAILED',
        `远端截图读回来不是 PNG（${buf.length} 字节）`,
        '换一个截图工具试试（scrot / import / grim），或检查远端磁盘剩余空间。'
      );
    }
    return { base64: buf.toString('base64'), width: size.width, height: size.height, path: outPath };
  }

  function viewKey(view) {
    return `${view.originX},${view.originY},${view.nativeWidth}x${view.nativeHeight},${view.width}x${view.height}`;
  }

  /** 一次「看图」：截图 → 缩进预算 → 更新坐标空间 → 报 changed。 */
  async function look(state, ssh, caps, cwd, regionNative, opts = {}) {
    const limits = opts.limits || resolveLimits();
    // `regionNative === undefined` 表示「沿用上一块的区域」（输入动作后的回显、wait 系列）：
    // 本机执行体在动作后给的是**同一块 region** 的新画面，远端也要一致，
    // 否则模型按 region 像素继续点就会落到别处。
    const region = regionNative === undefined ? state.regionNative || null : regionNative;
    const native = await captureNative(state, ssh, caps, cwd, region);
    // Retina：物理像素 ÷ 逻辑点 = 注入工具需要除以的比例（其它平台恒 1）
    if (caps.os === 'Darwin' && caps.pointWidth > 0) {
      const ratio = native.width / caps.pointWidth;
      state.ratio = ratio > 0.5 && ratio < 4 ? ratio : 1;
    }
    const delivered = fitToVisionBudget(native, visionBudget(limits));
    if (region) {
      state.view = {
        ...regionView(region),
        width: delivered.width,
        height: delivered.height
      };
    } else {
      state.view = {
        originX: 0,
        originY: 0,
        nativeWidth: native.width,
        nativeHeight: native.height,
        width: delivered.width,
        height: delivered.height
      };
    }
    const sig = frameSignature(native.base64);
    const key = viewKey(state.view);
    const changed = state.hash && state.hashKey === key ? state.hash !== sig : null;
    state.hash = sig;
    state.hashKey = key;
    state.regionNative = region;
    return {
      base64: delivered.base64,
      mime: delivered.mime || 'image/png',
      width: delivered.width,
      height: delivered.height,
      native: { width: native.width, height: native.height },
      screen: { width: native.width, height: native.height },
      changed,
      sig
    };
  }

  async function remoteComputer({ action, rest, sessionId, resolved }) {
    const { target, remoteFs } = resolved || remoteTargetOrThrow();
    const ssh = requireSshForCall();
    const key = screenKey(target, sessionId);
    let state = remoteScreens.get(key);
    if (!state) {
      state = {
        caps: null,
        view: null,
        hash: null,
        hashKey: null,
        // 当前坐标空间对应的原生区域（null = 整屏）；输入动作后的回显要用同一块
        regionNative: null,
        // macOS Retina：注入工具吃逻辑点，模型吃物理像素
        ratio: 1,
        slug: key.replace(/[^a-zA-Z0-9]+/g, '_'),
        remoteFs
      };
      remoteScreens.set(key, state);
    }
    state.remoteFs = remoteFs;
    state.slug = key.replace(/[^a-zA-Z0-9]+/g, '_');
    const cwd = String((typeof ssh.getHomeDir === 'function' && ssh.getHomeDir()) || target.remotePath || '/tmp');
    const limits = resolveLimits();
    const caps = await ensureCaps(state, ssh, cwd);
    const capabilityProblem = describeProbe(caps);
    // 只有「看不了」是致命的；「动不了」（缺注入工具）要放行看图
    if (capabilityProblem && capabilityProblem.fatal) {
      throw screenError(capabilityProblem.code, capabilityProblem.message, capabilityProblem.suggestedFix);
    }
    const capabilityNote = capabilityProblem
      ? `${capabilityProblem.message}。${capabilityProblem.suggestedFix || ''}`
      : '';

    if (action === 'screenshot') {
      const wantsRegion = Array.isArray(rest.region) && rest.region.length >= 4;
      if (wantsRegion && !state.view) {
        // region 是「相对你最近看到的那张图」的坐标：还没有任何一张图时没有坐标空间可依据，
        // 猜一个只会裁到别处 —— 让模型先整屏看一眼，再按那块区域裁。
        throw screenError(
          'REMOTE_SCREEN_REGION_NO_VIEW',
          '远端还没有可依据的坐标空间：先截一张整屏（不带 region），再按那块区域裁剪',
          '先 action=screenshot（不传 region）看整屏，然后用同一套像素坐标传 region。'
        );
      }
      const regionNative = wantsRegion ? viewRectToPhysicalRect(state.view, rest.region) : null;
      const shot = await look(state, ssh, caps, cwd, regionNative, { limits });
      return {
        ok: true,
        action,
        display: 0,
        primary: true,
        screen: shot.screen,
        width: shot.width,
        height: shot.height,
        mime: shot.mime,
        base64: shot.base64,
        ...(shot.changed != null ? { changed: shot.changed } : {}),
        remote: true,
        host: key,
        note: `这是远端主机（SSH 工作空间）的屏幕画面${capabilityNote ? `。${capabilityNote}` : ''}`
      };
    }

    if (action === 'wait') {
      const ms = Math.min(
        Math.max(50, Number(rest.ms) || 1000),
        Number(limits.computerWaitMaxMs) || 10000
      );
      await new Promise((r) => setTimeout(r, ms));
      // 沿用当前坐标空间（有 region 就给同一块的新画面）
      const shot = await look(state, ssh, caps, cwd, undefined, { limits });
      return {
        ok: true,
        action,
        display: 0,
        primary: true,
        screen: shot.screen,
        width: shot.width,
        height: shot.height,
        mime: shot.mime,
        base64: shot.base64,
        ...(shot.changed != null ? { changed: shot.changed } : {}),
        waitedMs: ms,
        remote: true,
        host: key
      };
    }

    if (action === 'wait_until') {
      const cap = Math.min(
        Math.max(500, Number(rest.ms) || 8000),
        Number(limits.computerWaitUntilMaxMs) || 20000
      );
      const condition = String(rest.condition || 'changed') === 'stable' ? 'stable' : 'changed';
      const started = Date.now();
      const priorSig = state.hash;
      const priorKey = state.hashKey;
      let shot = await look(state, ssh, caps, cwd, undefined, { limits });
      // 还没有「上一次看到的画面」时，用这一张当基准 —— 否则 changed 永远是 false，
      // 明明画面变了也要白等满超时（模型会误判成「上一步没生效」）。
      const baseline = priorSig && priorKey === viewKey(state.view) ? priorSig : shot.sig;
      let prevSig = null;
      let timedOut = false;
      for (;;) {
        const changed = shot.sig !== baseline;
        // 「稳定」必须是连续两帧相同：只看一帧永远不知道自己是不是还在变
        const stable = prevSig != null && prevSig === shot.sig;
        if (condition === 'changed' ? changed : stable) break;
        if (Date.now() - started >= cap) {
          timedOut = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
        prevSig = shot.sig;
        shot = await look(state, ssh, caps, cwd, undefined, { limits });
      }
      const finalChanged = shot.sig !== baseline;
      return {
        ok: true,
        action,
        display: 0,
        primary: true,
        screen: shot.screen,
        width: shot.width,
        height: shot.height,
        mime: shot.mime,
        base64: shot.base64,
        ...(finalChanged != null ? { changed: finalChanged } : {}),
        ...(condition === 'stable' ? { stable: !timedOut } : {}),
        timedOut,
        waitedMs: Date.now() - started,
        remote: true,
        host: key,
        ...(timedOut
          ? { note: '你等的那个变化没发生；这通常意味着上一步输入没有生效。' }
          : {})
      };
    }

    // 输入动作：先注入，再截一张让模型看结果（与本地同一契约；沿用当前坐标空间）
    const ratio = caps.os === 'Darwin' && state.ratio > 0 ? state.ratio : 1;
    const built = buildInputCommand(caps, action, rest, {
      viewPointToNative: (c) => {
        const p = viewPointToScreenPhysical(state.view || { nativeWidth: 1, nativeHeight: 1 }, c);
        // Retina：注入工具（cliclick / -R）吃逻辑点，模型给的是物理像素
        return { x: p.x / ratio, y: p.y / ratio };
      }
    });
    if (built.error) throw screenError(built.code, built.error, built.suggestedFix);
    const run = await execRemote(ssh, built.cmd, cwd);
    if (run.code !== 0) {
      throw screenError(
        'REMOTE_SCREEN_INPUT_FAILED',
        `远端注入失败：${(run.stderr || run.stdout || '').trim().slice(0, 200) || `exit ${run.code}`}`,
        '确认远端有活动图形会话且注入工具可用（xdotool / ydotool / cliclick）；不要原样重复同一动作。'
      );
    }
    const shot = await look(state, ssh, caps, cwd, undefined, { limits });
    return {
      ok: true,
      action,
      applied: true,
      display: 0,
      primary: true,
      screen: shot.screen,
      width: shot.width,
      height: shot.height,
      mime: shot.mime,
      base64: shot.base64,
      // 不报 `typed`：那是「实际投递成功的字符数」，远端注入这边只能知道「命令退出码 0」。
      // 编一个「想发的长度」当事实，会让模型以为核对过输入。
      ...(shot.changed != null ? { changed: shot.changed } : {}),
      remote: true,
      host: key
    };
  }
  //#endregion

  return {
    'computer.action': async (params = {}) => {
      assertOsControlEnabled();
      // 工作空间在**哪台机器**（本地 / SSH 远端）与键鼠截屏的落点是两个正交的轴：
      // computer 默认作用于「叠云运行的这台机器」的屏幕（`target=local`），
      // `target=remote` 明确要会话 SSH 主机的屏幕 —— 两台机器的判定都在这里分开，不猜。
      const { sessionId, target: rawTarget, ...rest } = params;
      const targetScope = String(rawTarget || 'local').toLowerCase();
      if (targetScope !== 'local' && targetScope !== 'remote') {
        throw screenError(
          'INVALID_ARG',
          `target 只能是 local 或 remote（收到「${rawTarget}」）`,
          '不传 = local（叠云这台机器）；SSH 主机的屏幕用 target=remote。'
        );
      }
      const action = String(rest.action || '');
      if (targetScope === 'remote') {
        // 先确认真有远端主机再问审批：没有 SSH 会话时那次弹窗注定作废，
        // 让用户点一次「允许」然后拿到一个失败，是最没必要的打扰。
        const resolved = remoteTargetOrThrow();
        await guardComputer(action, sessionId, {
          remote: true,
          // 同一台机器的身份（不含会话）：换主机要重新批准
          hostKey: `${resolved.target.username || ''}@${resolved.target.host || ''}:${Number(resolved.target.port) || 22}`
        });
        return remoteComputer({ action, rest, sessionId, resolved });
      }
      await guardComputer(action, sessionId);
      return computer.action({ ...rest, sessionId, visionBudget: visionBudget(resolveLimits()) });
    }
  };
}

module.exports = { createComputerHandlers };

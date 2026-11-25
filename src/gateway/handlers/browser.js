'use strict';

// 产物读写一律用 promises 版：这里全部是 async 函数，`require('fs')` 的同步签名
// 配上 await 会抛 `cb argument must be a function` —— 而产物读取的错误被 try/catch 吞成
// 「还没有基准」，于是视觉回归每次都重建基准、永不比较（曾经就这么静默着）。
const fs = require('fs/promises');
const path = require('path');
const { ensureExtension, resolveOutputPath } = require('../../browser/service');
const { defaultBaselineName, withEngineTag } = require('../../browser/visual-diff');
const { ABSOLUTE_READ_MAX_BYTES } = require('../fs-read-limits');
// 「这条路径确实不存在」的唯一判据（本机 ENOENT / SFTP NO_SUCH_FILE / 远端 RPC ENOENT）
const { isPathMissingError } = require('../path-policy');

function createBrowserHandlers(d) {
  const {
    assertBrowserEnabled,
    resolveBrowserNavigateUrl,
    parseRemotePreviewTarget,
    sshTargetKey,
    resolveCallWorkspaceTarget,
    resolveSshManager,
    portForwardManager,
    readRootsForCall,
    cwdForCall,
    defaultCwd,
    browser,
    assertAllowedPath,
    normalizeFilePathInput,
    roots,
    writable,
    writeRootsForCall,
    assertSandboxWritable,
    getRemoteFs,
    resolveFsTarget
  } = d;

  /**
   * 浏览器产物落盘的单一来源（截图 / PDF / HAR / 视觉基准与 diff 图共用）。
   *
   * 内置浏览器跑在本机，产物只存在于本机内存 —— SSH 工作区必须经 SFTP 送过去；本地工作区
   * 则要过工作区白名单。这两条以前散在三个 handler 里各写一份，且 SSH 分支整个缺失：
   * 拿本地白名单去校验远程路径必然越界，抛错还会连带把 base64 一起丢掉（模型既拿不到
   * 文件，视觉注入也一起废掉）。与 fs.* 写类工具同此 remote first。
   *
   * `local:` 前缀（`resolveFsTarget`）指**本机**：SSH 会话里要把截图/PDF 存到本机磁盘时用，
   * 否则那个路径会被当成远端路径，最终在另一台机器上落一个同名文件。
   *
   * @param {string} target 调用方指定的落盘路径；为空 → 落到程序自选的产物目录
   * @param {string} content 产物内容
   * @param {'base64'|'utf8'} encoding
   * @param {string} ext 产物扩展名（png / pdf / har）
   * @param {string} prefix 自选目录下的默认文件名前缀
   * @returns {Promise<{path: string, bytes: number}>}
   */
  async function writeArtifact(target, content, encoding, ext, prefix) {
    const buf = Buffer.from(content, encoding);
    const ref = target ? resolveFsTarget(target) : null;
    // 没给路径时**仍然跟随会话**：SSH 会话的默认落点是远端工作区（老行为），
    // 不能因为「没有 target 就没有 ref」而悄悄写成本机文件。
    const remote = ref
      ? ref.remote
      : typeof getRemoteFs === 'function'
        ? getRemoteFs()
        : null;
    if (remote) {
      // 相对路径由 remoteFs 按远程工作区根解析；没给就用默认文件名落在远程 workspace
      const name = ref && ref.path ? ensureExtension(ref.path, ext) : `${prefix}-${Date.now()}.${ext}`;
      // 远端落盘与 fs.write_file 同一条档位链（远端工作区内放行、区外问一次）
      await assertSandboxWritable(remote.resolve(name, remote.root), 'browser_artifact', { remote: true });
      const written = await remote.writeFile(name, content, encoding);
      return { path: written.path, bytes: buf.length };
    }
    // 没给路径 → 落程序自选的产物目录（模型未指定路径，不存在越权面）。
    if (!ref || !ref.path) {
      const fallback = resolveOutputPath('', ext, prefix);
      await fs.mkdir(path.dirname(fallback), { recursive: true });
      await fs.writeFile(fallback, buf);
      return { path: fallback, bytes: buf.length };
    }
    // 模型给了路径 → 与 fs.write_file 同一条链：先过沙箱档位（read-only 不落盘、工作区外问一次），
    // 再过写白名单（含刚被批准的目录）。以前这里用的是「读根 ∪ 写根」，
    // 而读根里含用户主目录 —— 于是 read-only 档仍能往主目录写产物，档位被整条绕过。
    const rawPath = ensureExtension(
      normalizeFilePathInput(ref.path, ref.base || defaultCwd),
      ext
    );
    await assertSandboxWritable(rawPath, 'browser_artifact');
    const safe = assertAllowedPath(rawPath, writeRootsForCall());
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, buf);
    return { path: safe, bytes: buf.length };
  }

  /**
   * 产物路径解析（读写共用，与 writeArtifact 同一套规则）：SSH 走远程根解析，本地过工作区白名单；
   * `local:` 前缀指本机（SSH 会话里读/写本机上的视觉基准）。
   * 越界直接抛，不静默降级 —— 否则会把「读错地方」误判成「首次调用」，
   * 用当前截图把用户已有的基准覆盖掉。
   * @returns {{remote: object|null, path: string}}
   */
  function resolveArtifactPath(ref) {
    const t = resolveFsTarget(ref);
    if (t.remote) return { remote: t.remote, path: t.remote.resolve(t.path, t.remote.root) };
    return {
      remote: null,
      path: assertAllowedPath(
        normalizeFilePathInput(t.path, t.base || defaultCwd),
        Array.from(new Set([...roots, ...writable]))
      )
    };
  }

  /**
   * 浏览器产物的**读取**（与 writeArtifact 对称）：SSH 工作区经 SFTP 读，本地工作区经 fs 读。
   * 视觉基准是唯一需要「先读回来」的产物 —— 内置浏览器跑在本机，基准却是工作区里的文件。
   *
   * 只有「文件确实不存在」才返回空 buffer，此时语义就是「还没有基准」；
   * 读失败（权限 / 是目录 / 传输断）一律上抛 —— 那意味着基准没法比，不是「没有基准」。
   *
   * @param {string} ref 基准路径（相对或绝对）
   * @returns {Promise<{path: string, buffer: Buffer|null}>} path 为解析后的真实路径，供回显
   */
  async function readArtifactIfExists(ref) {
    const { remote, path: safe } = resolveArtifactPath(ref);
    try {
      if (remote) {
        const file = await remote.readFile(safe, 'base64', { maxBytes: ABSOLUTE_READ_MAX_BYTES });
        const buf = file && file.data != null ? Buffer.from(file.data, 'base64') : null;
        return { path: safe, buffer: buf && buf.length ? buf : null };
      }
      const buf = await fs.readFile(safe);
      return { path: safe, buffer: buf && buf.length ? buf : null };
    } catch (err) {
      // 只有「确实不存在」才是「还没有基准」；读失败必须上抛。把它当空 buffer 的后果是上层
      // 按首次调用处理：回写新基准并报「已保存为新基准」—— 用户已有的基准文件被覆盖
      // （本文件头注释记的正是这桩事故：错误被吞成「还没有基准」，视觉回归永远重建、从不比较）。
      if (isPathMissingError(err)) return { path: safe, buffer: null };
      throw err;
    }
  }

  /**
   * SSH 工作空间下的「远端预览」：内置浏览器跑在本机，`localhost:5000` 指的是本机而不是
   * 远端主机，只有先建 SSH 端口转发才能看到远端 dev server。
   * 命中时返回改写后的本机地址与转发信息；未命中/建不了隧道返回 null（绝不阻断导航）。
   */
  async function rewriteForRemotePreview(safeUrl) {
    if (!portForwardManager || typeof portForwardManager.findOrAddForward !== 'function') return null;
    if (typeof parseRemotePreviewTarget !== 'function') return null;
    const preview = parseRemotePreviewTarget(safeUrl);
    if (!preview) return null;
    const target = typeof resolveCallWorkspaceTarget === 'function' ? resolveCallWorkspaceTarget() : null;
    if (!target || target.kind !== 'ssh') return null;
    const manager = typeof resolveSshManager === 'function' ? resolveSshManager() : null;
    if (!manager || typeof manager.status !== 'function' || !manager.status().connected) {
      return {
        skipped: true,
        reason:
          `远端预览候选 ${preview.remoteHost}:${preview.remotePort}，但 SSH 未连接，` +
          '无法建立端口转发；请先在工作空间菜单重连远程主机。'
      };
    }
    const row = await portForwardManager.findOrAddForward(manager, {
      hostKey: typeof sshTargetKey === 'function' ? sshTargetKey(target) : '',
      remoteHost: preview.remoteHost,
      remotePort: preview.remotePort
    });
    const localHost = row.localHost || '127.0.0.1';
    const rewritten = new URL(safeUrl);
    rewritten.hostname = localHost;
    rewritten.port = String(row.localPort);
    return {
      url: rewritten.toString(),
      requestedUrl: safeUrl,
      forward: {
        id: row.id,
        remoteHost: preview.remoteHost,
        remotePort: preview.remotePort,
        localHost,
        localPort: row.localPort,
        reused: !!row.reused
      },
      note:
        `SSH 工作空间：远端 ${preview.remoteHost}:${preview.remotePort} 已通过端口转发映射到本机 ` +
        `${localHost}:${row.localPort} 后在内置浏览器打开。` +
        (row.localPortFallback
          ? `（本机 ${preview.remotePort} 被占用，已改用随机端口；页面内硬编码 localhost:${preview.remotePort} 的绝对地址可能失效）`
          : '')
    };
  }

  /** 探针结果 → 一句人话；ERR_EMPTY_RESPONSE 这类错误靠它区分「转发没生效」和「远端没服务」。 */
  function describePreviewProbe(probe) {
    if (!probe) return '';
    if (probe.ok) {
      return (
        `本地探针已拿到 HTTP ${probe.status || '响应'}，说明转发与远端服务都正常，` +
        '失败更可能出在浏览器侧（引擎异常或系统代理），可改用 engine=browserview 复测'
      );
    }
    if (probe.error === 'empty_response' || probe.error === 'ECONNRESET') {
      return (
        '本地探针：连接被对端直接关闭且无任何数据——远端该端口没有服务监听，或该端口不是 HTTP 服务' +
        '（HTTPS dev server 需用 https:// 打开），或服务只在容器/其它地址上监听'
      );
    }
    if (probe.error === 'ECONNREFUSED') return '本地探针被拒绝连接——转发未生效（可能已随 SSH 断开被回收）';
    if (probe.error === 'timeout') return '本地探针超时——远端无响应（服务卡住或链路被丢弃）';
    return `本地探针：${probe.error}`;
  }

  /**
   * 导航失败时把「转发映射 + 探针结论」拼进错误信息：否则 ERR_EMPTY_RESPONSE 这类错误
   * 与「根本没建转发」在界面上完全无法区分（同号端口时改写前后 URL 还一模一样）。
   */
  async function augmentPreviewFailure(err, preview) {
    const forward = preview && !preview.skipped ? preview.forward : null;
    if (!forward) return err;
    const lines = [err && err.message ? err.message : String(err)];
    lines.push(
      `[远端预览] 已建立 SSH 端口转发：远端 ${forward.remoteHost}:${forward.remotePort} → ` +
        `本机 ${forward.localHost}:${forward.localPort}${forward.reused ? '（复用已有转发）' : ''}`
    );
    let probe = null;
    try {
      if (portForwardManager && typeof portForwardManager.probeHttp === 'function') {
        probe = await portForwardManager.probeHttp({
          host: forward.localHost,
          port: forward.localPort
        });
      }
    } catch {
      probe = null;
    }
    const probeText = describePreviewProbe(probe);
    if (probeText) lines.push(`[远端预览] ${probeText}`);
    // 通道级错误是"远端到底有没有服务"的直接证据（浏览器侧只会看到连接被关闭）
    let health = null;
    try {
      if (portForwardManager && typeof portForwardManager.getForward === 'function' && forward.id) {
        health = portForwardManager.getForward(forward.id);
      }
    } catch {
      health = null;
    }
    if (health && !health.alive) {
      lines.push('[远端预览] 该转发已失效（SSH 已断开），下次导航会自动重建');
    } else if (health && health.lastChannelError) {
      lines.push(`[远端预览] SSH 通道错误：${health.lastChannelError}`);
    }
    const wrapped = new Error(lines.join('\n'));
    if (err && err.code) wrapped.code = err.code;
    return wrapped;
  }

  return {
    'browser.navigate': async ({ url, engine, waitUntil, timeoutMs, sessionId }) => {
      assertBrowserEnabled();
      const safeUrl = await resolveBrowserNavigateUrl(url, {
        allowedRoots: readRootsForCall(),
        defaultCwd: cwdForCall() || defaultCwd
      });
      let preview = null;
      let previewError = '';
      try {
        preview = await rewriteForRemotePreview(safeUrl);
      } catch (e) {
        previewError = e && e.message ? e.message : String(e);
      }
      let result;
      try {
        result = await browser.navigate(preview && !preview.skipped ? preview.url : safeUrl, {
          engine,
          waitUntil,
          timeoutMs,
          sessionId
        });
      } catch (e) {
        throw await augmentPreviewFailure(e, preview);
      }
      if (!preview || preview.skipped) {
        // 远端预览候选却建不了转发（SSH 断开等）：把原因回传给模型，避免它反复盲试
        const reason = preview && preview.skipped ? preview.reason : previewError;
        return reason ? { ...result, previewForwardError: reason } : result;
      }
      return {
        ...result,
        displayUrl: preview.requestedUrl,
        previewForward: preview.forward,
        note: [result && result.note, preview.note].filter(Boolean).join('；')
      };
    },

    'browser.reload': async ({ engine, waitUntil, timeoutMs, sessionId }) => {
      assertBrowserEnabled();
      return browser.reload({ engine, waitUntil, timeoutMs, sessionId });
    },

    'browser.back': async ({ engine, waitUntil, timeoutMs, sessionId }) => {
      assertBrowserEnabled();
      return browser.goBack({ engine, waitUntil, timeoutMs, sessionId });
    },

    'browser.forward': async ({ engine, waitUntil, timeoutMs, sessionId }) => {
      assertBrowserEnabled();
      return browser.goForward({ engine, waitUntil, timeoutMs, sessionId });
    },

    'browser.import_storage': async (params) => {
      assertBrowserEnabled();
      return browser.importStorage(params || {});
    },

    'browser.export_storage': async (params) => {
      assertBrowserEnabled();
      return browser.exportStorage(params || {});
    },

    'browser.cookies': async (params) => {
      assertBrowserEnabled();
      return browser.cookies(params || {});
    },

    'browser.dialog': async (params) => {
      assertBrowserEnabled();
      return browser.dialog(params || {});
    },

    'browser.route': async (params) => {
      assertBrowserEnabled();
      return browser.route(params || {});
    },

    'browser.emulate': async (params) => {
      assertBrowserEnabled();
      return browser.emulate(params || {});
    },

    'browser.har_export': async (params = {}) => {
      assertBrowserEnabled();
      // text 只用来落盘，不进模型上下文
      const { text, ...rest } = await browser.exportHar({ ...params, filePath: '' });
      const saved = await writeArtifact(params.filePath, text, 'utf8', 'har', 'dieyun-network');
      return {
        ...rest,
        ...saved,
        note: 'HAR 仅含方法与状态摘要（无请求/响应头与 body）；可用浏览器 DevTools 打开。'
      };
    },

    'browser.pdf': async (params = {}) => {
      assertBrowserEnabled();
      // base64 只用来落盘，不进模型上下文（动辄上百 KB）
      const { base64, ...rest } = await browser.pdf({ ...params, filePath: '' });
      const saved = await writeArtifact(params.filePath, base64, 'base64', 'pdf', 'dieyun-page');
      return {
        ...rest,
        ...saved,
        note: 'PDF 已保存到 path；需要内容时用 fs_read_file（base64）或 PDF 技能解析该文件。'
      };
    },

    'browser.evaluate': async (params = {}) => {
      assertBrowserEnabled();
      return browser.evaluate(params || {});
    },

    'browser.snapshot': async ({ interactive, maxElements, engine, delayMs, sessionId, mode, frame }) => {
      assertBrowserEnabled();
      return browser.snapshot({ interactive, maxElements, engine, delayMs, sessionId, mode, frame });
    },

    'browser.frames': async (params = {}) => {
      assertBrowserEnabled();
      return browser.frames(params || {});
    },

    'browser.timeline': async (params = {}) => {
      assertBrowserEnabled();
      return browser.timeline(params || {});
    },

    'browser.expect': async (params = {}) => {
      assertBrowserEnabled();
      return browser.expect(params || {});
    },

    'browser.visual_diff': async (params = {}) => {
      assertBrowserEnabled();
      const p = params || {};
      // 基准是「需要先读回来」的产物，路径只能在这里定：service 不知道工作区是本地还是 SSH，
      // 自己解析路径就会拿本地白名单去校验远程路径。
      const engine = browser.resolveEngine(p);
      // 引擎标记编进文件名：换引擎就换文件，「拿 A 引擎的基准跟 B 引擎比」无从发生，
      // 因此不再需要 .meta.json 记录引擎。
      const baselineRef = withEngineTag(
        ensureExtension(String(p.baselinePath || '').trim() || defaultBaselineName(p), 'png'),
        engine
      );
      // reset 明确要重建基准，不必先把旧的读回来
      const baseline =
        p.reset === true
          ? { path: resolveArtifactPath(baselineRef).path, buffer: null }
          : await readArtifactIfExists(baselineRef);

      const raw = await browser.visualDiff({
        ...p,
        baselinePath: baseline.path,
        baselineBuffer: baseline.buffer
      });
      // 图像只用来落盘，不进模型上下文（动辄上百 KB）
      const { baselinePng, diffPng, ...rest } = raw || {};
      const out = { ...rest };
      if (baselinePng) {
        out.baselinePath = (
          await writeArtifact(baselineRef, baselinePng, 'base64', 'png', 'dieyun-visual-baseline')
        ).path;
      }
      if (diffPng) {
        out.diffPath = (
          await writeArtifact(p.filePath, diffPng, 'base64', 'png', 'dieyun-visual-diff')
        ).path;
      }
      return out;
    },

    'browser.click': async (params) => {
      assertBrowserEnabled();
      return browser.click(params || {});
    },

    'browser.type': async (params) => {
      assertBrowserEnabled();
      return browser.type(params || {});
    },

    'browser.fill': async (params) => {
      assertBrowserEnabled();
      return browser.fill(params || {});
    },

    'browser.select_option': async (params) => {
      assertBrowserEnabled();
      return browser.selectOption(params || {});
    },

    'browser.hover': async (params) => {
      assertBrowserEnabled();
      return browser.hover(params || {});
    },

    'browser.drag': async (params) => {
      assertBrowserEnabled();
      return browser.drag(params || {});
    },

    'browser.configure': async (params) => {
      assertBrowserEnabled();
      return browser.configure(params || {});
    },

    'browser.viewport': async (params) => {
      assertBrowserEnabled();
      return browser.setViewport(params || {});
    },

    'browser.a11y_snapshot': async (params) => {
      assertBrowserEnabled();
      return browser.a11ySnapshot(params || {});
    },

    'browser.network': async (params) => {
      assertBrowserEnabled();
      return browser.network(params || {});
    },

    'browser.console': async (params) => {
      assertBrowserEnabled();
      return browser.consoleMessages(params || {});
    },

    // 必须带 sessionId：只清本会话的缓冲，否则会把别的会话（前台可见页面）的请求与日志一起清掉
    'browser.reset_logs': async (params) => {
      assertBrowserEnabled();
      return browser.resetLogs(params || {});
    },

    'browser.scroll': async (params) => {
      assertBrowserEnabled();
      return browser.scroll(params || {});
    },

    'browser.press_key': async (params) => {
      assertBrowserEnabled();
      return browser.pressKey(params || {});
    },

    'browser.screenshot': async (params = {}) => {
      assertBrowserEnabled();
      // 先让浏览器把 PNG 留在内存：base64 照常回传（截图视觉注入走它），落盘只是可选留证
      const shot = await browser.screenshot({ ...params, filePath: '' });
      if (!shot || !shot.base64 || !params.filePath) return shot;
      return { ...shot, ...(await writeArtifact(params.filePath, shot.base64, 'base64', 'png', 'dieyun-screenshot')) };
    },

    'browser.wait_for': async (params) => {
      assertBrowserEnabled();
      return browser.waitFor(params || {});
    },

    'browser.tabs': async (params) => {
      assertBrowserEnabled();
      const next = { ...(params || {}) };
      // 新标签打开远端本机地址时同样需要转发改写；其它输入（工作区相对路径等）保持原样
      if (next.url && typeof parseRemotePreviewTarget === 'function' && parseRemotePreviewTarget(next.url)) {
        try {
          const preview = await rewriteForRemotePreview(next.url);
          if (preview && !preview.skipped) next.url = preview.url;
        } catch {
          // 尽力而为：转发失败仍按原地址打开，由浏览器侧报连接错误
        }
      }
      return browser.tabs(next);
    },

    'browser.downloads': async (params) => {
      assertBrowserEnabled();
      return browser.downloads(params || {});
    },

    'browser.upload_file': async (params = {}) => {
      assertBrowserEnabled();
      // 浏览器跑在本机，上传的只能是**本机**文件：SSH 会话里远端路径必须先落到本机，
      // 所以这里不接受远端路径 —— 明说，而不是把它当相对路径拼成越界后报 PATH_NOT_ALLOWED。
      const t = params.filePath ? resolveFsTarget(params.filePath) : null;
      if (t && t.remote) {
        const e = new Error(
          `浏览器在本机，不能直接上传远端主机上的文件：${t.path}`
        );
        e.code = 'BROWSER_UPLOAD_LOCAL_ONLY';
        e.retryable = false;
        e.suggestedFix =
          '本机文件用 local: 绝对路径（例 local:C:\\Users\\me\\a.pdf）—— 相对路径在 SSH 会话里有歧义，' +
          '无法判断你要的是本机的还是远端的。要上传远端文件：先用 host_exec（local=true 时在本机）把它取到本机。';
        throw e;
      }
      const filePath = t
        ? assertAllowedPath(
            normalizeFilePathInput(t.path, t.base || defaultCwd),
            Array.from(new Set([...roots, ...writable]))
          )
        : '';
      return browser.uploadFile({ ...params, filePath });
    },

    'browser.observe': async (params) => {
      assertBrowserEnabled();
      return browser.observe(params || {});
    },

    'browser.status': async () => {
      assertBrowserEnabled();
      return browser.status();
    },

    'browser.close': async () => {
      assertBrowserEnabled();
      return browser.close();
    },
  };
}

module.exports = { createBrowserHandlers };

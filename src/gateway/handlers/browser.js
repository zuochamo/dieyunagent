'use strict';

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
    writable
  } = d;

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
      const filePath = params.filePath
        ? assertAllowedPath(
            normalizeFilePathInput(params.filePath, defaultCwd),
            Array.from(new Set([...roots, ...writable]))
          )
        : '';
      return browser.exportHar({ ...params, filePath });
    },

    'browser.pdf': async (params = {}) => {
      assertBrowserEnabled();
      const filePath = params.filePath
        ? assertAllowedPath(
            normalizeFilePathInput(params.filePath, defaultCwd),
            Array.from(new Set([...roots, ...writable]))
          )
        : '';
      return browser.pdf({ ...params, filePath });
    },

    'browser.evaluate': async (params = {}) => {
      assertBrowserEnabled();
      return browser.evaluate(params || {});
    },

    'browser.snapshot': async ({ interactive, maxElements, engine, delayMs, sessionId }) => {
      assertBrowserEnabled();
      return browser.snapshot({ interactive, maxElements, engine, delayMs, sessionId });
    },

    'browser.expect': async (params = {}) => {
      assertBrowserEnabled();
      return browser.expect(params || {});
    },

    'browser.visual_diff': async (params = {}) => {
      assertBrowserEnabled();
      const withPath = (input) =>
        input
          ? assertAllowedPath(
              normalizeFilePathInput(input, defaultCwd),
              Array.from(new Set([...roots, ...writable]))
            )
          : '';
      return browser.visualDiff({
        ...(params || {}),
        baselinePath: withPath(params && params.baselinePath),
        filePath: withPath(params && params.filePath)
      });
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

    'browser.reset_logs': async () => {
      assertBrowserEnabled();
      return browser.resetLogs();
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
      // 与 pdf / har_export 一致：落盘路径必须走工作空间白名单，否则模型可写任意绝对路径
      const filePath = params.filePath
        ? assertAllowedPath(
            normalizeFilePathInput(params.filePath, defaultCwd),
            Array.from(new Set([...roots, ...writable]))
          )
        : '';
      return browser.screenshot({ ...params, filePath });
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
      const filePath = params.filePath
        ? assertAllowedPath(normalizeFilePathInput(params.filePath, defaultCwd), Array.from(new Set([...roots, ...writable])))
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

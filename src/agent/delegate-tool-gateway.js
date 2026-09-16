'use strict';

const { normalizeAgentToolName } = require('./tool-guardrails');
const { fsEditArgsPresent } = require('./guardrails-shared');
const { applyPatchUnsupported } = require('./tool-validate');

function resolveFsReadMaxBytes(args, ctx) {
  const explicit = Number(args && args.maxBytes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  try {
    const { getAgentLimits } = require('./agent-limits');
    const n = Number(
      (getAgentLimits(ctx && ctx.userDataPath, ctx && ctx.contextTierId) || {}).fsReadDefaultMaxBytes
    );
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* defaults */
  }
  return 65536;
}

/**
 * Main 进程：将 agent 工具名映射到 Gateway RPC（Rust loop delegate 用）。
 * @param {{ invokeRpc: Function } | null} gateway
 * @param {string} name
 * @param {object} args
 * @param {{ workspacePath?: string, worktreePath?: string }} [ctx]
 */
async function delegateAgentToolViaGateway(gateway, name, args, ctx = {}) {
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪');
  }
  const norm = normalizeAgentToolName(name, args);
  name = norm.name;
  const a = { ...(norm.args || {}) };
  const wt = ctx.worktreePath || '';
  const ws = ctx.workspacePath || '';

  function withRunWorkspace(params) {
    const out = { ...(params || {}) };
    if (ws) out.runWorkspaceRoot = ws;
    if (ctx.sessionId) out.sessionId = String(ctx.sessionId);
    return out;
  }

  function resolvePath(p) {
    if (p == null) return p;
    const fp = String(p);
    if (/^[a-zA-Z]:[\\/]/.test(fp) || fp.startsWith('\\\\')) return fp;
    const base = wt || ws;
    if (!base || /^ssh:\/\//i.test(String(base))) return fp;
    const sep = base.includes('\\') ? '\\' : '/';
    return `${base.replace(/[\\/]+$/, '')}${sep}${fp.replace(/^\.?[\\/]/, '')}`;
  }

  function resolveExecCwd(explicit) {
    if (explicit) return explicit;
    if (wt) return wt;
    const w = ws ? String(ws).trim() : '';
    if (!w || /^ssh:\/\//i.test(w)) return undefined;
    return w;
  }

  function browserRpc(method, params) {
    return gateway.invokeRpc(method, withRunWorkspace(params || {}));
  }

  switch (name) {
    case 'host_open_url':
      return gateway.invokeRpc('host.open_url', { url: a.url });
    case 'host_print_image':
      return gateway.invokeRpc('host.print_image', withRunWorkspace({ filePath: resolvePath(a.filePath) }));
    case 'host_exec':
      return gateway.invokeRpc(
        'host.exec',
        withRunWorkspace({
          command: a.command,
          cwd: resolveExecCwd(a.cwd),
          detached: !!a.detached,
          timeoutMs: a.timeoutMs,
          runId: ctx.runId || undefined,
          sessionId: ctx.sessionId || undefined
        })
      );
    case 'fs_read_file':
      return gateway.invokeRpc(
        'fs.read_file',
        withRunWorkspace({
          filePath: resolvePath(a.filePath),
          encoding: a.encoding || 'utf8',
          offset: a.offset,
          maxBytes: resolveFsReadMaxBytes(a, ctx)
        })
      );
    case 'fs_write_file':
      if (a.content == null || typeof a.content !== 'string') {
        return { error: 'fs_write_file 缺少有效 content（字符串）' };
      }
      return gateway.invokeRpc(
        'fs.write_file',
        withRunWorkspace({
          filePath: resolvePath(a.filePath),
          data: a.content,
          undoSessionId: ctx.sessionId || undefined,
          undoTurnId: ctx.undoTurnId || undefined
        })
      );
    case 'fs_edit': {
      const { hasLegacy, hasEdits, oldString, newString } = fsEditArgsPresent(a);
      if (!hasLegacy && !hasEdits) {
        return { error: 'fs_edit 缺少 oldString 或 edits' };
      }
      const payload = withRunWorkspace({
        filePath: resolvePath(a.filePath || a.path),
        replaceAll: a.replaceAll === true || a.replace_all === true,
        undoSessionId: ctx.sessionId || undefined,
        undoTurnId: ctx.undoTurnId || undefined
      });
      if (hasLegacy) {
        payload.oldString = oldString;
        payload.newString = newString;
      }
      if (hasEdits) payload.edits = a.edits;
      return gateway.invokeRpc('fs.edit_file', payload);
    }
    case 'fs_list_dir':
      return gateway.invokeRpc(
        'fs.list_dir',
        withRunWorkspace({ dirPath: resolvePath(a.dirPath) })
      );
    case 'grep':
      return gateway.invokeRpc(
        'fs.grep',
        withRunWorkspace({
          pattern: a.pattern,
          glob: a.glob,
          path: a.path,
          regex: a.regex === true,
          caseInsensitive: a.caseInsensitive === true || a.case_insensitive === true,
          context: a.context,
          beforeContext: a.beforeContext != null ? a.beforeContext : a.before_context,
          afterContext: a.afterContext != null ? a.afterContext : a.after_context,
          multiline: a.multiline === true,
          type: a.type || a.fileType || a.file_type,
          count: a.count === true,
          maxResults: a.maxResults || a.limit
        })
      );
    case 'read_symbol': {
      const fp = a.filePath || a.file_path || a.path;
      return gateway.invokeRpc(
        'fs.read_symbol',
        withRunWorkspace({
          filePath: fp ? resolvePath(fp) : undefined,
          name: a.name || a.symbol || a.query || a.symbolName,
          line: a.line,
          maxLines: a.maxLines || a.max_lines
        })
      );
    }
    case 'glob':
      return gateway.invokeRpc(
        'fs.glob',
        withRunWorkspace({
          pattern: a.pattern,
          maxResults: a.maxResults || a.limit
        })
      );
    case 'lsp': {
      const op = a.operation || a.op;
      // workspaceSymbol 是纯名字查询，path 可能是工作区而非文件，不搬运
      const fp = a.filePath || a.file_path || (op === 'workspaceSymbol' ? null : a.path);
      const params = {
        operation: op,
        line: a.line,
        character: a.character != null ? a.character : a.column != null ? a.column : a.col,
        query: a.query != null ? a.query : a.symbol || a.name
      };
      if (fp != null && String(fp).trim()) params.filePath = resolvePath(fp);
      return gateway.invokeRpc('lsp.query', withRunWorkspace(params));
    }
    case 'web_fetch':
      return gateway.invokeRpc('web.fetch', { url: a.url, maxChars: a.maxChars });
    case 'web_search':
      return gateway.invokeRpc('web.search', {
        query: a.query,
        engine: a.engine,
        maxChars: a.maxChars
      });
    case 'codebase_search':
      return gateway.invokeRpc(
        'codebase.search',
        withRunWorkspace({
          query: a.query,
          limit: a.limit,
          workspaceRoot: a.workspaceRoot || ws || wt || undefined,
          autoIndex: false
        })
      );
    case 'graph': {
      const op = String(a.operation || a.op || '').trim();
      const wr = a.workspaceRoot || ws || wt || undefined;
      if (op === 'module_deps') {
        return gateway.invokeRpc(
          'graph.module_deps',
          withRunWorkspace({
            path: a.path,
            depth: a.depth,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'find_symbol') {
        return gateway.invokeRpc(
          'graph.symbol_search',
          withRunWorkspace({
            query: a.query,
            kind: a.kind,
            limit: a.limit,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'semantic_find') {
        return gateway.invokeRpc(
          'graph.symbol_semantic_search',
          withRunWorkspace({
            query: a.query,
            kind: a.kind,
            limit: a.limit,
            workspaceRoot: wr,
            autoIndex: false,
            autoEmbed: true
          })
        );
      }
      if (op === 'callers') {
        return gateway.invokeRpc(
          'graph.callers',
          withRunWorkspace({
            path: a.path,
            name: a.name,
            symbolId: a.symbolId,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'callees') {
        return gateway.invokeRpc(
          'graph.callees',
          withRunWorkspace({
            path: a.path,
            name: a.name,
            symbolId: a.symbolId,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'impact') {
        return gateway.invokeRpc(
          'graph.impact',
          withRunWorkspace({
            path: a.path,
            depth: a.depth,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'lsp_callers') {
        return gateway.invokeRpc(
          'graph.lsp_resolve',
          withRunWorkspace({
            path: a.path,
            name: a.name,
            symbolId: a.symbolId,
            persist: a.persist,
            workspaceRoot: wr
          })
        );
      }
      return { error: `未知 graph.operation: ${op || '(空)'}` };
    }
    case 'browser_navigate':
      return browserRpc('browser.navigate', {
        url: a.url,
        engine: a.engine,
        waitUntil: a.waitUntil
      });
    case 'browser_reload':
      return browserRpc('browser.reload', {
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_back':
      return browserRpc('browser.back', {
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_forward':
      return browserRpc('browser.forward', {
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_import_storage':
      return browserRpc('browser.import_storage', {
        cookies: a.cookies,
        localStorage: a.localStorage,
        engine: a.engine
      });
    case 'browser_snapshot':
      return browserRpc('browser.snapshot', {
        interactive: a.interactive !== false,
        engine: a.engine,
        delayMs: a.delayMs
      });
    case 'browser_a11y_snapshot':
      return browserRpc('browser.a11y_snapshot', {
        maxNodes: a.maxNodes,
        delayMs: a.delayMs,
        engine: a.engine
      });
    case 'browser_network':
      return browserRpc('browser.network', {
        action: a.action,
        limit: a.limit,
        urlPattern: a.urlPattern,
        errorsOnly: a.errorsOnly,
        sinceMs: a.sinceMs,
        engine: a.engine
      });
    case 'browser_console':
      return browserRpc('browser.console', {
        action: a.action,
        limit: a.limit,
        level: a.level,
        errorsOnly: a.errorsOnly,
        urlPattern: a.urlPattern,
        sinceMs: a.sinceMs,
        engine: a.engine
      });
    case 'browser_click':
      return browserRpc('browser.click', {
        ref: a.ref,
        selector: a.selector,
        button: a.button,
        clickCount: a.clickCount,
        engine: a.engine
      });
    case 'browser_double_click':
      return browserRpc('browser.click', {
        ref: a.ref,
        selector: a.selector,
        clickCount: 2,
        engine: a.engine
      });
    case 'browser_right_click':
      return browserRpc('browser.click', {
        ref: a.ref,
        selector: a.selector,
        button: 'right',
        engine: a.engine
      });
    case 'browser_type':
      return browserRpc('browser.type', {
        ref: a.ref,
        selector: a.selector,
        text: a.text,
        clear: a.clear,
        engine: a.engine
      });
    case 'browser_fill':
      return browserRpc('browser.fill', {
        ref: a.ref,
        selector: a.selector,
        text: a.text,
        engine: a.engine
      });
    case 'browser_select_option':
      return browserRpc('browser.select_option', {
        ref: a.ref,
        selector: a.selector,
        value: a.value,
        label: a.label,
        engine: a.engine
      });
    case 'browser_hover':
      return browserRpc('browser.hover', { ref: a.ref, selector: a.selector, engine: a.engine });
    case 'browser_drag':
      return browserRpc('browser.drag', {
        ref: a.ref,
        selector: a.selector,
        toRef: a.toRef,
        toSelector: a.toSelector,
        dx: a.dx,
        dy: a.dy,
        engine: a.engine
      });
    case 'browser_scroll':
      return browserRpc('browser.scroll', {
        direction: a.direction,
        amount: a.amount,
        ref: a.ref,
        selector: a.selector,
        engine: a.engine
      });
    case 'browser_press_key':
      return browserRpc('browser.press_key', {
        key: a.key,
        modifiers: a.modifiers,
        engine: a.engine
      });
    case 'browser_screenshot':
      return browserRpc('browser.screenshot', {
        ref: a.ref,
        selector: a.selector,
        fullPage: a.fullPage,
        filePath: a.filePath ? resolvePath(a.filePath) : undefined,
        engine: a.engine
      });
    case 'browser_viewport':
      return browserRpc('browser.viewport', {
        width: a.width,
        height: a.height,
        deviceScaleFactor: a.deviceScaleFactor,
        mobile: a.mobile,
        reset: a.reset,
        engine: a.engine
      });
    case 'browser_wait_for':
      return browserRpc('browser.wait_for', {
        kind: a.kind || a.type,
        value: a.value,
        selector: a.selector,
        text: a.text,
        url: a.url,
        state: a.state,
        engine: a.engine,
        timeoutMs: a.timeoutMs,
        intervalMs: a.intervalMs
      });
    case 'browser_tabs':
      return browserRpc('browser.tabs', {
        action: a.action,
        tabId: a.tabId,
        url: a.url,
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_downloads':
      return browserRpc('browser.downloads', { action: a.action, engine: a.engine, timeoutMs: a.timeoutMs });
    case 'browser_upload_file':
      return browserRpc('browser.upload_file', {
        ref: a.ref,
        selector: a.selector,
        filePath: resolvePath(a.filePath),
        mime: a.mime,
        engine: a.engine,
        timeoutMs: a.timeoutMs
      });
    case 'browser_evaluate':
      return browserRpc('browser.evaluate', {
        script: a.script,
        maxChars: a.maxChars,
        timeoutMs: a.timeoutMs,
        engine: a.engine
      });
    case 'browser_visual_diff':
      return browserRpc('browser.visual_diff', {
        baselinePath: a.baselinePath ? resolvePath(a.baselinePath) : undefined,
        filePath: a.filePath ? resolvePath(a.filePath) : undefined,
        ref: a.ref,
        selector: a.selector,
        threshold: a.threshold,
        fullPage: a.fullPage,
        reset: a.reset,
        engine: a.engine
      });
    case 'browser_expect':
      return browserRpc('browser.expect', {
        assertions: a.assertions,
        timeoutMs: a.timeoutMs,
        engine: a.engine
      });
    case 'browser_pdf':
      return browserRpc('browser.pdf', {
        filePath: a.filePath ? resolvePath(a.filePath) : undefined,
        format: a.format,
        landscape: a.landscape,
        printBackground: a.printBackground,
        engine: a.engine
      });
    case 'browser_export_storage':
      // 会话分区由 withRunWorkspace 注入当前 run 的 sessionId，无需模型传参
      return browserRpc('browser.export_storage', {
        cookies: a.cookies,
        localStorage: a.localStorage,
        url: a.url,
        engine: a.engine
      });
    case 'browser_cookies':
      return browserRpc('browser.cookies', {
        action: a.action,
        url: a.url,
        name: a.name,
        value: a.value,
        domain: a.domain,
        path: a.path,
        secure: a.secure,
        httpOnly: a.httpOnly,
        sameSite: a.sameSite,
        cookies: a.cookies,
        engine: a.engine
      });
    case 'browser_dialog':
      return browserRpc('browser.dialog', {
        action: a.action,
        accept: a.accept,
        promptText: a.promptText,
        policy: a.policy,
        engine: a.engine
      });
    case 'browser_route':
      return browserRpc('browser.route', {
        action: a.action,
        urlPattern: a.urlPattern,
        type: a.type,
        status: a.status,
        body: a.body,
        headers: a.headers,
        contentType: a.contentType,
        errorReason: a.errorReason,
        id: a.id,
        engine: a.engine
      });
    case 'browser_emulate':
      return browserRpc('browser.emulate', {
        action: a.action,
        geolocation: a.geolocation,
        timezone: a.timezone,
        locale: a.locale,
        permissions: a.permissions,
        engine: a.engine
      });
    case 'browser_har_export':
      return browserRpc('browser.har_export', {
        filePath: a.filePath ? resolvePath(a.filePath) : undefined,
        engine: a.engine
      });
    case 'browser_observe':
      return browserRpc('browser.observe', {
        interactive: a.interactive !== false,
        maxElements: a.maxElements,
        delayMs: a.delayMs,
        screenshot: a.screenshot !== false,
        fullPage: a.fullPage,
        engine: a.engine
      });
    case 'browser_status':
      return browserRpc('browser.status', {});
    case 'browser_close':
      return browserRpc('browser.close', {});
    default:
      if (name === 'apply_patch') {
        const blocked = applyPatchUnsupported();
        return { error: blocked.error, errorCode: blocked.errorCode, suggestedFix: blocked.suggestedFix };
      }
      if (name.startsWith('plugin_') || name.startsWith('sql_')) {
        return gateway.invokeRpc(
          'plugins.tool_call',
          withRunWorkspace({ name, arguments: a || {} })
        );
      }
      return { error: `未知工具: ${name}` };
  }
}

module.exports = {
  delegateAgentToolViaGateway,
  resolveFsReadMaxBytes
};

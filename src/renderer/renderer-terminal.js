/* global window, document, currentSessionId, isSidePanelOpen, getSidePanelTab, createTerminalScreen, isChatNearBottom */
'use strict';

const termApi = window.diecloud || {};
/** 显示层（terminal-screen.js）：唯一负责把 PTY 输出变成屏上文字 */
const terminalScreen = createTerminalScreen();
let terminalStarted = false;
/** 正在启动的那次调用（去重用）；terminalStartingSid 是它对应的会话 */
let terminalStarting = null;
/** @type {string | null} */
let terminalStartingSid = null;
let terminalFocused = false;
/** 本机 pipe shell 无 PTY 回显，需在 renderer 本地显示按键 */
let terminalLocalEcho = true;
/** 远端 PTY 自己回显，且只认 `\r` 为回车；本机 pipe 需要 `\r\n` */
let terminalRemote = false;
/** 输入法组字中：原始按键一律不转发，等 compositionend 整段发出去 */
let terminalComposing = false;
/** 断线提示只报一次，新会话建立时复位 */
let terminalDisconnected = false;
/** @type {string | null} */
let boundTerminalSessionId = null;
let terminalPaintQueued = false;

/** 终端按键 → 转义序列（终端通用惯例，非业务词表） */
const TERMINAL_KEY_SEQUENCES = {
  ArrowUp: '\u001b[A',
  ArrowDown: '\u001b[B',
  ArrowRight: '\u001b[C',
  ArrowLeft: '\u001b[D',
  Home: '\u001b[H',
  End: '\u001b[F',
  Delete: '\u001b[3~',
  PageUp: '\u001b[5~',
  PageDown: '\u001b[6~'
};

function getTerminalSessionId(sessionId) {
  if (sessionId != null && String(sessionId).trim()) return String(sessionId).trim();
  if (typeof currentSessionId !== 'undefined' && currentSessionId) return String(currentSessionId);
  return 'default';
}

function isTerminalTabActive() {
  if (typeof getSidePanelTab === 'function') return getSidePanelTab() === 'terminal';
  const pane = document.querySelector('.side-panel-pane[data-side-pane="terminal"]');
  return !!(pane && !pane.hidden);
}

function getTerminalOutputEl() {
  return document.getElementById('terminal-output');
}

/**
 * `<pre>` 固定为三段：光标前的正文文本节点、光标块、光标后的正文文本节点。
 * 光标块内容就是它压住的那个字符（反白显示），所以不会把后面的文本挤开。
 */
let terminalOutputNodes = null;

function ensureTerminalOutputNodes(out) {
  if (
    terminalOutputNodes &&
    terminalOutputNodes.out === out &&
    out.firstChild === terminalOutputNodes.before
  ) {
    return terminalOutputNodes;
  }
  out.textContent = '';
  const before = document.createTextNode('');
  const cursor = document.createElement('span');
  cursor.className = 'terminal-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  const after = document.createTextNode('');
  out.appendChild(before);
  out.appendChild(cursor);
  out.appendChild(after);
  terminalOutputNodes = { out, before, cursor, after };
  return terminalOutputNodes;
}

function paintTerminalOutput() {
  terminalPaintQueued = false;
  const out = getTerminalOutputEl();
  if (!out) return;
  // 先在改动前量：用户正在往回翻历史时不要把他拽回底部（阈值沿用聊天区的单一来源）
  const stickToBottom = typeof isChatNearBottom === 'function' ? isChatNearBottom(out) : true;
  const text = terminalScreen.text();
  const offset = Math.min(terminalScreen.cursorOffset(), text.length);
  const nodes = ensureTerminalOutputNodes(out);
  const under = text[offset];
  // 换行/制表符位置下光标另占一格（不换行空格），其余情况压在字符上
  const covered = under && under !== '\n' && under !== '\t' ? under : '\u00a0';
  nodes.before.data = text.slice(0, offset);
  nodes.cursor.textContent = covered;
  nodes.after.data = under === covered ? text.slice(offset + 1) : text.slice(offset);
  if (stickToBottom) out.scrollTop = out.scrollHeight;
}

/** 一帧只重绘一次：build / 日志跟随这种高频输出下逐块写 DOM 会拖垮渲染进程 */
function scheduleTerminalPaint() {
  if (terminalPaintQueued) return;
  terminalPaintQueued = true;
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(paintTerminalOutput);
    return;
  }
  paintTerminalOutput();
}

function appendTerminalOutput(text) {
  terminalScreen.write(text);
  scheduleTerminalPaint();
}

function clearTerminalOutput() {
  terminalScreen.clear();
  scheduleTerminalPaint();
}

function localEchoInput(text) {
  if (!terminalLocalEcho) return;
  appendTerminalOutput(String(text || ''));
}

function localEchoBackspace() {
  if (!terminalLocalEcho) return;
  appendTerminalOutput('\b \b');
}

function setTerminalMeta(text) {
  const meta = document.getElementById('terminal-meta');
  if (meta) meta.textContent = text || '';
}

/**
 * 会话真的没了（远端断开 / 退出 / 写入被拒）时的唯一收口。
 * 以前这里什么都不做：UI 继续显示「SSH · 用户@主机」，输入被静默丢弃，用户只能靠猜。
 * @param {string} reason
 */
function markTerminalDisconnected(reason) {
  terminalStarted = false;
  boundTerminalSessionId = null;
  setTerminalMeta('已断开');
  if (terminalDisconnected) return;
  terminalDisconnected = true;
  appendTerminalOutput(`\r\n[${reason}]\r\n`);
}

function applyTerminalStartMeta(r, effectiveCwd) {
  terminalLocalEcho = !(r && r.remote) && r?.localEcho !== false;
  terminalRemote = !!(r && r.remote);
  terminalDisconnected = false;
  if (r && r.remote) {
    setTerminalMeta(`SSH · ${r.username || ''}@${r.host || ''}`);
    if (!r.reattached) appendTerminalOutput(`# 远程 ${effectiveCwd || r.cwd || ''}\r\n\r\n`);
  } else {
    setTerminalMeta('本机 · 已连接');
    if (!r.reattached && effectiveCwd) appendTerminalOutput(`# ${effectiveCwd}\r\n\r\n`);
  }
}

async function detachTerminalForSession(sessionId) {
  const sid = getTerminalSessionId(sessionId);
  // 先改本地状态再发 IPC：等 IPC 回来才清，可能把刚起来的新会话又抹成「未启动 / 未绑定」
  if (boundTerminalSessionId === sid) {
    boundTerminalSessionId = null;
    terminalStarted = false;
  }
  if (termApi.terminalDetach) {
    await termApi.terminalDetach({ sessionId: sid }).catch(function () {});
  }
}

async function ensureTerminalSession(force, sessionId) {
  if (!termApi.terminalStart) return;
  const sid = getTerminalSessionId(sessionId);
  // 每次打开终端页 / 切会话都让 main 判一次：复用（reattached）还是换壳（工作区变了）。
  // 渲染端自己"已启动就不再问"会让旧 shell 粘住 —— 切到 SSH 工作区后终端还是本机。
  if (terminalStarting) {
    // 同一会话的重复请求直接复用；别的会话在启动时先等它落地，再起自己的 ——
    // 直接复用它的 promise 会让 A→B 快速切换时 B 永远不启动
    if (terminalStartingSid === sid && !force) return terminalStarting;
    await terminalStarting.catch(function () {});
  }
  // 先认领这次启动再发 IPC：main 在 attach 时就把缓冲输出推过来了，
  // 晚一步置位会把这段首屏输出当成「别的会话」过滤掉
  boundTerminalSessionId = sid;
  terminalStartingSid = sid;

  const mine = (async () => {
    setTerminalMeta('启动中…');
    try {
      if (force && termApi.terminalStop) {
        terminalStarted = false;
        clearTerminalOutput();
        await termApi.terminalStop({ sessionId: sid }).catch(function () {});
        await new Promise(function (resolve) {
          setTimeout(resolve, 80);
        });
      }
      // 工作区（本地/SSH、远端路径、cwd）由 main 按会话 id 解析，渲染端不再猜本地路径
      const r = await termApi.terminalStart({ sessionId: sid, force: !!force });
      const effectiveCwd = (r && r.cwd) || '';
      if (!r?.reattached) clearTerminalOutput();
      applyTerminalStartMeta(r, effectiveCwd);
      terminalStarted = true;
      boundTerminalSessionId = sid;
    } catch (e) {
      terminalStarted = false;
      if (boundTerminalSessionId === sid) boundTerminalSessionId = null;
      terminalLocalEcho = true;
      setTerminalMeta('启动失败');
      clearTerminalOutput();
      appendTerminalOutput('启动失败: ' + (e && e.message ? e.message : String(e)) + '\r\n');
    }
  })();
  terminalStarting = mine;

  try {
    await mine;
  } finally {
    // 只清自己那次：并发时后来的启动可能已经接管 terminalStarting
    if (terminalStarting === mine) {
      terminalStarting = null;
      terminalStartingSid = null;
    }
  }
}

async function writeTerminalInput(data) {
  if (!termApi.terminalWrite) return false;
  const sid = getTerminalSessionId(boundTerminalSessionId);
  if (!terminalStarted || boundTerminalSessionId !== sid) {
    await ensureTerminalSession(false, sid);
  }
  try {
    const r = await termApi.terminalWrite({ sessionId: sid, data: String(data || '') });
    if (r && r.ok === false) {
      markTerminalDisconnected(
        `会话已失效（${r.reason || 'no-session'}），输入未转发；点「重启」重建`
      );
      return false;
    }
    return true;
  } catch (e) {
    markTerminalDisconnected('终端写入失败: ' + (e && e.message ? e.message : String(e)));
    return false;
  }
}

/** 粘贴 / 输入法上屏：整段转发，并把换行归一成终端的回车 */
function forwardTerminalText(text) {
  const raw = String(text || '');
  if (!raw) return;
  const normalized = raw.replace(/\r\n?|\n/g, terminalRemote ? '\r' : '\r\n');
  localEchoInput(normalized);
  void writeTerminalInput(normalized);
}

function restartTerminalSession() {
  terminalStarted = false;
  if (typeof isSidePanelOpen === 'function' && isSidePanelOpen()) {
    ensureTerminalSession(true).catch(function () {});
  }
}

function focusTerminalSink() {
  const sink = document.getElementById('terminal-ime-sink');
  if (sink && typeof sink.focus === 'function') sink.focus({ preventScroll: true });
}

function handleTerminalKeydown(e) {
  if (!terminalFocused || !isTerminalTabActive()) return;
  if (!termApi.terminalWrite) return;
  // 输入法组字中（keydown 的 key 是 'Process'）：原始按键不能转发，否则拼音字母会打到远端
  if (e.isComposing || terminalComposing || e.keyCode === 229) return;
  // Ctrl+V 交给 paste 事件：这里若按 Ctrl+字母表发 0x16，会和粘贴重复
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;

  // AltGr（Windows 上报为 Ctrl+Alt）打出来的是可打印字符，必须先放行：
  // 德/波兰等键盘的 @ \ { } ~ | 全靠它，之前三个分支都不覆盖 → 字符被静默丢掉
  if (e.ctrlKey && e.altKey && !e.metaKey && e.key.length === 1) {
    e.preventDefault();
    localEchoInput(e.key);
    void writeTerminalInput(e.key);
    return;
  }

  // 行编辑 / 控制序列只有 PTY（SSH）认。本机是管道 stdio（session.js 用 stdio 管道、没有 PTY），
  // 发过去只会变成命令行里的垃圾：`\x1b[A` → `'←[A' 不是内部或外部命令`。
  if (terminalRemote) {
    const sequence = TERMINAL_KEY_SEQUENCES[e.key];
    if (sequence) {
      e.preventDefault();
      void writeTerminalInput(sequence);
      return;
    }
    // Ctrl+字母 → 控制码（Ctrl+C=0x03 … Ctrl+Z=0x1a），终端惯例
    if (e.ctrlKey && !e.altKey && e.key.length === 1) {
      const code = e.key.toLowerCase().charCodeAt(0);
      if (code >= 97 && code <= 122) {
        e.preventDefault();
        void writeTerminalInput(String.fromCharCode(code - 96));
        return;
      }
    }
    // Alt+字符 → ESC + 字符（readline 的按词移动）
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      void writeTerminalInput(`\u001b${e.key}`);
      return;
    }
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    // 远端 PTY 的回车就是 \r；本机 pipe 必须给 \r\n，否则 cmd 不收行
    const enter = terminalRemote ? '\r' : '\r\n';
    localEchoInput('\r\n');
    void writeTerminalInput(enter);
    return;
  }
  if (e.key === 'Backspace') {
    e.preventDefault();
    localEchoBackspace();
    void writeTerminalInput('\x7f');
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    localEchoInput('\t');
    void writeTerminalInput('\t');
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.altKey && !e.ctrlKey) {
    e.preventDefault();
    localEchoInput(e.key);
    void writeTerminalInput(e.key);
  }
}

/**
 * 隐藏 textarea 是输入法 / 粘贴的宿主：`<pre>` 不是可编辑元素，输入法根本不会组字，
 * 也不会派发 paste 事件。它只有 1×1 且 opacity:0（不能 display:none，否则同样失效）。
 */
function initTerminalInputSink(sink) {
  sink.addEventListener('compositionstart', function () {
    terminalComposing = true;
  });
  sink.addEventListener('compositionend', function (e) {
    terminalComposing = false;
    const text = e && e.data != null ? String(e.data) : '';
    sink.value = '';
    forwardTerminalText(text);
  });
  // 组字中途失焦（切会话 / 点别处）时 compositionend 可能不再来：卡在组字态会让按键永久失效
  sink.addEventListener('blur', function () {
    terminalComposing = false;
  });
  sink.addEventListener('paste', function (e) {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    e.preventDefault();
    sink.value = '';
    forwardTerminalText(text);
  });
  sink.addEventListener('input', function (e) {
    // 组字期间不能清空 textarea，否则输入法会中断
    if (terminalComposing) return;
    const value = sink.value;
    sink.value = '';
    // 键盘输入走 keydown 转发，这里只补「原生粘贴 / 拖入不走 paste 事件」的情况
    if (value && e && (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop')) {
      forwardTerminalText(value);
    }
  });
}

function initTerminalPane() {
  const wrap = document.getElementById('terminal-pane');
  const out = getTerminalOutputEl();
  const restartBtn = document.getElementById('terminal-restart');
  const sink = document.getElementById('terminal-ime-sink');
  if (!wrap || !out) return;

  if (termApi.onTerminalData) {
    termApi.onTerminalData(function (payload) {
      if (!payload || payload.data == null) return;
      const sid = payload.sessionId != null ? String(payload.sessionId) : '';
      const bound = getTerminalSessionId(boundTerminalSessionId);
      if (sid && bound && sid !== bound) return;
      appendTerminalOutput(String(payload.data));
    });
  }
  if (termApi.onTerminalExit) {
    termApi.onTerminalExit(function (payload) {
      const sid = payload && payload.sessionId != null ? String(payload.sessionId) : '';
      const bound = getTerminalSessionId(boundTerminalSessionId);
      if (sid && bound && sid !== bound) return;
      const code = payload && payload.code != null ? payload.code : '?';
      markTerminalDisconnected(`进程已退出 code=${code}`);
    });
  }

  if (sink) initTerminalInputSink(sink);

  // 真实焦点是唯一来源（以前只跟 mousedown：Tab 聚焦面板后打字无效，反过来程序化
  // 焦点转移之后终端还会继续吞键并转发到 shell）
  wrap.addEventListener('mousedown', function () {
    focusTerminalSink();
  });
  wrap.addEventListener('focusin', function (e) {
    if (sink && e.target !== sink) {
      // Tab 聚焦到面板时把焦点落到可编辑宿主上，否则输入法 / 粘贴拿不到
      focusTerminalSink();
      return;
    }
    terminalFocused = true;
    wrap.classList.add('focused');
  });
  wrap.addEventListener('focusout', function () {
    // 用定时器而不是 rAF：窗口最小化时 rAF 不跑，焦点状态会卡住
    setTimeout(function () {
      if (wrap.contains(document.activeElement)) return;
      terminalFocused = false;
      wrap.classList.remove('focused');
    }, 0);
  });

  document.addEventListener('keydown', handleTerminalKeydown, true);

  if (restartBtn) {
    restartBtn.addEventListener('click', function () {
      restartTerminalSession();
    });
  }

  wrap.setAttribute('tabindex', '0');
}

if (typeof window !== 'undefined') {
  window.detachTerminalForSession = detachTerminalForSession;
  window.ensureTerminalSession = ensureTerminalSession;
  window.restartTerminalSession = restartTerminalSession;
}

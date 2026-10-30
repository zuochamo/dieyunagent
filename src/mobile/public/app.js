(function () {
  const RECONNECT_MS = 3000;

  const state = {
    ws: null,
    authed: false,
    pending: new Map(),
    activeSessionId: '',
    activeRequestId: '',
    taskSessionId: '',
    sessions: [],
    drawerOpen: false,
    settingsOpen: false,
    touchStartX: 0,
    touchStartY: 0,
    traceVisible: false,
    traceManualClosed: false,
    traceSheetOpen: false,
    traceDockCompact: false,
    cachedLiveTrace: [],
    historicalTraceCache: new Map(),
    lastStreamContent: '',
    taskRunning: false,
    stopping: false,
    ignoreEdgeSwipe: false,
    version: '',
    traceTypewriters: new Map(),
    reconnectTimer: null,
    authFailed: false,
    stopReconnect: false,
    wsGeneration: 0,
    lastReconnectToastAt: 0,
    sessionListRefreshTimer: null
  };

  /** 每帧追加字符数（刷屏模式） */
  const TRACE_TYPE_CHARS_PER_TICK = 14;
  /** 打字机 tick 间隔 ms */
  const TRACE_TYPE_TICK_MS = 6;
  /** 落后超过此长度才跳段追赶 */
  const TRACE_TYPE_LAG_SKIP = 2200;
  /** 距底部小于该值视为「跟随最新」 */
  const FOLLOW_BOTTOM_SLACK_PX = 96;

  const $ = (id) => document.getElementById(id);
  const I18N_KEY = 'dieyun.mobile.language';
  const TRACE_ROUND_TITLES_KEY = 'dieyun.mobile.traceRoundTitles';
  const I18N = {
    'zh-CN': {
      connecting: '连接中',
      connected: '已连接电脑',
      disconnected: '未连接',
      sessions: '会话',
      sessions_hint: '右滑打开，左滑收起',
      refresh_sessions: '刷新会话',
      settings: '设置',
      settings_hint: '左滑打开，右滑收起',
      theme: '主题',
      dark: '黑色',
      light: '白色',
      language: '语言',
      zh: '中文',
      en: 'English',
      connection: '连接',
      reconnect: '重连',
      change_computer: '换电脑',
      check_update: '检查更新',
      sync_after_connect: '连接电脑端后同步会话',
      thoughts: '思考过程',
      thoughts_short: '思考',
      view_thoughts: '查看过程',
      trace_rounds: '思考过程 · {n} 轮',
      trace_round_titles: '显示「第 N 轮」标题',
      collapse: '收起',
      input_placeholder: '输入任务，电脑端执行',
      stop: '停止',
      send: '发送',
      voice_title: '语音输入',
      voice_recording_hint: '正在录音… 点「转写」结束',
      voice_transcribing: '正在转写…',
      voice_cancel: '取消',
      voice_transcribe: '转写',
      voice_task_busy: '任务执行中，请稍后再试',
      voice_mic_unsupported: '当前环境不支持麦克风',
      voice_mic_denied: '无法访问麦克风',
      voice_record_failed: '录音失败',
      voice_transcribe_failed: '语音转写失败',
      no_sessions: '暂无会话',
      conversation: '对话',
      default_workspace: '默认工作空间',
      no_messages: '这条会话还没有消息',
      you: '你',
      agent: '叠云AI',
      running: '执行中',
      connection_failed: '连接失败',
      reconnecting: '连接断开，正在重连',
      scan_again: '请重新扫码连接电脑',
      auth_failed: '配对已失效，请重新扫码连接',
      task_executing: '电脑端执行中',
      task_complete: '任务完成',
      task_stopped_msg: '任务已停止',
      task_failed: '任务失败',
      missing_token: '缺少配对 token',
      update_check_unsupported: '当前环境不支持 App 更新检测',
      stopping: '正在停止…',
      not_connected: '未连接电脑端',
      camera_capturing: '叠云正在拍一张…',
      camera_unsupported: '当前环境不能拍照：请用叠云 App 打开，或在 https 页面里使用',
      tts_read: '朗读',
      tts_stop: '停止',
      tts_failed: '朗读失败',
      tts_no_model: '电脑端还没配置「语音合成」模型',
      app_title: '叠云AI'
    },
    en: {
      connecting: 'Connecting',
      connected: 'Connected',
      disconnected: 'Disconnected',
      sessions: 'Conversations',
      sessions_hint: 'Swipe right to open, left to close',
      refresh_sessions: 'Refresh conversations',
      settings: 'Settings',
      settings_hint: 'Swipe left to open, right to close',
      theme: 'Theme',
      dark: 'Dark',
      light: 'Light',
      language: 'Language',
      zh: '中文',
      en: 'English',
      connection: 'Connection',
      reconnect: 'Reconnect',
      change_computer: 'Change computer',
      check_update: 'Check update',
      sync_after_connect: 'Connect to sync conversations',
      thoughts: 'Thought process',
      thoughts_short: 'Thoughts',
      view_thoughts: 'View process',
      trace_rounds: 'Thought process · {n} rounds',
      trace_round_titles: 'Show round titles',
      collapse: 'Collapse',
      input_placeholder: 'Type a task; the computer will execute it',
      stop: 'Stop',
      send: 'Send',
      voice_title: 'Voice input',
      voice_recording_hint: 'Recording… tap Transcribe when done',
      voice_transcribing: 'Transcribing…',
      voice_cancel: 'Cancel',
      voice_transcribe: 'Transcribe',
      voice_task_busy: 'Task running, try again later',
      voice_mic_unsupported: 'Microphone not supported',
      voice_mic_denied: 'Microphone access denied',
      voice_record_failed: 'Recording failed',
      voice_transcribe_failed: 'Transcription failed',
      no_sessions: 'No conversations',
      conversation: 'Conversation',
      default_workspace: 'Default workspace',
      no_messages: 'No messages in this conversation yet',
      you: 'You',
      agent: 'Dieyun AI',
      running: 'Running',
      connection_failed: 'Connection failed',
      reconnecting: 'Disconnected, reconnecting',
      scan_again: 'Scan the computer QR code again',
      auth_failed: 'Pairing expired. Scan the computer QR code again.',
      task_executing: 'Running on computer',
      task_complete: 'Task completed',
      task_stopped_msg: 'Task stopped',
      task_failed: 'Task failed',
      missing_token: 'Missing pairing token',
      update_check_unsupported: 'In-app update check is not available here',
      stopping: 'Stopping…',
      not_connected: 'Not connected to computer',
      camera_capturing: 'Dieyun is taking a photo…',
      camera_unsupported: 'Camera unavailable here: open this in the Dieyun app, or use an https page',
      tts_read: 'Read aloud',
      tts_stop: 'Stop',
      tts_failed: 'Read-aloud failed',
      tts_no_model: 'No "Speech synthesis" model configured on the computer',
      app_title: 'Dieyun AI'
    }
  };

  function normalizeLang(lang) {
    return lang === 'en' ? 'en' : 'zh-CN';
  }

  function getLang() {
    return normalizeLang(localStorage.getItem(I18N_KEY));
  }

  function t(key) {
    const lang = getLang();
    return I18N[lang][key] || I18N['zh-CN'][key] || key;
  }

  function applyLanguage(lang) {
    const next = normalizeLang(lang);
    localStorage.setItem(I18N_KEY, next);
    document.documentElement.lang = next;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });
    document.querySelectorAll('.language-choice').forEach((btn) => {
      btn.classList.toggle('active', normalizeLang(btn.dataset.language) === next);
    });
    if (state.authed && state.activeSessionId) {
      void reloadConversationUi().catch(() => {});
    }
  }

  function tokenFromLocation() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(location.search);
    return hash.get('token') || query.get('token') || localStorage.getItem('dieyun.mobile.token') || '';
  }

  function showInAppToast(body) {
    const text = String(body || '').trim();
    if (!text) return;
    let el = document.getElementById('voice-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'voice-toast';
      el.className = 'voice-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showInAppToast._timer);
    showInAppToast._timer = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }

  function setStatus(text, isError) {
    const msg = String(text || '').trim();
    if (!msg) return;
    if (msg === t('connected')) return;
    const quiet = new Set([t('running'), t('task_executing'), t('stop'), t('refresh_sessions')]);
    if (!isError && quiet.has(msg)) return;
    if (isError && msg === t('reconnecting')) {
      const now = Date.now();
      if (now - state.lastReconnectToastAt < 8000) return;
      state.lastReconnectToastAt = now;
    }
    showInAppToast(msg);
  }

  function showToast(title, message) {
    const body = String(message || title || '').trim();
    if (!body) return;
    if (window.DieyunApp && typeof window.DieyunApp.notify === 'function') {
      try {
        window.DieyunApp.notify(String(title || t('app_title')), body);
        return;
      } catch {
        // fall through
      }
    }
    showInAppToast(body);
  }

  function rejectAllPending(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || t('disconnected')));
    for (const box of state.pending.values()) {
      try {
        box.reject(err);
      } catch {
        // ignore
      }
    }
    state.pending.clear();
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function teardownWs(ws, { scheduleReconnect = false } = {}) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // ignore
    }
    if (state.ws === ws) state.ws = null;
    state.authed = false;
    rejectAllPending(new Error(t('disconnected')));
    if (scheduleReconnect && !state.stopReconnect && !state.authFailed) {
      clearReconnectTimer();
      state.reconnectTimer = setTimeout(connect, RECONNECT_MS);
      setStatus(t('reconnecting'), true);
    }
  }

  function isTaskRunning() {
    return !!state.taskRunning;
  }

  function timeLocale() {
    return getLang() === 'en' ? 'en-US' : 'zh-CN';
  }

  function shortTime(ts) {
    const d = new Date(ts || Date.now());
    const now = new Date();
    const locale = timeLocale();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay
      ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
  }

  function traceRoundLabel(entry, index) {
    if (entry.phase) return entry.phase;
    const n = entry.round || index + 1;
    return getLang() === 'en' ? `Round ${n}` : `第 ${n} 轮`;
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.authed) {
        reject(new Error(t('not_connected')));
        return;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      state.pending.set(id, { resolve, reject });
      state.ws.send(JSON.stringify({ type: 'call', id, method, params: params || {} }));
    });
  }

  // ---------- 摄像头：电脑端「看一眼」的唯一落点 ----------
  //
  // 为什么在手机上拍而不是在电脑上：见 AGENTS/设计讨论 —— 笔记本摄像头只能看见你的脸和背后那面墙，
  // 「看到真实世界」绝大多数时候要看桌面、手上的东西。手机能摆、能转视角、画质更好。
  //
  // 为什么是「按需一张」而不是常开预览：常开视频流的代价（带宽、电量、上下文、隐私）都不需要付；
  // 而且这台页面通常是 http://局域网IP（非安全上下文），浏览器根本给不了 getUserMedia，
  // 所以 Android App 里走原生拍照接口，浏览器里只有安全上下文才降级到 getUserMedia。

  /** 单次拍摄的等待上限（毫秒）。比服务端略短，保证「超时」由手机端先如实说出口。 */
  const CAMERA_CAPTURE_TIMEOUT_MS = 18000;

  /** 等待原生拍照回调的箱子：id → { resolve, reject, timer }。 */
  const cameraWaiters = new Map();

  /** 原生拍照的回调入口（由 MainActivity 通过 evaluateJavascript 调用）。 */
  window.__dieyunCameraResult = function (id, ok, base64, width, height, errorCode) {
    const key = String(id || '');
    const box = cameraWaiters.get(key);
    if (!box) return;
    cameraWaiters.delete(key);
    clearTimeout(box.timer);
    if (ok) {
      box.resolve({
        base64: String(base64 || ''),
        width: Number(width) || 0,
        height: Number(height) || 0
      });
      return;
    }
    const err = new Error(String(errorCode || 'CAMERA_FAILED'));
    err.code = String(errorCode || 'CAMERA_FAILED');
    box.reject(err);
  };

  /** 当前环境怎么拍：native（App 内）/ web（安全上下文的 getUserMedia）/ ''（拍不了）。 */
  function cameraCapable() {
    const app = window.DieyunApp;
    if (app && typeof app.capturePhoto === 'function') return 'native';
    // 只认安全上下文：本页面通常是 http://局域网IP，浏览器在那里即便露出 getUserMedia
    // 也会直接拒绝。先声明能力、再失败，等于骗电脑端「这台能拍」。
    if (
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    ) {
      return 'web';
    }
    return '';
  }

  function cameraCapabilities() {
    return cameraCapable() ? ['camera'] : [];
  }

  /** App 内原生拍照：一次一张，手机上同时有可见提示（见 Android 侧 toast）。 */
  function captureViaNative(facing, maxEdge) {
    return new Promise((resolve, reject) => {
      const id = `cam-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        cameraWaiters.delete(id);
        const err = new Error('TIMEOUT');
        err.code = 'TIMEOUT';
        reject(err);
      }, CAMERA_CAPTURE_TIMEOUT_MS);
      cameraWaiters.set(id, { resolve, reject, timer });
      try {
        window.DieyunApp.capturePhoto(String(id), String(facing), Number(maxEdge) || 1280);
      } catch (e) {
        cameraWaiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /**
   * 浏览器兜底：只在安全上下文（https / localhost）可用。
   * 非安全上下文里 `navigator.mediaDevices` 直接不存在，cameraCapable() 会返回 ''，
   * 这里不做「假装能拍」的尝试。
   */
  async function captureViaGetUserMedia(facing, maxEdge) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: facing === 'user' ? 'user' : 'environment',
        width: { ideal: maxEdge },
        height: { ideal: maxEdge }
      }
    });
    try {
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      // 刚拿到流时曝光还没稳定，白光/暗光下第一帧常是黑的：短暂等待换一帧可用的。
      await new Promise((r) => setTimeout(r, 280));
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      if (!w || !h) throw new Error('相机没有出帧');
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(video, 0, 0, cw, ch);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      const base64 = String(dataUrl.split(',')[1] || '');
      if (!base64) throw new Error('编码失败');
      return { base64, width: cw, height: ch };
    } finally {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
  }

  function sendResponse(id, ok, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(
        JSON.stringify(
          ok
            ? { type: 'response', id, ok: true, data: payload }
            : { type: 'response', id, ok: false, error: payload }
        )
      );
    } catch {
      // 通道断了：电脑端会按断开处理，这里不必再补救
    }
  }

  /**
   * 电脑端发来的请求（目前只有 camera.capture）。
   * 约定：无论成败都必须回一条 response —— 电脑端在等，沉默只会变成超时。
   */
  async function handleRequest(msg) {
    const id = msg && msg.id;
    const method = String((msg && msg.method) || '');
    if (method !== 'camera.capture') {
      sendResponse(id, false, { code: 'UNKNOWN_METHOD', message: `未知方法: ${method}` });
      return;
    }
    const params = (msg && msg.params) || {};
    const facing = params.facing === 'user' ? 'user' : 'environment';
    const maxEdge = Math.max(320, Math.min(2048, Number(params.maxEdge) || 1280));
    const mode = cameraCapable();
    if (!mode) {
      sendResponse(id, false, {
        code: 'CAMERA_NO_BRIDGE',
        message: t('camera_unsupported')
      });
      return;
    }
    // 可见提示：每次拍摄都必须让手机这头知道「正在被拍」（不做隐蔽采集）。
    showInAppToast(t('camera_capturing'));
    try {
      const shot =
        mode === 'native'
          ? await captureViaNative(facing, maxEdge)
          : await captureViaGetUserMedia(facing, maxEdge);
      sendResponse(id, true, {
        base64: shot.base64,
        mime: 'image/jpeg',
        width: shot.width,
        height: shot.height,
        facing,
        capturedAt: Date.now()
      });
    } catch (err) {
      sendResponse(id, false, {
        code: String((err && err.code) || 'CAMERA_FAILED'),
        message: String((err && err.message) || err || '拍摄失败')
      });
    }
  }

  function renderSessions() {
    const root = $('sessions');
    root.innerHTML = '';
    if (!state.sessions.length) {
      root.innerHTML = `<div class="empty">${t('no_sessions')}</div>`;
      return;
    }
    for (const s of state.sessions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `session${s.id === state.activeSessionId ? ' active' : ''}`;
      btn.innerHTML = `<span class="session-title"></span><span class="session-preview"></span><span class="session-meta"></span>`;
      btn.querySelector('.session-title').textContent = s.title || s.preview || t('conversation');
      btn.querySelector('.session-preview').textContent = s.preview || t('default_workspace');
      btn.querySelector('.session-meta').textContent = shortTime(s.updatedAt);
      btn.addEventListener('click', () => selectSession(s.id));
      root.appendChild(btn);
    }
  }

  function setDrawerOpen(open) {
    state.drawerOpen = !!open;
    if (state.drawerOpen) setSettingsOpen(false);
    const drawer = $('session-drawer');
    const backdrop = $('drawer-backdrop');
    drawer.classList.toggle('open', state.drawerOpen);
    drawer.setAttribute('aria-hidden', state.drawerOpen ? 'false' : 'true');
    backdrop.hidden = !state.drawerOpen;
  }

  function setSettingsOpen(open) {
    state.settingsOpen = !!open;
    if (state.settingsOpen) {
      state.drawerOpen = false;
      const drawer = $('session-drawer');
      const backdrop = $('drawer-backdrop');
      if (drawer) {
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
      }
      if (backdrop) backdrop.hidden = true;
    }
    const drawer = $('settings-drawer');
    const backdrop = $('settings-backdrop');
    drawer.classList.toggle('open', state.settingsOpen);
    drawer.setAttribute('aria-hidden', state.settingsOpen ? 'false' : 'true');
    backdrop.hidden = !state.settingsOpen;
  }

  function isSessionDrawerOpen() {
    const drawer = $('session-drawer');
    return !!(state.drawerOpen || (drawer && drawer.classList.contains('open')));
  }

  function isSettingsDrawerOpen() {
    const drawer = $('settings-drawer');
    return !!(state.settingsOpen || (drawer && drawer.classList.contains('open')));
  }

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    localStorage.setItem('dieyun.mobile.theme', next);
    document.querySelectorAll('.theme-choice').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === next);
    });
  }

  function initTheme() {
    applyTheme(localStorage.getItem('dieyun.mobile.theme') || 'dark');
  }

  function wasNearBottom(el, threshold = 120) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  /**
   * 滚动跟随的单一来源：思考区与对话区共用同一套「是否停在底部」状态。
   * 只有用户滚动才会改变它（内容变高不会触发 scroll 事件，因此不会被误判成离开底部）；
   * 上滑阅读历史 → 停止跟随，回到底部 → 自动恢复跟随。
   */
  const scrollTargets = {
    messages: { id: 'messages', follow: true, raf: 0 },
    traceSheet: { id: 'think-sheet-body', follow: true, raf: 0 }
  };

  function scrollTarget(key) {
    return Object.prototype.hasOwnProperty.call(scrollTargets, key) ? scrollTargets[key] : null;
  }

  function isFollowScrolling(key) {
    const target = scrollTarget(key);
    return target ? target.follow : true;
  }

  function setFollowScrolling(key, follow) {
    const target = scrollTarget(key);
    if (!target) return;
    target.follow = !!follow;
  }

  function scrollToFollowTail(key) {
    const target = scrollTarget(key);
    const el = target ? $(target.id) : null;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }

  /** 合并到下一帧再贴底，避免打字机每个 tick 都强制回流 */
  function scheduleFollowScroll(key) {
    const target = scrollTarget(key);
    if (!target || target.raf || !target.follow) return;
    target.raf = requestAnimationFrame(() => {
      target.raf = 0;
      if (target.follow) scrollToFollowTail(key);
    });
  }

  /** 展开思考区 / 点击浮标：强制回到最新并恢复跟随 */
  function jumpToFollowTail(key) {
    setFollowScrolling(key, true);
    scheduleFollowScroll(key);
  }

  function bindFollowScrolling() {
    for (const key of Object.keys(scrollTargets)) {
      const el = $(scrollTargets[key].id);
      if (!el) continue;
      el.addEventListener('scroll', () => {
        setFollowScrolling(key, wasNearBottom(el, FOLLOW_BOTTOM_SLACK_PX));
      }, { passive: true });
    }
  }

  function updateComposerRunState() {
    const running = !!state.taskRunning;
    const composer = $('composer');
    if (composer) {
      composer.classList.toggle('is-running', running);
      composer.classList.toggle('is-stopping', running && !!state.stopping);
    }
    const stop = $('stop');
    if (stop) stop.disabled = !!state.stopping;
    const stopLabel = $('stop-label');
    if (stopLabel) stopLabel.textContent = state.stopping ? t('stopping') : t('stop');
    if (running) {
      setThinkDockVisible(true);
    } else {
      hideThinkDock();
    }
  }

  /** 输入框有内容时主键才点亮（发送） */
  function updateComposerTextState() {
    const input = $('input');
    const composer = $('composer');
    if (!input || !composer) return;
    composer.classList.toggle('has-text', !!input.value.trim());
  }

  function traceDockSummary(trace) {
    const list = Array.isArray(trace) ? trace : [];
    if (!list.length) return t('running');
    const last = list[list.length - 1];
    const phase = last.phase || traceRoundLabel(last, list.length - 1);
    const tools = Array.isArray(last.tools) ? last.tools : [];
    if (tools.length) {
      const tool = tools[tools.length - 1];
      const name = String(tool.name || 'tool').trim();
      const brief = String(tool.summary || tool.argsBrief || '').trim();
      if (brief) return `${phase} · ${name}: ${brief.split('\n')[0].slice(0, 48)}`;
      return `${phase} · ${name}`;
    }
    const thought = String(last.fullThought || last.thought || '').trim();
    if (thought) return thought.split('\n')[0].slice(0, 88);
    return phase;
  }

  function setThinkDockVisible(visible) {
    const dock = $('think-dock');
    if (dock) dock.hidden = !visible;
  }

  function setTraceDockCompact(compact) {
    state.traceDockCompact = !!compact;
    const dock = $('think-dock');
    if (dock) dock.classList.toggle('is-compact', !!compact);
  }

  function updateThinkDock(trace, streamContent) {
    const dock = $('think-dock');
    if (!dock) return;
    const list = Array.isArray(trace) ? trace : state.cachedLiveTrace;
    const statusEl = dock.querySelector('.think-dock-status');
    const summaryEl = dock.querySelector('.think-dock-summary');
    if (!statusEl || !summaryEl) return;

    const hasAnswer = String(streamContent || '').trim().length > 0;
    const compact = hasAnswer && !state.traceSheetOpen;
    setTraceDockCompact(compact);

    const roundCount = list.length;
    if (compact) {
      statusEl.textContent = t('running');
      summaryEl.textContent = t('view_thoughts');
      return;
    }

    statusEl.textContent =
      roundCount > 0
        ? getLang() === 'en'
          ? `Running · round ${roundCount}`
          : `执行中 · 第 ${roundCount} 轮`
        : t('running');
    summaryEl.textContent = traceDockSummary(list);
  }

  function openThinkSheet() {
    const wasOpen = state.traceSheetOpen;
    state.traceSheetOpen = true;
    state.traceVisible = true;
    state.traceManualClosed = false;
    const sheet = $('think-sheet');
    const backdrop = $('think-sheet-backdrop');
    if (sheet) {
      sheet.hidden = false;
      sheet.setAttribute('aria-hidden', 'false');
    }
    if (backdrop) backdrop.hidden = false;
    document.body.classList.add('think-sheet-open');
    if (!wasOpen) jumpToFollowTail('traceSheet');
    updateThinkDock(state.cachedLiveTrace, state.lastStreamContent || '');
  }

  function closeThinkSheet(options = {}) {
    state.traceSheetOpen = false;
    state.traceVisible = false;
    if (!options.silent) state.traceManualClosed = true;
    const sheet = $('think-sheet');
    const backdrop = $('think-sheet-backdrop');
    if (sheet) {
      sheet.hidden = true;
      sheet.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove('think-sheet-open');
    updateThinkDock(state.cachedLiveTrace, state.lastStreamContent || '');
  }

  function hideThinkDock() {
    setThinkDockVisible(false);
    state.cachedLiveTrace = [];
    setTraceDockCompact(false);
    closeThinkSheet({ silent: true });
    const body = $('think-sheet-body');
    if (body) body.innerHTML = '';
  }

  function openTraceSheetForMessage(messageId) {
    const mid = String(messageId || '').trim();
    let list = mid ? state.historicalTraceCache.get(mid) : null;
    if ((!list || !list.length) && state.taskRunning && state.cachedLiveTrace.length) {
      list = state.cachedLiveTrace;
    }
    if (!list || !list.length) return;
    const body = $('think-sheet-body');
    if (!body) return;
    renderTraceIntoBody(body, list, { instant: true, forceRebuild: true });
    const title = $('think-sheet-title');
    if (title) title.textContent = t('thoughts');
    openThinkSheet();
  }

  function historicalTraceEntryLabel(roundCount) {
    const n = Math.max(0, Number(roundCount) || 0);
    return t('trace_rounds').replace('{n}', String(n));
  }

  function ensureHistoricalTraceEntry(msgEl, traceList) {
    if (!msgEl || !Array.isArray(traceList) || !traceList.length) return;
    const messageId = String(msgEl.dataset.messageId || '').trim();
    if (messageId) state.historicalTraceCache.set(messageId, traceList.slice());

    let entry = msgEl.querySelector('.msg-thinking-entry');
    const label = `${historicalTraceEntryLabel(traceList.length)} ▸`;
    if (!entry) {
      entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'msg-thinking-entry';
      entry.addEventListener('click', () => {
        openTraceSheetForMessage(msgEl.dataset.messageId || '');
      });
      const bubble = msgEl.querySelector('.bubble');
      if (bubble) msgEl.insertBefore(entry, bubble);
      else msgEl.appendChild(entry);
    }
    entry.textContent = label;
  }

  async function applySpeechSettingsFromPc(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    let changed = false;
    if (cfg.model) {
      const next = String(cfg.model);
      if (localStorage.getItem('dieyun.speech.whisperModel') !== next) {
        localStorage.setItem('dieyun.speech.whisperModel', next);
        changed = true;
      }
    }
    if (cfg.language) {
      const next = String(cfg.language);
      if (localStorage.getItem('dieyun.speech.language') !== next) {
        localStorage.setItem('dieyun.speech.language', next);
        changed = true;
      }
    }
    // 朗读能力（电脑端是否配了「语音合成」模型）+ 自动朗读开关：决定显不显示朗读按钮
    const ttsReadyFlag = cfg.ttsReady === true ? '1' : '0';
    if (localStorage.getItem(TTS_READY_KEY) !== ttsReadyFlag) {
      localStorage.setItem(TTS_READY_KEY, ttsReadyFlag);
      changed = true;
    }
    const autoReadFlag = cfg.ttsAutoRead === true ? '1' : '0';
    if (localStorage.getItem(TTS_AUTOREAD_KEY) !== autoReadFlag) {
      localStorage.setItem(TTS_AUTOREAD_KEY, autoReadFlag);
      changed = true;
    }
    return changed;
  }

  async function syncSpeechSettingsFromPc() {
    if (!state.authed) return false;
    try {
      const cfg = await call('settings.speech', {});
      return applySpeechSettingsFromPc(cfg);
    } catch {
      return false;
    }
  }

  // ── 朗读（语音合成）──────────────────────────────────────────────────────
  // 电脑端同一能力的实现在 src/renderer/renderer-tts.js。手机端是独立 bundle（无模块
  // 系统），只保留必要部分：分句切块 + 顺序播放 + 停止。切块阈值与电脑端保持一致
  // （90 字一块：实测这家服务器 60~90 字约 2~3 秒就能回来，首字不用干等十几秒）。
  const TTS_CHUNK_TARGET = 90;
  const TTS_CHUNK_MAX = 180;
  const TTS_BREAK = '。！？!?；;\n';
  const TTS_READY_KEY = 'dieyun.speech.ttsReady';
  const TTS_AUTOREAD_KEY = 'dieyun.speech.ttsAutoRead';
  const ttsState = { token: 0, audio: null, urls: new Set(), settle: null, btn: null, text: '' };

  function ttsReady() {
    return localStorage.getItem(TTS_READY_KEY) === '1';
  }

  function ttsAutoReadOn() {
    return localStorage.getItem(TTS_AUTOREAD_KEY) === '1';
  }

  function splitTtsChunks(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    if (!raw.trim()) return [];
    const sentences = [];
    let buf = '';
    for (const ch of raw) {
      buf += ch;
      if (TTS_BREAK.includes(ch)) {
        if (buf.trim()) sentences.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) sentences.push(buf.trim());
    const chunks = [];
    let cur = '';
    const flush = () => {
      const t = cur.trim();
      if (t) chunks.push(t);
      cur = '';
    };
    for (const s of sentences) {
      if (cur && cur.length + s.length > TTS_CHUNK_TARGET) flush();
      cur += s;
      while (cur.length > TTS_CHUNK_MAX) {
        chunks.push(cur.slice(0, TTS_CHUNK_MAX).trim());
        cur = cur.slice(TTS_CHUNK_MAX);
      }
    }
    flush();
    return chunks;
  }

  function ttsSetBtn(btn, speaking) {
    if (!btn) return;
    btn.classList.toggle('is-speaking', !!speaking);
    btn.textContent = speaking ? t('tts_stop') : t('tts_read');
  }

  function ttsStop() {
    ttsState.token += 1; // 作废在途请求，迟到的结果不再播
    if (ttsState.audio) {
      try {
        ttsState.audio.pause();
      } catch {
        /* ignore */
      }
      ttsState.audio = null;
    }
    for (const url of ttsState.urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    ttsState.urls.clear();
    const settle = ttsState.settle;
    ttsState.settle = null;
    const btn = ttsState.btn;
    ttsState.btn = null;
    ttsState.text = '';
    ttsSetBtn(btn, false);
    if (settle) settle();
  }

  async function ttsFetchUrl(chunkText, token) {
    const res = await call('speech.synthesize', { text: chunkText });
    if (token !== ttsState.token) return null;
    const b64 = String((res && res.audioBase64) || '');
    if (!b64) throw new Error(t('tts_failed'));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: (res && res.mimeType) || 'audio/mpeg' }));
    ttsState.urls.add(url);
    return url;
  }

  function ttsPlayUrl(url) {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      ttsState.audio = audio;
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (ttsState.settle === settle) ttsState.settle = null;
        if (ttsState.audio === audio) ttsState.audio = null;
        if (err) reject(err);
        else resolve();
      };
      ttsState.settle = () => settle(null);
      audio.addEventListener('ended', () => settle(null));
      audio.addEventListener('error', () => settle(new Error(t('tts_failed'))));
      const started = audio.play();
      if (started && typeof started.catch === 'function') started.catch((err) => settle(err));
    });
  }

  async function ttsSpeak(text, btn) {
    const content = String(text || '').trim();
    if (!content) return false;
    if (!ttsReady()) {
      setStatus(t('tts_no_model'), true);
      return false;
    }
    // 切歌：先停旧的一段（stop 会让旧代次失效），再取自己的代次
    if (ttsState.audio || ttsState.btn) ttsStop();
    const token = (ttsState.token += 1);
    ttsState.btn = btn || null;
    ttsState.text = content;
    ttsSetBtn(ttsState.btn, true);
    const chunks = splitTtsChunks(content);
    const inflight = new Map();
    const startChunk = (i) => {
      if (i >= chunks.length) return null;
      if (!inflight.has(i)) {
        const p = ttsFetchUrl(chunks[i], token);
        p.catch(() => {});
        inflight.set(i, p);
      }
      return inflight.get(i);
    };
    try {
      startChunk(0);
      for (let i = 0; i < chunks.length; i += 1) {
        const url = await startChunk(i);
        if (token !== ttsState.token) return true;
        startChunk(i + 1); // 边播边合成下一块
        if (!url) continue;
        await ttsPlayUrl(url);
        if (token !== ttsState.token) return true;
      }
    } catch (err) {
      if (token === ttsState.token) {
        ttsStop();
        setStatus(`${t('tts_failed')}：${(err && err.message) || String(err)}`, true);
      }
      return false;
    }
    if (token === ttsState.token) ttsStop();
    return true;
  }

  /** 给一条助手消息挂「朗读」按钮（没有合成模型时什么都不加）。 */
  function attachTtsButton(msgEl, content) {
    if (!msgEl || !ttsReady()) return null;
    const text = String(content || '').trim();
    if (!text) return null;
    if (msgEl.querySelector('.msg-tts-btn')) return msgEl.querySelector('.msg-tts-btn');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-tts-btn';
    btn.textContent = t('tts_read');
    btn.addEventListener('click', () => {
      if (ttsState.btn === btn) {
        ttsStop();
        return;
      }
      ttsSpeak(text, btn).catch(() => {});
    });
    msgEl.appendChild(btn);
    return btn;
  }

  function appendOptimisticUserMessage(text) {
    const root = $('messages');
    if (!root) return;
    clearMessagesEmptyState(root);
    const item = document.createElement('div');
    item.className = 'msg user';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${t('you')} · ${shortTime(Date.now())}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    item.appendChild(meta);
    item.appendChild(bubble);
    root.appendChild(item);
    root.scrollTop = root.scrollHeight;
  }

  function bubbleForMessageId(messageId) {
    if (!messageId) return null;
    const item = document.querySelector(`.msg[data-message-id="${messageId}"]`);
    return item ? item.querySelector('.bubble') : null;
  }

  function updateStreamAnswer(content, options = {}) {
    const target = options.bubble
      ? { bubble: options.bubble }
      : ensureThinkingTargetBubble();
    if (!target || !target.bubble) return;
    const bubble = target.bubble;
    const text = cleanAssistantContent(content || '');
    let answer = bubble.querySelector('.msg-answer');
    if (!text) {
      if (answer && options.typing) {
        answer.classList.add('msg-answer-pending');
        answer.textContent = '';
      }
      return;
    }
    if (!answer) {
      answer = document.createElement('div');
      answer.className = 'msg-answer';
      bubble.appendChild(answer);
    }
    answer.classList.toggle('msg-answer-pending', !!options.typing);
    if (answer.textContent !== text) answer.textContent = text;
    if (text) state.lastStreamContent = text;
    scheduleFollowScroll('messages');
  }

  async function attachHistoricalTraces(rows) {
    if (state.taskRunning || !Array.isArray(rows)) return;
    const assistants = rows.filter((row) => row && row.role === 'assistant' && row.id);
    for (const row of assistants) {
      try {
        const trace = await call('trace.get', { messageId: row.id, sessionId: state.activeSessionId });
        if (!trace || !Array.isArray(trace.trace) || !trace.trace.length) continue;
        const msgEl = document.querySelector(`.msg[data-message-id="${row.id}"]`);
        if (!msgEl) continue;
        ensureHistoricalTraceEntry(msgEl, trace.trace);
      } catch {
        // ignore per-message trace failures
      }
    }
  }

  async function reloadConversationUi() {
    if (!state.authed || !state.activeSessionId) return;
    const rows = await call('messages.list', { sessionId: state.activeSessionId, limit: 500 });
    renderMessages(rows);
    if (state.taskRunning) {
      await refreshActiveTrace();
      return;
    }
    await attachHistoricalTraces(rows);
  }

  function hydrateActiveTaskFromService(info) {
    const rows = info && Array.isArray(info.active) ? info.active : [];
    const live = rows.find(
      (row) => row && (row.status === 'running' || row.status === 'queued' || row.status === 'stopping')
    );
    if (!live) return;
    state.taskRunning = true;
    if (live.requestId) state.activeRequestId = live.requestId;
    if (live.sessionId) {
      state.taskSessionId = live.sessionId;
      if (!state.activeSessionId) state.activeSessionId = live.sessionId;
    }
  }

  function clearMessagesEmptyState(root) {
    if (!root) return;
    root.querySelectorAll('.empty, .empty-state').forEach((el) => el.remove());
  }

  function renderMessages(rows, options = {}) {
    const root = $('messages');
    const stickToBottom =
      options.scrollToBottom === undefined ? isFollowScrolling('messages') : !!options.scrollToBottom;
    root.innerHTML = '';
    if (!rows || !rows.length) {
      root.innerHTML = `<div class="empty">${t('no_messages')}</div>`;
      return;
    }
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = `msg ${row.role === 'user' ? 'user' : 'assistant'}`;
      if (row.id != null) item.dataset.messageId = String(row.id);
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = row.role === 'user' ? `${t('you')} · ${shortTime(row.createdAt)}` : `${t('agent')} · ${shortTime(row.createdAt)}`;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const content = cleanAssistantContent(row.content || '');
      if (row.role === 'user') {
        bubble.textContent = row.content || '';
      } else if (content) {
        const answer = document.createElement('div');
        answer.className = 'msg-answer';
        answer.textContent = content;
        bubble.appendChild(answer);
      }
      item.appendChild(meta);
      item.appendChild(bubble);
      root.appendChild(item);
      if (row.role !== 'user' && content) attachTtsButton(item, content);
    }
    if (stickToBottom) scrollToFollowTail('messages');
    setFollowScrolling('messages', stickToBottom);
  }

  function cleanAssistantContent(text) {
    return String(text || '')
      .replace(/^【叠云meta】\{[\s\S]*?\}\n/, '')
      .replace(/<!--dieyun-meta:[\s\S]*?-->/g, '')
      .replace(/<dieyun-trace>[\s\S]*?<\/dieyun-trace>/g, '')
      .trim();
  }

  function getTraceShowRoundTitles() {
    return localStorage.getItem(TRACE_ROUND_TITLES_KEY) !== '0';
  }

  function setTraceShowRoundTitles(on) {
    localStorage.setItem(TRACE_ROUND_TITLES_KEY, on ? '1' : '0');
    const checkbox = $('settings-trace-round-titles');
    if (checkbox) checkbox.checked = !!on;
  }

  function syncTraceRoundTitlesSetting() {
    const checkbox = $('settings-trace-round-titles');
    if (checkbox) checkbox.checked = getTraceShowRoundTitles();
  }

  const EDGE_SWIPE_PX = 60;

  function isEdgeTouch(clientX) {
    return clientX < EDGE_SWIPE_PX || clientX > window.innerWidth - EDGE_SWIPE_PX;
  }

  function isScrollableTarget(node) {
    let el = node;
    while (el && el !== document.body) {
      if (
        el.id === 'messages' ||
        el.id === 'think-sheet-body' ||
        el.classList?.contains('msg-thinking-body') ||
        el.classList?.contains('think-sheet-body') ||
        el.classList?.contains('session-list')
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function stopTraceTypewriter(roundIndex) {
    const tw = state.traceTypewriters.get(roundIndex);
    if (!tw) return;
    if (tw.timer) {
      clearTimeout(tw.timer);
      tw.timer = null;
    }
    if (tw.el) tw.el.classList.remove('trace-round-body-typing');
    state.traceTypewriters.delete(roundIndex);
  }

  function stopAllTraceTypewriters() {
    for (const key of [...state.traceTypewriters.keys()]) {
      stopTraceTypewriter(key);
    }
  }

  function scheduleTraceTypewriterTick(roundIndex) {
    const tw = state.traceTypewriters.get(roundIndex);
    if (!tw || tw.timer) return;
    tw.timer = setTimeout(() => {
      tw.timer = null;
      const live = state.traceTypewriters.get(roundIndex);
      if (!live || !live.el) return;

      if (live.displayed.length >= live.target.length) {
        live.el.textContent = live.target;
        stopTraceTypewriter(roundIndex);
        if (state.traceSheetOpen) scheduleFollowScroll('traceSheet');
        return;
      }

      let lag = live.target.length - live.displayed.length;
      if (lag > TRACE_TYPE_LAG_SKIP) {
        const keepTail = Math.min(120, Math.floor(live.target.length * 0.12));
        live.displayed = live.target.slice(0, live.target.length - keepTail);
        lag = live.target.length - live.displayed.length;
      }

      let chunk = TRACE_TYPE_CHARS_PER_TICK;
      if (lag > 400) chunk = 64;
      else if (lag > 160) chunk = 36;
      else if (lag > 48) chunk = 22;

      live.displayed = live.target.slice(0, live.displayed.length + chunk);
      live.el.textContent = live.displayed;
      if (state.traceSheetOpen) scheduleFollowScroll('traceSheet');
      scheduleTraceTypewriterTick(roundIndex);
    }, TRACE_TYPE_TICK_MS);
  }

  function setTraceRoundBodyText(thoughtEl, roundIndex, targetText, opts = {}) {
    const instant = !!opts.instant;
    const typing = !!opts.typing && !instant;
    const text = String(targetText || '');

    if (!typing) {
      stopTraceTypewriter(roundIndex);
      thoughtEl.textContent = text;
      thoughtEl.classList.remove('trace-round-body-typing');
      return;
    }

    let tw = state.traceTypewriters.get(roundIndex);
    if (!tw) {
      tw = {
        target: text,
        displayed: thoughtEl.textContent || '',
        el: thoughtEl,
        timer: null
      };
      state.traceTypewriters.set(roundIndex, tw);
    } else {
      tw.el = thoughtEl;
      tw.target = text;
    }

    if (!text.startsWith(tw.displayed)) {
      let common = 0;
      const max = Math.min(tw.displayed.length, text.length);
      while (common < max && tw.displayed[common] === text[common]) common += 1;
      tw.displayed = text.slice(0, common);
      thoughtEl.textContent = tw.displayed;
    }

    if (tw.displayed === text) {
      stopTraceTypewriter(roundIndex);
      return;
    }

    thoughtEl.classList.add('trace-round-body-typing');
    scheduleTraceTypewriterTick(roundIndex);
  }

  function formatTraceRoundText(entry) {
    const fullThought = String(entry.fullThought || entry.thought || '').trim();
    const tools =
      Array.isArray(entry.tools) && entry.tools.length
        ? '\n\n' +
          entry.tools
            .map((tool) => `${tool.name || 'tool'}: ${tool.summary || (tool.pending ? t('running') : '')}`)
            .join('\n')
        : '';
    return `${fullThought}${tools}`.trim() || t('running');
  }

  function createTraceRoundElement(entry, index, showRoundTitles, textOpts) {
    const div = document.createElement('div');
    div.className = 'trace-round';
    div.dataset.roundIndex = String(index);
    if (showRoundTitles) {
      const title = document.createElement('strong');
      title.className = 'trace-round-title';
      title.textContent = traceRoundLabel(entry, index);
      div.appendChild(title);
    }
    const thought = document.createElement('p');
    thought.className = 'trace-round-body';
    div.appendChild(thought);
    setTraceRoundBodyText(thought, index, formatTraceRoundText(entry), textOpts);
    return div;
  }

  function updateTraceRoundElement(div, entry, index, showRoundTitles, textOpts) {
    div.dataset.roundIndex = String(index);
    let title = div.querySelector('.trace-round-title');
    if (showRoundTitles) {
      const label = traceRoundLabel(entry, index);
      if (!title) {
        title = document.createElement('strong');
        title.className = 'trace-round-title';
        div.insertBefore(title, div.firstChild);
      }
      if (title.textContent !== label) title.textContent = label;
    } else if (title) {
      title.remove();
    }
    let thought = div.querySelector('.trace-round-body');
    if (!thought) {
      thought = document.createElement('p');
      thought.className = 'trace-round-body';
      div.appendChild(thought);
    }
    setTraceRoundBodyText(thought, index, formatTraceRoundText(entry), textOpts);
  }

  function traceRoundTextOpts(index, total, options) {
    const instant = !!options.instant || !!options.forceRebuild;
    const typing = !!options.typing && !instant && index === total - 1;
    return { instant: instant || index < total - 1, typing };
  }

  function clearThinkingMount() {
    stopAllTraceTypewriters();
    document.querySelectorAll('.msg-thinking-outer').forEach((el) => el.remove());
    document.querySelectorAll('.msg.assistant[data-live-assistant="1"]').forEach((el) => el.remove());
    if (!state.taskRunning) {
      hideThinkDock();
    }
  }

  function createLiveAssistantMsg(root) {
    const msgEl = document.createElement('div');
    msgEl.className = 'msg assistant';
    msgEl.dataset.liveAssistant = '1';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${t('agent')} · ${shortTime(Date.now())}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    msgEl.appendChild(meta);
    msgEl.appendChild(bubble);
    root.appendChild(msgEl);
    return msgEl;
  }

  function ensureThinkingTargetBubble() {
    const root = $('messages');
    if (!root) return null;

    clearMessagesEmptyState(root);

    let msgEl = null;
    if (state.taskRunning) {
      msgEl = root.querySelector('.msg.assistant[data-live-assistant="1"]');
      if (!msgEl) msgEl = createLiveAssistantMsg(root);
    } else {
      const assistants = root.querySelectorAll('.msg.assistant');
      msgEl = assistants.length ? assistants[assistants.length - 1] : null;
    }
    if (!msgEl) return null;

    let bubble = msgEl.querySelector('.bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'bubble';
      msgEl.appendChild(bubble);
    }
    return { msgEl, bubble };
  }

  function renderTraceIntoBody(body, list, options = {}) {
    if (!body) return;
    const forceRebuild = !!options.forceRebuild;
    const showRoundTitles = getTraceShowRoundTitles();
    const existing = body.querySelectorAll('.trace-round');
    const canPatch =
      !forceRebuild &&
      existing.length > 0 &&
      existing.length <= list.length &&
      body.childElementCount === existing.length;

    if (forceRebuild) stopAllTraceTypewriters();

    if (canPatch) {
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        const textOpts = traceRoundTextOpts(i, list.length, options);
        let div = existing[i];
        if (!div) {
          div = createTraceRoundElement(entry, i, showRoundTitles, textOpts);
          body.appendChild(div);
        } else {
          updateTraceRoundElement(div, entry, i, showRoundTitles, textOpts);
        }
      }
      for (let i = list.length; i < existing.length; i++) {
        stopTraceTypewriter(i);
      }
    } else {
      stopAllTraceTypewriters();
      body.innerHTML = '';
      list.forEach((entry, index) => {
        body.appendChild(
          createTraceRoundElement(entry, index, showRoundTitles, traceRoundTextOpts(index, list.length, options))
        );
      });
    }

    if (state.traceSheetOpen) scheduleFollowScroll('traceSheet');
  }

  function renderTrace(trace, options = {}) {
    const list = Array.isArray(trace) ? trace : [];
    const localOnly = !!options.localOnly;
    const streamContent = typeof options.streamContent === 'string' ? options.streamContent : '';

    if (localOnly) {
      if (!list.length) return;
      const msgEl =
        options.messageEl ||
        (options.bubble ? options.bubble.closest('.msg') : null);
      ensureHistoricalTraceEntry(msgEl, list);
      return;
    }

    if (!list.length) {
      if (state.taskRunning) {
        updateThinkDock([], streamContent);
      } else {
        hideThinkDock();
      }
      if (streamContent) {
        updateStreamAnswer(streamContent, { typing: !!options.typing });
      }
      return;
    }

    state.cachedLiveTrace = list.slice();
    setThinkDockVisible(true);
    updateThinkDock(list, streamContent);

    const sheetBody = $('think-sheet-body');
    if (sheetBody) {
      renderTraceIntoBody(sheetBody, list, options);
    }

    if (typeof streamContent === 'string') {
      if (streamContent) state.lastStreamContent = streamContent;
      updateStreamAnswer(streamContent, { typing: !!options.typing });
    }
  }

  async function refreshSessionList(preferSessionId) {
    const sessions = await call('sessions.list', { limit: 50 });
    state.sessions = sessions || [];
    if (preferSessionId) state.activeSessionId = preferSessionId;
    if (!state.activeSessionId && state.sessions[0]) state.activeSessionId = state.sessions[0].id;
    renderSessions();
    updateActiveSessionLabel();
  }

  function scheduleSessionListRefresh(preferSessionId, delayMs = 2500) {
    if (state.sessionListRefreshTimer) return;
    state.sessionListRefreshTimer = setTimeout(() => {
      state.sessionListRefreshTimer = null;
      refreshSessionList(preferSessionId).catch(() => {});
    }, delayMs);
  }

  async function refreshSessions(preferSessionId, options = {}) {
    await refreshSessionList(preferSessionId);
    if (state.activeSessionId) {
      await loadMessages(state.activeSessionId, options);
    }
  }

  async function loadMessages(sessionId, options = {}) {
    const preserveTraceState = !!options.preserveTraceState;
    const prevTraceVisible = state.traceVisible;
    const prevTraceManualClosed = state.traceManualClosed;

    state.activeSessionId = sessionId;
    if (!preserveTraceState) {
      state.traceVisible = false;
      clearThinkingMount();
    }
    renderSessions();
    updateActiveSessionLabel();
    const rows = await call('messages.list', { sessionId, limit: 500 });
    renderMessages(rows, { scrollToBottom: options.scrollToBottom });
    try {
      const trace = await call('trace.get', { sessionId });
      if (trace && trace.live) {
        state.taskRunning = true;
        if (trace.requestId) state.activeRequestId = trace.requestId;
        if (trace.sessionId) state.taskSessionId = trace.sessionId;
      }
      if (preserveTraceState) {
        state.traceVisible = prevTraceVisible;
        state.traceManualClosed = prevTraceManualClosed;
      }
      updateComposerRunState();
      const traceList = trace && trace.trace;
      const streamContent = trace && typeof trace.streamContent === 'string' ? trace.streamContent : '';
      const shouldRenderLiveTrace =
        trace &&
        trace.live &&
        Array.isArray(traceList) &&
        traceList.length;
      if (shouldRenderLiveTrace) {
        renderTrace(traceList, {
          typing: true,
          streamContent,
          forceRebuild: !preserveTraceState
        });
        if (preserveTraceState && state.traceSheetOpen) {
          openThinkSheet();
        }
      } else if (!state.taskRunning) {
        await attachHistoricalTraces(rows);
      } else if (streamContent) {
        updateStreamAnswer(streamContent, { typing: true });
      }
    } catch {
      if (!state.taskRunning) await attachHistoricalTraces(rows).catch(() => {});
    }
  }

  async function refreshActiveTrace(options = {}) {
    if (!state.authed || !state.activeSessionId) return;
    try {
      const trace = await call('trace.get', {
        requestId: state.activeRequestId || '',
        sessionId: state.activeSessionId
      });
      if (!trace || ((!Array.isArray(trace.trace) || !trace.trace.length) && !trace.streamContent)) return;
      if (trace.live) state.taskRunning = true;
      updateComposerRunState();
      const streamContent = typeof trace.streamContent === 'string' ? trace.streamContent : '';
      if (Array.isArray(trace.trace) && trace.trace.length) {
        renderTrace(trace.trace, {
          typing: !!trace.live,
          instant: !trace.live,
          streamContent,
          forceRebuild: !!options.forceRebuild
        });
      } else if (streamContent) {
        state.lastStreamContent = streamContent;
        updateStreamAnswer(streamContent, { typing: !!trace.live });
        updateThinkDock(state.cachedLiveTrace, streamContent);
      }
    } catch {
      // ignore opportunistic refresh failures
    }
  }

  function updateActiveSessionLabel() {
    const current = state.sessions.find((s) => s.id === state.activeSessionId);
    const label = current ? (current.title || current.preview || t('conversation')) : t('default_workspace');
    $('active-session-label').textContent = label;
    $('top-session-label').textContent = label;
  }

  async function selectSession(sessionId) {
    try {
      setDrawerOpen(false);
      ttsStop(); // 切会话：别让上一段的朗读继续念
      await loadMessages(sessionId, { scrollToBottom: false });
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  function notify(title, body) {
    if (window.DieyunApp && typeof window.DieyunApp.notify === 'function') {
      try {
        window.DieyunApp.notify(String(title || '叠云AI'), String(body || ''));
        return;
      } catch {
        // fall back to Web Notification
      }
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body: body || '' });
    } catch {
      // ignore
    }
  }

  function notifyPageReady() {
    if (window.DieyunApp && typeof window.DieyunApp.pageReady === 'function') {
      try {
        window.DieyunApp.pageReady();
      } catch {
        // ignore
      }
    }
  }

  function fetchVersion() {
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.version) {
          state.version = String(data.version);
          const el = $('settings-version');
          if (el) el.textContent = `v${state.version}`;
        }
      })
      .catch(() => {});
  }

  function handleEvent(event) {
    if (!event || !event.type) return;

    if (event.type === 'settings.speech') {
      applySpeechSettingsFromPc(event);
      return;
    }

    const incomingSessionId = event.sessionId ? String(event.sessionId) : '';
    if (event.requestId) state.activeRequestId = event.requestId;

    const isViewingSession = (sessionId) =>
      !sessionId || !state.activeSessionId || sessionId === state.activeSessionId;

    if (event.type === 'task.queued' || event.type === 'task.started') {
      if (incomingSessionId) state.taskSessionId = incomingSessionId;
      state.taskRunning = true;
      state.stopping = false;
      state.traceManualClosed = false;
      state.lastStreamContent = '';
      setFollowScrolling('traceSheet', true);
      updateComposerRunState();
      setThinkDockVisible(true);
      updateThinkDock([], '');
      setStatus(event.type === 'task.started' ? t('task_executing') : t('running'));
      if (isViewingSession(incomingSessionId)) {
        refreshSessions(incomingSessionId || state.activeSessionId, { preserveTraceState: true }).catch(() => {});
      } else {
        refreshSessionList().catch(() => {});
      }
      return;
    }

    if (event.type === 'task.stopping') {
      state.taskRunning = true;
      state.stopping = true;
      updateComposerRunState();
      setStatus(t('stopping'));
      return;
    }

    if (event.type === 'task.progress') {
      state.taskRunning = true;
      state.stopping = false;
      updateComposerRunState();
      setStatus(t('running'));
      if (!isViewingSession(incomingSessionId)) {
        scheduleSessionListRefresh();
        return;
      }
      if (incomingSessionId) {
        state.activeSessionId = incomingSessionId;
        state.taskSessionId = incomingSessionId;
      }
      const streamContent = typeof event.streamContent === 'string' ? event.streamContent : '';
      if (Array.isArray(event.trace) && event.trace.length) {
        renderTrace(event.trace, {
          instant: true,
          typing: false,
          streamContent
        });
      } else if (streamContent) {
        state.lastStreamContent = streamContent;
        updateStreamAnswer(streamContent, { typing: false });
        updateThinkDock(state.cachedLiveTrace, streamContent);
      }
      return;
    }

    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.stopped') {
      state.taskRunning = false;
      state.stopping = false;
      updateComposerRunState();
      if (incomingSessionId && state.taskSessionId === incomingSessionId) {
        state.taskSessionId = '';
      }
      stopAllTraceTypewriters();
      state.traceManualClosed = false;
      // 自动朗读要用到最后这段正文，清空之前先取出来
      const finalAnswer = String(state.lastStreamContent || '').trim();
      state.lastStreamContent = '';
      hideThinkDock();
      const viewing = isViewingSession(incomingSessionId);
      const sessionId = incomingSessionId || state.activeSessionId;
      refreshSessions(sessionId).catch(() => {});
      const ok = event.type === 'task.completed';
      if (ok && viewing && finalAnswer) {
        // 跑完的这一拍：给流式气泡补上「朗读」按钮，并按设置决定是否自动朗读
        const liveMsg = document.querySelector('#messages .msg.assistant[data-live-assistant="1"]');
        if (liveMsg) {
          const btn = attachTtsButton(liveMsg, finalAnswer);
          if (btn && ttsAutoReadOn()) ttsSpeak(finalAnswer, btn).catch(() => {});
        }
      }
      setStatus(
        ok ? t('task_complete') : event.type === 'task.stopped' ? t('task_stopped_msg') : t('task_failed'),
        !ok && event.type !== 'task.stopped'
      );
      notify(ok ? t('task_complete') : t('app_title'), event.summary || event.error || '');
      return;
    }
  }

  function connect() {
    if (state.stopReconnect || state.authFailed) return;
    const token = tokenFromLocation();
    if (!token) {
      state.authFailed = true;
      setStatus(t('missing_token'), true);
      return;
    }
    localStorage.setItem('dieyun.mobile.token', token);
    clearReconnectTimer();
    if (state.ws) teardownWs(state.ws, { scheduleReconnect: false });

    const generation = ++state.wsGeneration;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      if (generation !== state.wsGeneration) return;
      // 自报能力：电脑端据此决定「Agent 主动拍一张」该不该路由到这台手机。
      // 没有 camera 能力也照常认证——只是 camera_look 会得到「手机没连上摄像头」而不是静默失败。
      ws.send(JSON.stringify({ type: 'auth', token, capabilities: cameraCapabilities() }));
    };
    ws.onmessage = (ev) => {
      if (generation !== state.wsGeneration) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'error') {
        const code = msg.error && typeof msg.error === 'object' ? msg.error.code : msg.error;
        const authFailed = code === 'AUTH_FAILED' || msg.error === 'AUTH_FAILED';
        if (authFailed) {
          state.authFailed = true;
          state.stopReconnect = true;
          clearReconnectTimer();
          localStorage.removeItem('dieyun.mobile.token');
          setStatus(t('auth_failed'), true);
          teardownWs(ws, { scheduleReconnect: false });
        }
        return;
      }
      if (msg.type === 'auth_ok') {
        state.authed = true;
        state.authFailed = false;
        state.stopReconnect = false;
        setStatus(t('connected'));
        notifyPageReady();
        fetchVersion();
        hydrateActiveTaskFromService(msg.data);
        syncSpeechSettingsFromPc().catch(() => {});
        updateComposerRunState();
        refreshSessions(state.activeSessionId || undefined)
          .then(() => {
            if (state.taskRunning) return refreshActiveTrace();
          })
          .catch((e) => setStatus(e.message || String(e), true));
        return;
      }
      if (msg.type === 'request') {
        void handleRequest(msg);
        return;
      }
      if (msg.type === 'event') {
        handleEvent(msg.event);
        return;
      }
      if (msg.type === 'result') {
        const box = state.pending.get(msg.id);
        if (!box) return;
        state.pending.delete(msg.id);
        if (msg.ok) box.resolve(msg.data);
        else box.reject(new Error(msg.error && msg.error.message ? msg.error.message : '请求失败'));
      }
    };
    ws.onclose = () => {
      if (generation !== state.wsGeneration) return;
      teardownWs(ws, { scheduleReconnect: !state.stopReconnect && !state.authFailed });
    };
    ws.onerror = () => {
      if (generation !== state.wsGeneration) return;
      setStatus(t('connection_failed'), true);
    };
  }

  function reconnect() {
    setSettingsOpen(false);
    state.authFailed = false;
    state.stopReconnect = false;
    clearReconnectTimer();
    if (window.DieyunApp && typeof window.DieyunApp.reconnect === 'function') {
      try {
        window.DieyunApp.reconnect();
        return;
      } catch {
        // fall back to page reload
      }
    }
    location.reload();
  }

  function changeComputer() {
    setSettingsOpen(false);
    state.stopReconnect = true;
    state.authFailed = true;
    clearReconnectTimer();
    if (state.ws) teardownWs(state.ws, { scheduleReconnect: false });
    if (window.DieyunApp && typeof window.DieyunApp.changeComputer === 'function') {
      try {
        window.DieyunApp.changeComputer();
        return;
      } catch {
        // fall back to token reset
      }
    }
    localStorage.removeItem('dieyun.mobile.token');
    setStatus(t('scan_again'), true);
  }

  function checkUpdate() {
    setSettingsOpen(false);
    if (window.DieyunApp && typeof window.DieyunApp.checkForUpdates === 'function') {
      try {
        window.DieyunApp.checkForUpdates();
        return;
      } catch {
        // fall through to status text
      }
    }
    setStatus(t('update_check_unsupported'), true);
  }

  $('composer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('input');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    if (state.taskRunning) return;
    input.value = '';
    updateComposerTextState();
    appendOptimisticUserMessage(text);
    try {
      const r = await call('task.submit', {
        text,
        sessionId: state.activeSessionId || ''
      });
      state.activeRequestId = r.requestId;
      state.activeSessionId = r.sessionId;
      state.taskSessionId = r.sessionId;
      state.taskRunning = true;
      state.stopping = false;
      state.traceManualClosed = false;
      state.lastStreamContent = '';
      updateComposerRunState();
      setThinkDockVisible(true);
      updateThinkDock([], '');
      await refreshSessions(r.sessionId, { scrollToBottom: true });
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  });

  $('stop').addEventListener('click', async () => {
    if (state.stopping || !state.taskRunning) return;
    try {
      state.stopping = true;
      updateComposerRunState();
      await call('task.stop', {
        requestId: state.activeRequestId,
        sessionId: state.activeSessionId
      });
      setStatus(t('stop'));
    } catch (e) {
      state.stopping = false;
      updateComposerRunState();
      setStatus(e.message || String(e), true);
    }
  });

  $('refresh').addEventListener('click', async () => {
    try {
      await refreshSessions(state.activeSessionId, { preserveTraceState: state.taskRunning });
      if (state.taskRunning) await refreshActiveTrace();
      setStatus(t('refresh_sessions'));
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  });

  function on(id, event, handler) {
    const el = $(id);
    if (el) el.addEventListener(event, handler);
  }

  on('sessions-open', 'click', () => setDrawerOpen(true));
  on('sessions-close', 'click', () => setDrawerOpen(false));
  on('settings-open', 'click', () => setSettingsOpen(true));
  on('settings-close', 'click', () => setSettingsOpen(false));
  on('settings-reconnect', 'click', reconnect);
  on('settings-change-computer', 'click', changeComputer);
  on('settings-check-update', 'click', checkUpdate);
  on('think-dock', 'click', () => {
    if (state.cachedLiveTrace.length) {
      const body = $('think-sheet-body');
      if (body && !body.querySelector('.trace-round')) {
        renderTraceIntoBody(body, state.cachedLiveTrace, { instant: true });
      }
    }
    openThinkSheet();
    jumpToFollowTail('traceSheet');
  });
  on('think-sheet-close', 'click', () => closeThinkSheet());
  const traceRoundTitles = $('settings-trace-round-titles');
  if (traceRoundTitles) {
    traceRoundTitles.addEventListener('change', () => {
      setTraceShowRoundTitles(traceRoundTitles.checked);
      if (state.taskRunning) {
        refreshActiveTrace({ forceRebuild: true }).catch(() => {});
      } else if (state.activeSessionId) {
        call('messages.list', { sessionId: state.activeSessionId, limit: 500 })
          .then((rows) => attachHistoricalTraces(rows))
          .catch(() => {});
      }
    });
  }
  syncTraceRoundTitlesSetting();
  document.querySelectorAll('.theme-choice[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
  document.querySelectorAll('.language-choice').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyLanguage(btn.dataset.language);
      renderSessions();
      updateActiveSessionLabel();
    });
  });

  window.addEventListener('touchstart', (ev) => {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    state.touchStartX = t.clientX;
    state.touchStartY = t.clientY;
    state.ignoreEdgeSwipe = isScrollableTarget(ev.target) && !isEdgeTouch(t.clientX);
  }, { passive: true });

  window.addEventListener('touchmove', (ev) => {
    if (state.ignoreEdgeSwipe) return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - state.touchStartX);
    const dy = Math.abs(t.clientY - state.touchStartY);
    if (dy > 16 && dy > dx + 8) state.ignoreEdgeSwipe = true;
  }, { passive: true });

  window.addEventListener('touchend', (ev) => {
    const t = ev.changedTouches && ev.changedTouches[0];
    if (!t) return;
    if (state.ignoreEdgeSwipe) {
      state.ignoreEdgeSwipe = false;
      return;
    }
    const dx = t.clientX - state.touchStartX;
    const dy = Math.abs(t.clientY - state.touchStartY);
    if (dy > 100 || Math.abs(dx) < 36) return;

    if (isSessionDrawerOpen()) {
      if (dx < 0) setDrawerOpen(false);
      return;
    }
    if (isSettingsDrawerOpen()) {
      if (dx > 0) setSettingsOpen(false);
      return;
    }

    if (state.touchStartX < EDGE_SWIPE_PX && dx > 0) {
      setDrawerOpen(true);
    } else if (state.touchStartX > window.innerWidth - EDGE_SWIPE_PX && dx < 0) {
      setSettingsOpen(true);
    }
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.taskRunning) {
      refreshActiveTrace().catch(() => {});
      return;
    }
    if (state.authed && state.activeSessionId) {
      refreshSessions(state.activeSessionId).catch(() => {});
    }
  });
  window.addEventListener('focus', () => {
    if (document.hidden) return;
    if (state.taskRunning) {
      refreshActiveTrace().catch(() => {});
      return;
    }
    if (state.authed && state.activeSessionId) {
      refreshSessions(state.activeSessionId).catch(() => {});
    }
  });
  window.addEventListener('pageshow', () => {
    if (state.taskRunning) {
      refreshActiveTrace().catch(() => {});
      return;
    }
    if (state.authed && state.activeSessionId) {
      refreshSessions(state.activeSessionId).catch(() => {});
    }
  });

  applyLanguage(getLang());
  initTheme();
  bindFollowScrolling();
  updateComposerRunState();
  updateComposerTextState();
  on('input', 'input', () => updateComposerTextState());
  if (typeof initMobileVoice === 'function') {
    initMobileVoice({ call, t, showToast, isTaskRunning });
  }
  notifyPageReady();
  connect();
})();

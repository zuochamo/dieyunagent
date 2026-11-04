/* global document, $, chatInput, composerBox, composerSendBtn, gwState, gatewayCall, resolveComposerModelForSend, insertComposerQuotedText, refreshContextProgress, updateComposerMentionMenu, showAgentToast, isCurrentSessionSending, settings, arrayBufferToBase64, getSpeechApiConfig, matchesShortcut */
'use strict';

const VOICE_MAX_MS = 120000;
const VOICE_TICK_MS = 200;
const SPEECH_WHISPER_MODEL_KEY = 'dieyun.speech.whisperModel';
const SPEECH_LANGUAGE_KEY = 'dieyun.speech.language';

let voiceRecording = false;
let voiceTranscribing = false;
// 每次取消都递增：转写是异步的，取消后回来的结果必须被丢弃，不能再插进输入框。
let voiceGen = 0;
let mediaStream = null;
let mediaRecorder = null;
let voiceChunks = [];
let voiceStartedAt = 0;
let voiceTimerId = null;
let voiceMimeType = 'audio/webm';
let audioContext = null;
let analyser = null;
let waveAnimId = null;

function getSpeechWhisperModel() {
  try {
    const v = String(window.localStorage.getItem(SPEECH_WHISPER_MODEL_KEY) || '').trim();
    if (v) return v;
  } catch {
    // ignore
  }
  return String(settings?.speechWhisperModel || 'whisper-1').trim() || 'whisper-1';
}

function getSpeechLanguage() {
  try {
    const v = String(window.localStorage.getItem(SPEECH_LANGUAGE_KEY) || '').trim();
    if (v) return v;
  } catch {
    // ignore
  }
  return String(settings?.speechLanguage || 'zh').trim();
}

function pickRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'audio/webm';
}

function extensionForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  return 'webm';
}

function formatVoiceTimer(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function voiceUi() {
  return {
    panel: $('composer-voice-panel'),
    btn: $('btn-composer-voice'),
    timer: $('composer-voice-timer'),
    status: $('composer-voice-status'),
    wave: $('composer-voice-wave'),
    cancel: $('composer-voice-cancel'),
    confirm: $('composer-voice-confirm')
  };
}

function setVoicePanelVisible(visible) {
  const { panel, btn } = voiceUi();
  if (panel) panel.hidden = !visible;
  if (btn) btn.classList.toggle('is-recording', !!visible);
  if (composerBox) composerBox.classList.toggle('is-voice-recording', !!visible);
}

function setVoiceStatus(text) {
  const { status } = voiceUi();
  if (status) status.textContent = String(text || '');
}

function updateVoiceTimer() {
  const { timer } = voiceUi();
  if (!timer || !voiceRecording) return;
  timer.textContent = formatVoiceTimer(Date.now() - voiceStartedAt);
}

function stopWaveform() {
  if (waveAnimId) {
    cancelAnimationFrame(waveAnimId);
    waveAnimId = null;
  }
  if (audioContext) {
    try {
      audioContext.close();
    } catch {
      // ignore
    }
    audioContext = null;
    analyser = null;
  }
  const { wave } = voiceUi();
  if (wave) wave.replaceChildren();
}

function startWaveform(stream) {
  stopWaveform();
  const { wave } = voiceUi();
  if (!wave || !stream) return;
  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    const bars = [];
    for (let i = 0; i < 12; i++) {
      const bar = document.createElement('span');
      bar.className = 'composer-voice-bar';
      wave.appendChild(bar);
      bars.push(bar);
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyser) return;
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < bars.length; i++) {
        const v = data[i + 2] || 0;
        // 只改 scaleY：条高固定（占满波形区），逐帧写 height 会与过渡互相打断并触发布局
        bars[i].style.transform = `scaleY(${Math.max(0.15, v / 255).toFixed(3)})`;
      }
      waveAnimId = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    wave.innerHTML = '<span class="composer-voice-bar is-idle"></span>'.repeat(8);
  }
}

function setVoiceControlsDisabled(disabled) {
  const { btn, confirm } = voiceUi();
  if (btn) btn.disabled = !!disabled && !voiceRecording;
  // 「取消」永不置灰：转写请求可能长时间不返回，这是用户唯一的出口（Esc 走同一条路）。
  if (confirm) confirm.disabled = !!disabled;
}

function cleanupVoiceStream() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  mediaRecorder = null;
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
  }
  mediaStream = null;
  stopWaveform();
  if (voiceTimerId) {
    clearInterval(voiceTimerId);
    voiceTimerId = null;
  }
}

async function startVoiceRecording() {
  if (voiceRecording || voiceTranscribing) return;
  if (typeof isCurrentSessionSending === 'function' && isCurrentSessionSending()) {
    showAgentToast('语音输入', 'Agent 运行中，请稍后再试', { variant: 'info' });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showAgentToast('语音输入', '当前环境不支持麦克风', { variant: 'error' });
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showAgentToast('语音输入', err?.message || '无法访问麦克风', { variant: 'error' });
    return;
  }

  voiceMimeType = pickRecorderMimeType();
  voiceChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: voiceMimeType });
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream);
    voiceMimeType = mediaRecorder.mimeType || 'audio/webm';
  }

  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) voiceChunks.push(ev.data);
  };
  mediaRecorder.onerror = () => {
    showAgentToast('语音输入', '录音失败', { variant: 'error' });
    cancelVoiceRecording();
  };

  voiceRecording = true;
  voiceStartedAt = Date.now();
  setVoicePanelVisible(true);
  setVoiceStatus('正在录音… 完成后点击「转写」（Esc 取消）');
  setVoiceControlsDisabled(false);
  updateVoiceTimer();
  voiceTimerId = setInterval(() => {
    updateVoiceTimer();
    if (Date.now() - voiceStartedAt >= VOICE_MAX_MS) {
      void finishVoiceRecording();
    }
  }, VOICE_TICK_MS);

  startWaveform(mediaStream);
  mediaRecorder.start(250);
}

function cancelVoiceRecording() {
  voiceGen += 1;
  voiceRecording = false;
  voiceTranscribing = false;
  cleanupVoiceStream();
  setVoicePanelVisible(false);
  setVoiceControlsDisabled(false);
  setVoiceStatus('');
}

async function stopVoiceBlob() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder) {
      reject(new Error('未在录音'));
      return;
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(voiceChunks, { type: voiceMimeType || 'audio/webm' });
      cleanupVoiceStream();
      resolve(blob);
    };
    try {
      mediaRecorder.stop();
    } catch (err) {
      reject(err);
    }
  });
}

async function transcribeVoiceBlob(blob) {
  if (!gwState?.authed) throw new Error('Gateway 未连接');
  if (!blob || !blob.size) throw new Error('录音为空');

  const speechCfg =
    typeof getSpeechApiConfig === 'function' ? getSpeechApiConfig(settings) : null;
  const api =
    speechCfg?.baseUrl
      ? speechCfg
      : typeof resolveComposerModelForSend === 'function'
        ? resolveComposerModelForSend(chatInput?.value || '').apiConfig
        : null;
  const baseUrl = String(speechCfg?.baseUrl || api?.baseUrl || settings?.baseUrl || '').trim();
  const apiKey = String(speechCfg?.apiKey || api?.apiKey || settings?.apiKey || '').trim();
  if (!baseUrl) throw new Error('未配置 API Base URL');

  const buf = await blob.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(buf);
  const ext = extensionForMime(blob.type || voiceMimeType);

  return gatewayCall('speech.transcribe', {
    audioBase64,
    mimeType: blob.type || voiceMimeType,
    filename: `speech.${ext}`,
    baseUrl,
    apiKey,
    model: String(speechCfg?.model || getSpeechWhisperModel()).trim() || 'whisper-1',
    language: getSpeechLanguage()
  });
}

async function finishVoiceRecording() {
  if (!voiceRecording || voiceTranscribing) return;
  const gen = voiceGen;
  voiceTranscribing = true;
  voiceRecording = false;
  setVoiceControlsDisabled(true);
  setVoiceStatus('正在转写…（Esc 取消）');

  try {
    const blob = await stopVoiceBlob();
    if (gen !== voiceGen) return;
    if (!blob.size) throw new Error('录音为空');
    const result = await transcribeVoiceBlob(blob);
    if (gen !== voiceGen) return;
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('转写结果为空');
    if (typeof insertComposerQuotedText === 'function') {
      insertComposerQuotedText(text);
    } else if (chatInput) {
      chatInput.value = `${chatInput.value}${chatInput.value ? '\n\n' : ''}${text}`;
      chatInput.focus();
      if (typeof refreshContextProgress === 'function') refreshContextProgress();
      if (typeof updateComposerMentionMenu === 'function') updateComposerMentionMenu();
    }
    setVoicePanelVisible(false);
    setVoiceStatus('');
  } catch (err) {
    if (gen !== voiceGen) return;
    showAgentToast('语音转写失败', err?.message || String(err), { variant: 'error' });
    setVoicePanelVisible(false);
    setVoiceStatus('');
  } finally {
    // 已被取消（或被新一轮录音接管）：状态归新的一轮所有，这里不能回写。
    if (gen === voiceGen) {
      voiceTranscribing = false;
      voiceRecording = false;
      setVoiceControlsDisabled(false);
    }
  }
}

function toggleVoiceRecording() {
  if (voiceTranscribing) return;
  if (voiceRecording) {
    void finishVoiceRecording();
    return;
  }
  void startVoiceRecording();
}

function initComposerVoice() {
  const { btn, cancel, confirm } = voiceUi();
  if (!btn || !chatInput) return;

  btn.addEventListener('click', () => toggleVoiceRecording());
  if (cancel) {
    cancel.addEventListener('click', () => cancelVoiceRecording());
  }
  if (confirm) {
    confirm.addEventListener('click', () => {
      void finishVoiceRecording();
    });
  }

  document.addEventListener('keydown', (ev) => {
    // 录音/转写面板自己的快捷键：Esc 退出（与面板上的「取消」同一条路径，转写中也能中断）。
    if (ev.key === 'Escape' && (voiceRecording || voiceTranscribing)) {
      if (ev.repeat) return;
      ev.preventDefault();
      cancelVoiceRecording();
      return;
    }
    if (typeof matchesShortcut !== 'function' || !matchesShortcut(ev, 'voice.toggle')) return;
    // 按住不放会连发 repeat 事件：**先**吃掉默认行为再判 repeat。
    // 只在首键 preventDefault 的话，后续 repeat 会漏到浏览器进程，命中原生快捷键
    // （Ctrl+M = 默认应用菜单的「最小化」），这也是「按久一点窗口就最小化」的原因。
    ev.preventDefault();
    if (ev.repeat) return;
    toggleVoiceRecording();
  });
}

window.initComposerVoice = initComposerVoice;
window.cancelVoiceRecording = cancelVoiceRecording;

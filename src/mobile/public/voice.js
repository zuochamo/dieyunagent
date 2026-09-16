(function () {
  'use strict';

  const VOICE_MAX_MS = 120000;
  const VOICE_TICK_MS = 200;
  const SPEECH_WHISPER_MODEL_KEY = 'dieyun.speech.whisperModel';
  const SPEECH_LANGUAGE_KEY = 'dieyun.speech.language';

  let deps = null;
  let voiceRecording = false;
  let voiceTranscribing = false;
  let mediaStream = null;
  let mediaRecorder = null;
  let voiceChunks = [];
  let voiceStartedAt = 0;
  let voiceTimerId = null;
  let voiceMimeType = 'audio/webm';
  let audioContext = null;
  let analyser = null;
  let waveAnimId = null;

  function $(id) {
    return document.getElementById(id);
  }

  function getSpeechWhisperModel() {
    try {
      const v = String(localStorage.getItem(SPEECH_WHISPER_MODEL_KEY) || '').trim();
      if (v) return v;
    } catch {
      // ignore
    }
    return 'whisper-1';
  }

  function getSpeechLanguage() {
    try {
      const v = String(localStorage.getItem(SPEECH_LANGUAGE_KEY) || '').trim();
      if (v) return v;
    } catch {
      // ignore
    }
    return 'zh';
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

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function formatVoiceTimer(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function t(key) {
    return deps && typeof deps.t === 'function' ? deps.t(key) : key;
  }

  function showToast(title, message) {
    const body = String(message || title || '').trim();
    if (!body) return;
    let el = document.getElementById('voice-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'voice-toast';
      el.className = 'voice-toast';
      document.body.appendChild(el);
    }
    el.textContent = body;
    el.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }

  function setVoicePanelVisible(visible) {
    const panel = $('composer-voice-panel');
    const btn = $('voice-toggle');
    const composer = $('composer');
    if (panel) panel.hidden = !visible;
    if (btn) btn.classList.toggle('is-recording', !!visible);
    if (composer) composer.classList.toggle('is-voice-recording', !!visible);
  }

  function setVoiceStatus(text) {
    const status = $('composer-voice-status');
    if (status) status.textContent = String(text || '');
  }

  function updateVoiceTimer() {
    const timer = $('composer-voice-timer');
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
    const wave = $('composer-voice-wave');
    if (wave) wave.replaceChildren();
  }

  function startWaveform(stream) {
    stopWaveform();
    const wave = $('composer-voice-wave');
    if (!wave || !stream) return;
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      const bars = [];
      for (let i = 0; i < 10; i++) {
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
          const h = Math.max(4, Math.round((v / 255) * 24));
          bars[i].style.height = `${h}px`;
        }
        waveAnimId = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      wave.innerHTML = '<span class="composer-voice-bar is-idle"></span>'.repeat(8);
    }
  }

  function setVoiceControlsDisabled(disabled) {
    const btn = $('voice-toggle');
    const cancel = $('composer-voice-cancel');
    const confirm = $('composer-voice-confirm');
    if (btn) btn.disabled = !!disabled && !voiceRecording;
    if (cancel) cancel.disabled = !!disabled;
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

  function insertTranscript(text) {
    const input = $('input');
    if (!input) return;
    const value = String(text || '').trim();
    if (!value) return;
    const prefix = input.value.trim();
    input.value = prefix ? `${input.value}\n\n${value}` : value;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isTaskRunning() {
    return !!(deps && typeof deps.isTaskRunning === 'function' && deps.isTaskRunning());
  }

  async function startVoiceRecording() {
    if (voiceRecording || voiceTranscribing) return;
    if (isTaskRunning()) {
      showToast(t('voice_title'), t('voice_task_busy'));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast(t('voice_title'), t('voice_mic_unsupported'));
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      showToast(t('voice_title'), err?.message || t('voice_mic_denied'));
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
      showToast(t('voice_title'), t('voice_record_failed'));
      cancelVoiceRecording();
    };

    voiceRecording = true;
    voiceStartedAt = Date.now();
    setVoicePanelVisible(true);
    setVoiceStatus(t('voice_recording_hint'));
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
    if (!deps || typeof deps.call !== 'function') throw new Error('未连接电脑端');
    if (!blob || !blob.size) throw new Error('录音为空');
    const buf = await blob.arrayBuffer();
    const audioBase64 = arrayBufferToBase64(buf);
    const ext = extensionForMime(blob.type || voiceMimeType);
    return deps.call('speech.transcribe', {
      audioBase64,
      mimeType: blob.type || voiceMimeType,
      filename: `speech.${ext}`,
      model: getSpeechWhisperModel(),
      language: getSpeechLanguage()
    });
  }

  async function finishVoiceRecording() {
    if (!voiceRecording || voiceTranscribing) return;
    voiceTranscribing = true;
    voiceRecording = false;
    setVoiceControlsDisabled(true);
    setVoiceStatus(t('voice_transcribing'));

    try {
      const blob = await stopVoiceBlob();
      if (!blob.size) throw new Error('录音为空');
      const result = await transcribeVoiceBlob(blob);
      const text = String(result?.text || '').trim();
      if (!text) throw new Error('转写结果为空');
      insertTranscript(text);
      setVoicePanelVisible(false);
      setVoiceStatus('');
    } catch (err) {
      showToast(t('voice_transcribe_failed'), err?.message || String(err));
      setVoicePanelVisible(false);
      setVoiceStatus('');
    } finally {
      voiceTranscribing = false;
      voiceRecording = false;
      setVoiceControlsDisabled(false);
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

  function initMobileVoice(options) {
    deps = options || {};
    const btn = $('voice-toggle');
    const cancel = $('composer-voice-cancel');
    const confirm = $('composer-voice-confirm');
    if (!btn || !$('input')) return;

    btn.addEventListener('click', () => toggleVoiceRecording());
    if (cancel) cancel.addEventListener('click', () => cancelVoiceRecording());
    if (confirm) confirm.addEventListener('click', () => {
      void finishVoiceRecording();
    });
  }

  window.initMobileVoice = initMobileVoice;
  window.cancelMobileVoice = cancelVoiceRecording;
})();

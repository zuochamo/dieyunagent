'use strict';

/**
 * 嘴与耳：**说一句**（TTS → 本机播放）与**听一下**（本机麦克风录音 → 转写 → 文字）。
 *
 * 复用既有单一来源，不另造通道：
 * - ffmpeg 的发现与「带硬超时地跑一个外部程序」：`desktop-camera-source.js`
 *   （`resolveFfmpegPath` / `runFfmpeg` —— 原来这里抄了一份 `runProcess`，两处超时口径已经开始漂移）；
 * - 合成：`gateway/speech-synthesize.js#synthesizeSpeech`（播放走 `ffplay`，与 ffmpeg 同家族）；
 * - 转写：`gateway/speech-transcribe.js#transcribeWhisper`（Whisper，OpenAI 兼容）。
 *
 * 设备选择：`设置 → 拟态 → 生命` 里选（存在 `alive/settings.json` 的 `micDevice`），
 * `DIEYUN_MIC_DEVICE` 只作高级覆盖 —— 普通用户不该知道 dshow 设备名长什么样。
 *
 * 三条硬边界（都是刻意的）：
 * 1. **不落盘**：录音与合成音频都只写系统临时目录，用完立刻删；不存在"录音文件"这种东西。
 * 2. **有上限**：一次最多录 15 秒、一次最多说 300 字 —— 没有"一直听着"的形态。
 * 3. **缺件就如实说**：没 ffmpeg / 没麦克风设备 / 没语音槽位配置，一律返回明确的错误码，
 *    不静默失败、不假装听到了。`describeVoiceCapability` 是页面告警的唯一来源。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveFfmpegPath, runFfmpeg } = require('../agent/desktop-camera-source');
const { synthesizeSpeech } = require('../gateway/speech-synthesize');
const { transcribeWhisper } = require('../gateway/speech-transcribe');

/** 一次最多听多少秒 / 一次最多说多少字 */
const LISTEN_MAX_SECONDS = 15;
const LISTEN_DEFAULT_SECONDS = 5;
const SPEAK_MAX_CHARS = 300;
/** 播放/录音的硬超时（秒 + 余量），避免外部程序卡住整轮心跳 */
const SPAWN_TIMEOUT_MARGIN_MS = 20000;
/** 枚举设备的硬超时（`-list_devices` 立刻返回，给 8 秒足够） */
const LIST_DEVICES_TIMEOUT_MS = 8000;

function tmpFile(ext) {
  const name = `dieyun-alive-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
  return path.join(os.tmpdir(), name);
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 不存在即已清
  }
}

/** 一次听多久（**唯一一处**夹取：调用方要报"最多 X 秒"时也用这个，别各处再算一遍） */
function clampListenSeconds(seconds) {
  return Math.min(
    LISTEN_MAX_SECONDS,
    Math.max(1, Number(seconds) || LISTEN_DEFAULT_SECONDS)
  );
}

/**
 * 麦克风设备：**设置里选过的 → 环境变量高级覆盖 → 平台默认**。
 *
 * 为什么要这个顺序：普通用户不该知道 `dshow` 设备名长什么样（issue/2026-11-10 的核心抱怨之一），
 * 所以页面上能选就够用；`DIEYUN_MIC_DEVICE` 留给「脚本/无人值守」这类没法点界面的场景，
 * 且它一旦显式给了就以它为准（否则改了环境变量反而不生效，最难排查）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [saved] 设置页选中的设备名
 */
function resolveMicDevice(env, saved) {
  const explicit = String((env && env.DIEYUN_MIC_DEVICE) || '').trim();
  if (explicit) return explicit;
  const chosen = String(saved || '').trim();
  if (chosen) return chosen;
  if (process.platform === 'win32') return ''; // Windows 没有默认设备名，交给调用方报错
  return 'default';
}

/**
 * 各平台的「枚举输入设备」形状（唯一定义处；与 `desktop-camera-source` 的视频枚举各管一边）。
 *
 * ffmpeg 把 `-list_devices` 的输出当**日志**打到 stderr，因此只能解析文本：
 * - dshow：`"麦克风 (USB Audio)" (audio)` / `"摄像头" (video)`，两种设备混在一张表里；
 * - avfoundation：先列视频、再列音频，音频段落头是 `AVFoundation audio devices:`，索引从 0 重来；
 * - alsa：ffmpeg 不枚举，直接给 `default`（要更多就走环境变量覆盖）。
 */
const AUDIO_BACKENDS = Object.freeze({
  win32: Object.freeze({
    listArgs: ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    parseList: (text) =>
      String(text)
        .split(/\r?\n/)
        .map((line) => line.match(/"([^"]+)"\s*\(audio\)/))
        .filter(Boolean)
        .map((m) => m[1].trim())
  }),
  darwin: Object.freeze({
    listArgs: ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    parseList: (text) => {
      const raw = String(text);
      const cut = raw.indexOf('AVFoundation audio devices');
      if (cut < 0) return [];
      return raw
        .slice(cut)
        .split(/\r?\n/)
        .map((line) => line.match(/\[(\d+)\]\s+(.+)$/))
        .filter(Boolean)
        .map((m) => m[2].trim());
    }
  }),
  linux: Object.freeze({
    listArgs: [],
    parseList: () => []
  })
});

function audioBackendFor(platform = process.platform) {
  return AUDIO_BACKENDS[platform] || null;
}

/**
 * 列出可用的**输入**（麦克风）设备名。
 *
 * @param {{ ffmpegPath?: string, platform?: string, env?: NodeJS.ProcessEnv,
 *           timeoutMs?: number, spawnFn?: Function }} [opts]
 * @returns {Promise<string[]>}
 */
async function listAudioDevices(opts = {}) {
  const platform = opts.platform || process.platform;
  const backend = audioBackendFor(platform);
  if (!backend) return [];
  // Linux：ffmpeg 不做枚举，只有系统默认设备；要指定别的走 DIEYUN_MIC_DEVICE
  if (platform === 'linux') return ['default'];
  const ffmpeg = opts.ffmpegPath || resolveFfmpegPath(opts.env || process.env);
  if (!ffmpeg) return [];
  const out = await runFfmpeg(ffmpeg, ['-hide_banner', ...backend.listArgs], {
    timeoutMs: opts.timeoutMs || LIST_DEVICES_TIMEOUT_MS,
    spawnFn: opts.spawnFn
  });
  return backend.parseList(out.stderr);
}

/** 说一句要用的播放器：与 ffmpeg 同目录的 ffplay（同一套安装） */
function resolveFfplayPath(ffmpegPath) {
  if (!ffmpegPath) return '';
  const name = process.platform === 'win32' ? 'ffplay.exe' : 'ffplay';
  const candidate = path.join(path.dirname(ffmpegPath), name);
  try {
    return fs.existsSync(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

/**
 * 「嘴与耳」的**依赖自检**：页面据此给出可见告警，别让开关亮着而能力是坏的。
 *
 * 只做存在性判断，不 spawn（页面轮询要够快）；真正的设备列表走 `listAudioDevices`。
 *
 * @param {{ env?: NodeJS.ProcessEnv, ffmpegPath?: string, speechConfig?: object,
 *           ttsConfig?: object, micDevice?: string }} [opts]
 * @returns {{ ok: boolean, hasFfmpeg: boolean, hasFfplay: boolean,
 *             hasSpeechConfig: boolean, hasTtsConfig: boolean,
 *             micDevice: string, ffmpegPath: string, problems: Array<{ code: string, text: string }> }}
 */
function describeVoiceCapability(opts = {}) {
  const env = opts.env || process.env;
  const ffmpegPath = opts.ffmpegPath || resolveFfmpegPath(env);
  const ffplayPath = resolveFfplayPath(ffmpegPath);
  const speech = opts.speechConfig || {};
  const tts = opts.ttsConfig || {};
  // 「有配置」= 有人指定了端点（转写还要模型名）。**apiKey 不是配置的一部分**：
  // 内网 / 本机语音服务（FunASR SenseVoice、LM Studio 之类）普遍不要鉴权，
  // 强制要 key 会把「已经配好的嘴与耳」判成坏的（issue/2026-11-11 红字告警），
  // 而真正发请求的那一层（llm-request.buildLlmHeaders）本来就允许空 key。
  const hasSpeechConfig = !!speech.baseUrl;
  const hasTtsConfig = !!(tts.baseUrl && tts.model);
  const micDevice = resolveMicDevice(env, opts.micDevice);
  /** @type {Array<{code:string,text:string}>} */
  const problems = [];
  if (!ffmpegPath) {
    problems.push({
      code: 'NO_FFMPEG',
      text: '这台机器上找不到 ffmpeg：装不了嘴也当不了耳朵。装好后重启应用（或设置环境变量 DIEYUN_FFMPEG 指向它）。'
    });
  } else if (!ffplayPath) {
    problems.push({
      code: 'NO_FFPLAY',
      text: '有 ffmpeg 但没有 ffplay（要和 ffmpeg 一起装）：能听，但说不出来。'
    });
  }
  if (!hasSpeechConfig) {
    problems.push({
      code: 'NO_SPEECH_CONFIG',
      text: '没有配置语音转写（设置 → 模型 → 语音）：录了也听不懂，所以不会录音。'
    });
  }
  if (!hasTtsConfig) {
    problems.push({
      code: 'NO_TTS_CONFIG',
      text: '没有配置语音合成（设置 → 模型 → 语音）：它说不出来。'
    });
  }
  if (process.platform === 'win32' && !micDevice) {
    problems.push({
      code: 'NO_MIC_DEVICE',
      text: '还没选麦克风（Windows 必须指定设备名）：下面挑一个，或者设 DIEYUN_MIC_DEVICE。'
    });
  }
  return {
    ok: problems.length === 0,
    hasFfmpeg: !!ffmpegPath,
    hasFfplay: !!ffplayPath,
    hasSpeechConfig,
    hasTtsConfig,
    micDevice,
    ffmpegPath,
    problems
  };
}

/**
 * 主动出声/收音的**许可判定**（唯一一处）：开关 + 当日上限 + 最小间隔。
 *
 * 为什么独立于 `speak`/`listen`：这两条是"能不能"，那两个是"怎么做"。
 * 判定要能被页面（显示"今天已用 3/8"）与工具层（拒绝调用）共用同一份事实。
 *
 * @param {{ allowSpontaneous: boolean, countToday?: number, lastVoiceAt?: number,
 *           maxPerDay?: number, minIntervalMs?: number, nowMs?: number }} opts
 * @returns {{ ok: boolean, reason?: string, error?: string }}
 */
function voicePolicy(opts = {}) {
  if (opts.allowSpontaneous !== true) {
    return {
      ok: false,
      reason: 'not-allowed',
      error: '用户还没有允许它主动出声/收音（「设置 → 拟态 → 生命 → 嘴巴与耳朵」里的二级开关）。这不是故障，重试也不会成功。'
    };
  }
  const nowMs = Number(opts.nowMs) || Date.now();
  const count = Math.max(0, Number(opts.countToday) || 0);
  const maxPerDay = Math.max(0, Number(opts.maxPerDay) || 0);
  if (maxPerDay > 0 && count >= maxPerDay) {
    return { ok: false, reason: 'daily-cap', error: `今天已经主动开口 ${count} 次（上限 ${maxPerDay}），明天再说。` };
  }
  const last = Math.max(0, Number(opts.lastVoiceAt) || 0);
  const minInterval = Math.max(0, Number(opts.minIntervalMs) || 0);
  if (last > 0 && minInterval > 0 && nowMs - last < minInterval) {
    const waitMin = Math.ceil((minInterval - (nowMs - last)) / 60000);
    return { ok: false, reason: 'cooldown', error: `距上次开口还不到 ${Math.round(minInterval / 60000)} 分钟，再等 ${waitMin} 分钟。` };
  }
  return { ok: true };
}

/**
 * 录音失败的**分类**：无设备 / 被占用 / 其它，分别给不同文案（不要统一静默失败）。
 *
 * 解析的是 ffmpeg 的 stderr（外部程序的事实输出），不是用户意图关键词。
 */
function classifyRecordFailure(stderr) {
  const s = String(stderr || '');
  if (/busy|in use|being used|already in use|0x8007000e|unavailable/i.test(s)) return 'DEVICE_BUSY';
  if (/no such|not found|could not find|invalid device|invalid argument|permission|access is denied|拒绝访问/i.test(s)) {
    return 'DEVICE_UNAVAILABLE';
  }
  return 'NO_AUDIO';
}

/** 各平台的 ffmpeg 录音入参（十年稳定的老参数，不猜版本） */
function recordArgs(platform, device, seconds, outFile) {
  if (platform === 'win32') {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${device}`, '-t', String(seconds), '-y', outFile];
  }
  if (platform === 'darwin') {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-t', String(seconds), '-y', outFile];
  }
  return ['-hide_banner', '-loglevel', 'error', '-f', 'alsa', '-i', device, '-t', String(seconds), '-y', outFile];
}

/**
 * 听一下：录 N 秒 → 转写 → 返回文字（音频不落盘）。
 *
 * @param {{ userData: string, seconds?: number, env?: NodeJS.ProcessEnv, device?: string,
 *           speechConfig?: object, ffmpegPath?: string, transcribe?: Function }} opts
 * @returns {Promise<{ ok: boolean, text?: string, error?: string, errorCode?: string, seconds?: number }>}
 */
async function listen(opts) {
  const env = opts.env || process.env;
  const seconds = clampListenSeconds(opts.seconds);
  const ffmpeg = opts.ffmpegPath || resolveFfmpegPath(env);
  if (!ffmpeg) {
    return {
      ok: false,
      errorCode: 'NO_FFMPEG',
      error: '这台机器上找不到 ffmpeg，听不了。请让用户装 ffmpeg 或设置 DIEYUN_FFMPEG。'
    };
  }
  const device = resolveMicDevice(env, opts.device);
  if (!device) {
    return {
      ok: false,
      errorCode: 'NO_MIC_DEVICE',
      error:
        '还没选麦克风，听不了（Windows 上必须指定设备名）。请让用户在「设置 → 拟态 → 生命」里挑一个麦克风，或设置 DIEYUN_MIC_DEVICE。'
    };
  }
  const cfg = opts.speechConfig || {};
  if (!cfg.baseUrl) {
    return {
      ok: false,
      errorCode: 'NO_SPEECH_CONFIG',
      error: '没有配置语音转写（「设置 → 模型 → 语音」），录了也听不懂，所以没有录。'
    };
  }
  const out = tmpFile('wav');
  try {
    const res = await runFfmpeg(ffmpeg, recordArgs(process.platform, device, seconds, out), {
      timeoutMs: seconds * 1000 + SPAWN_TIMEOUT_MARGIN_MS,
      spawnFn: opts.spawnFn
    });
    let buffer = null;
    try {
      buffer = fs.readFileSync(out);
    } catch {
      buffer = null;
    }
    if (!buffer || !buffer.length) {
      // 三种失败要分开说：超时 / 被占用 / 其它（统一一句「没录到声音」等于让用户自己猜）
      const kind = res.timedOut ? 'TIMEOUT' : classifyRecordFailure(res.stderr);
      const tail = String(res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200);
      const text =
        kind === 'TIMEOUT'
          ? `录音超时（${seconds} 秒没有返回）：设备可能被别的程序占着。`
          : kind === 'DEVICE_BUSY'
            ? `麦克风「${device}」被别的程序占用了，这次没听着。`
            : kind === 'DEVICE_UNAVAILABLE'
              ? `找不到麦克风「${device}」：可能拔了、被禁用，或名字变了（重新选一次设备）。`
              : `没有录到声音（${device}）：可能静音、音量太低，或设备不可用。`;
      return {
        ok: false,
        errorCode: kind === 'TIMEOUT' ? 'NO_AUDIO' : kind,
        error: tail ? `${text}（${tail}）` : text
      };
    }
    const transcribe = typeof opts.transcribe === 'function' ? opts.transcribe : transcribeWhisper;
    const text = await transcribe({
      audioBuffer: buffer,
      mimeType: 'audio/wav',
      filename: 'alive-listen.wav',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model || 'whisper-1',
      language: cfg.language || '',
      authMode: cfg.authMode,
      headers: cfg.headers,
      userAgent: cfg.userAgent
    });
    const clean = String(text || '').trim();
    if (!clean) return { ok: true, text: '', seconds, error: '这几秒里没有听清任何话' };
    return { ok: true, text: clean, seconds };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'LISTEN_FAILED',
      error: `没听清：${(err && err.message) || err}`
    };
  } finally {
    safeUnlink(out);
  }
}

/**
 * 说一句：TTS 合成 → ffplay 播放 → 删临时文件（音频不落盘）。
 *
 * @param {{ userData: string, text: string, env?: NodeJS.ProcessEnv, ttsConfig?: object,
 *           synthesizer?: Function, ffmpegPath?: string }} opts
 * @returns {Promise<{ ok: boolean, chars?: number, error?: string, errorCode?: string }>}
 */
async function speak(opts) {
  const env = opts.env || process.env;
  const text = String(opts.text || '').trim().slice(0, SPEAK_MAX_CHARS);
  if (!text) return { ok: false, errorCode: 'EMPTY_TEXT', error: '要说的内容是空的' };
  const cfg = opts.ttsConfig || {};
  if (!cfg.baseUrl || !cfg.model) {
    return {
      ok: false,
      errorCode: 'NO_TTS_CONFIG',
      error: '没有配置语音合成（「设置 → 模型 → 语音」），说不出来。'
    };
  }
  const ffmpeg = opts.ffmpegPath || resolveFfmpegPath(env);
  const ffplay = resolveFfplayPath(ffmpeg);
  if (!ffplay) {
    return {
      ok: false,
      errorCode: 'NO_FFPLAY',
      error: '这台机器上没有 ffplay（和 ffmpeg 一起装），说不出来。请让用户装 ffmpeg 全套。'
    };
  }
  const synth = typeof opts.synthesizer === 'function' ? opts.synthesizer : synthesizeSpeech;
  let file = '';
  try {
    const res = await synth({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      voice: cfg.voice,
      text,
      format: 'wav',
      authMode: cfg.authMode,
      headers: cfg.headers,
      userAgent: cfg.userAgent
    });
    const audioBase64 = String((res && res.audioBase64) || '');
    if (!audioBase64) {
      return { ok: false, errorCode: 'TTS_EMPTY', error: '合成返回了空音频' };
    }
    file = tmpFile(String((res && res.format) || 'wav'));
    fs.writeFileSync(file, Buffer.from(audioBase64, 'base64'));
    const played = await runFfmpeg(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file], {
      timeoutMs: 60000,
      spawnFn: opts.spawnFn
    });
    if (played.code !== 0 && played.timedOut) {
      return { ok: false, errorCode: 'PLAY_TIMEOUT', error: '播放超时（设备可能被占用）' };
    }
    // `text` 原样带回：调用方要把它记成"它说了什么"（人可能不在/没听清，得能回看）
    return { ok: true, chars: text.length, text };
  } catch (err) {
    return { ok: false, errorCode: 'SPEAK_FAILED', error: `说不出来：${(err && err.message) || err}` };
  } finally {
    if (file) safeUnlink(file);
  }
}

const ALIVE_SPEAK_TOOL = {
  type: 'function',
  function: {
    name: 'alive_speak',
    description:
      '用这台机器的音箱**说一句**（合成语音直接播放，不留文件）。\n' +
      '它不是聊天：没有人正在等你说话，说完也没有回复。所以只说一句必要的，最多 300 字。\n' +
      '如果房间里没人，说了也白说 —— 由你判断值不值得说。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的一句话（≤300 字）' }
      },
      required: ['text']
    }
  }
};

const ALIVE_LISTEN_TOOL = {
  type: 'function',
  function: {
    name: 'alive_listen',
    description:
      '用这台机器的麦克风**听几秒**，把听到的话转成文字（录音不落盘，听完即删）。\n' +
      '最多 15 秒、默认 5 秒。别把它当成"一直听着"：每次都要你主动听，而且只有这几秒。\n' +
      '没有麦克风 / 没有语音转写配置时会明确告诉你，不会假装听到了。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '听几秒（1–15，默认 5）' }
      }
    }
  }
};

module.exports = {
  LISTEN_MAX_SECONDS,
  LISTEN_DEFAULT_SECONDS,
  SPEAK_MAX_CHARS,
  AUDIO_BACKENDS,
  ALIVE_SPEAK_TOOL,
  ALIVE_LISTEN_TOOL,
  audioBackendFor,
  clampListenSeconds,
  resolveMicDevice,
  resolveFfplayPath,
  listAudioDevices,
  describeVoiceCapability,
  voicePolicy,
  classifyRecordFailure,
  recordArgs,
  listen,
  speak
};

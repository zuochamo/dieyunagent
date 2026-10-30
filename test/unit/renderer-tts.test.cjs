'use strict';

/**
 * `src/renderer/renderer-tts.js`（助手回复朗读）的接线契约。
 *
 * 守的语义：
 * 1. 只有设置里存在 `kind: 'tts'` 的模型时才渲染朗读按钮（不兜底到转写模型 ——
 *    那个模型走 /v1/audio/transcriptions，拿不到音频）；
 * 2. 点击按钮 → `gatewayCall('speech.synthesize', …)`，参数必须是该模型的完整配置
 *    （baseUrl / apiKey / model / voice / headers …），否则「设置里能测、对话里 400」；
 * 3. Markdown 的代码块与标记不该被念出来。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-tts.js');

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '',
    innerHTML: '',
    title: '',
    type: '',
    disabled: false,
    dataset: {},
    children: [],
    listeners: {},
    attrs: {},
    parentNode: null,
    isConnected: true,
    classList: {
      list: [],
      add(cls) {
        if (!el.classList.list.includes(cls)) el.classList.list.push(cls);
      },
      remove(cls) {
        el.classList.list = el.classList.list.filter((c) => c !== cls);
      },
      toggle(cls, on) {
        if (on === undefined) {
          if (el.classList.list.includes(cls)) el.classList.remove(cls);
          else el.classList.add(cls);
          return;
        }
        if (on) el.classList.add(cls);
        else el.classList.remove(cls);
      },
      contains(cls) {
        return el.classList.list.includes(cls);
      }
    },
    setAttribute(name, value) {
      el.attrs[name] = String(value);
    },
    getAttribute(name) {
      return el.attrs[name];
    },
    addEventListener(type, fn) {
      el.listeners[type] = fn;
    },
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    get nextElementSibling() {
      const parent = el.parentNode;
      if (!parent || !parent.children) return null;
      const idx = parent.children.indexOf(el);
      return idx >= 0 ? parent.children[idx + 1] || null : null;
    },
    insertBefore(child, ref) {
      const idx = ref ? el.children.indexOf(ref) : -1;
      if (idx < 0) el.children.push(child);
      else el.children.splice(idx, 0, child);
      child.parentNode = el;
      return child;
    },
    querySelector() {
      return null;
    }
  };
  // className 与 classList 必须同步：生产代码用 classList.contains 判重，
  // 而插入时是直接写 className
  Object.defineProperty(el, 'className', {
    enumerable: true,
    get() {
      return el.classList.list.join(' ');
    },
    set(value) {
      el.classList.list = String(value || '')
        .split(/\s+/)
        .filter(Boolean);
    }
  });
  return el;
}

function loadTtsModule({
  settings,
  modelCapabilities,
  gatewayCall,
  toasts,
  audioFails = false,
  audioEnds = 'auto'
}) {
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'settings',
    'currentSessionId',
    'gatewayCall',
    'showAgentToast',
    'base64ToUint8Array',
    'Blob',
    'URL',
    'Audio',
    `${source}
     return {
       ttsAvailable,
       ttsSpeakableText,
       ttsTextOfBubble,
       attachTtsBarToBubble,
       playTtsText,
       maybeAutoReadAssistantBubble,
       stopTtsPlayback,
       splitTtsChunks
     };`
  );
  const window = { ModelCapabilities: modelCapabilities };
  const document = { createElement: makeEl };
  const audioCalls = [];
  let blobSeq = 0;
  class FakeAudio {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.paused = false;
      audioCalls.push(this);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    async play() {
      // 复刻 Chromium 的失败顺序：先派发 media error 事件，再让 play() 以
      // NotSupportedError 拒绝（CSP 挡住 blob: 时就是这个样子）
      if (audioFails) {
        this.error = { code: 4, message: 'Media load rejected by URL safety check' };
        if (this.listeners.error) this.listeners.error();
        const err = new Error('Failed to load because no supported source was found.');
        err.name = 'NotSupportedError';
        throw err;
      }
      this.played = true;
      // 分块播放是「播完这块再播下一块」的死循环模型：真实 Audio 会派发 ended，
      // 测试里必须补上，否则播放循环永不结束。需要「正在播」状态的用例传 audioEnds:'manual'。
      if (audioEnds === 'auto') {
        queueMicrotask(() => {
          if (!this.paused && this.listeners.ended) this.listeners.ended();
        });
      }
    }
    pause() {
      this.paused = true;
    }
  }
  const api = factory(
    window,
    document,
    settings,
    'sess-1',
    gatewayCall,
    (title, body, opts) => toasts.push({ title, body, opts }),
    (base64) => new Uint8Array(Buffer.from(String(base64), 'base64')),
    class {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts && opts.type;
      }
    },
    { createObjectURL: () => `blob:fake-${++blobSeq}`, revokeObjectURL: () => {} },
    FakeAudio
  );
  return { ...api, audioCalls };
}

/** 带正文的助手气泡：`ttsTextOfBubble` 优先读 .msg-answer 的 dataset.rawContent。 */
function makeBubbleWithText(text) {
  const bubble = makeEl('div');
  const answer = makeEl('div');
  answer.className = 'msg-answer';
  answer.dataset.rawContent = text;
  bubble.querySelector = (sel) => (sel === '.msg-answer' ? answer : null);
  bubble.innerText = text;
  return bubble;
}

function ttsCapabilities(config) {  return {
    getTtsApiConfigFromSettings: (s) => (config && (s || {}).customModels ? config : null)
  };
}

const settingsWithTts = {
  customModels: [
    {
      id: 'm1',
      name: 'mimo-v2.5-tts',
      baseUrl: 'http://192.168.31.62:5018/v1',
      apiKey: 'k',
      kind: 'tts',
      voice: '茉莉',
      headers: { 'x-app': 'dieyun' }
    }
  ]
};

describe('ttsSpeakableText', () => {
  const { ttsSpeakableText } = loadTtsModule({
    settings: {},
    modelCapabilities: ttsCapabilities(null),
    gatewayCall: async () => ({}),
    toasts: []
  });

  it('围栏代码整块不念，行内代码只留文字', () => {
    const out = ttsSpeakableText('开头\n```js\nconst a = 1;\n```\n中间 `npm test` 结尾');
    expect(out).not.toContain('const a = 1');
    expect(out).not.toContain('```');
    expect(out).toContain('npm test');
    expect(out).toContain('开头');
  });

  it('标题 / 强调 / 列表 / 链接标记被剥掉，文字留下', () => {
    const out = ttsSpeakableText('## 标题\n- **加粗** 条目\n[文档](https://example.com/x)');
    expect(out).toBe('标题\n加粗 条目\n文档');
  });
});

describe('ttsAvailable / attachTtsBarToBubble', () => {
  it('没有 tts 模型时不渲染按钮', () => {
    const { ttsAvailable, attachTtsBarToBubble } = loadTtsModule({
      settings: {},
      modelCapabilities: ttsCapabilities(null),
      gatewayCall: async () => ({}),
      toasts: []
    });
    expect(ttsAvailable()).toBe(false);
    const parent = makeEl('div');
    const bubble = makeEl('div');
    parent.appendChild(bubble);
    expect(attachTtsBarToBubble(bubble)).toBeNull();
  });

  it('有 tts 模型时把操作条插在气泡之后（气泡内容会被 replaceChildren 清空）', () => {
    const { ttsAvailable, attachTtsBarToBubble } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: async () => ({}),
      toasts: []
    });
    expect(ttsAvailable()).toBe(true);
    const parent = makeEl('div');
    const bubble = makeEl('div');
    parent.appendChild(bubble);
    const bar = attachTtsBarToBubble(bubble);
    expect(bar).not.toBeNull();
    expect(parent.children.indexOf(bar)).toBe(parent.children.indexOf(bubble) + 1);
    // 幂等：历史渲染 + 「本轮跑完」两条路都挂，不能长出第二个按钮
    const again = attachTtsBarToBubble(bubble);
    expect(again).toBe(bar);
    expect(parent.children.filter((n) => n.className === 'msg-tts-bar')).toHaveLength(1);
  });
});

describe('maybeAutoReadAssistantBubble（自动朗读开关）', () => {
  function autoReadCase({ autoRead, opts, hasTts = true }) {
    const calls = [];
    const mod = loadTtsModule({
      settings: { ...settingsWithTts, ttsAutoRead: autoRead },
      modelCapabilities: ttsCapabilities(
        hasTts ? { baseUrl: 'http://x/v1', model: 'mimo-v2.5-tts' } : null
      ),
      gatewayCall: async (method, params) => {
        calls.push({ method, params });
        return { audioBase64: Buffer.from('ID3').toString('base64'), mimeType: 'audio/mpeg' };
      },
      toasts: []
    });
    const bubble = makeEl('div');
    bubble.innerText = '这是一条回复';
    const started = mod.maybeAutoReadAssistantBubble(bubble, opts || {});
    return { started, calls, mod };
  }

  it('开关关闭时不朗读（默认行为）', () => {
    const { started, calls } = autoReadCase({ autoRead: false });
    expect(started).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('开关打开时朗读，并且和手动朗读走同一条 RPC', async () => {
    const { started, calls } = autoReadCase({ autoRead: true });
    expect(started).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0].method).toBe('speech.synthesize');
    expect(calls[0].params.text).toBe('这是一条回复');
  });

  it('失败 / 被中断 / 触到轮次上限的一轮不朗读', () => {
    for (const opts of [{ error: true }, { stopped: true }, { hitRoundLimit: true }]) {
      const { started } = autoReadCase({ autoRead: true, opts });
      expect(started).toBe(false);
    }
  });

  it('没有语音合成模型时开关打开也不朗读', () => {
    const { started } = autoReadCase({ autoRead: true, hasTts: false });
    expect(started).toBe(false);
  });
});

describe('splitTtsChunks（分句切块：首字 2~3 秒出声的前提）', () => {
  function load() {
    return loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: async () => ({}),
      toasts: []
    });
  }

  it('按句切块、合并到目标长度，且不丢内容', () => {
    const { splitTtsChunks } = load();
    const text = '第一句。第二句。第三句。第四句。'.repeat(6);
    const chunks = splitTtsChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    // 拼接（去空白）后与原文一致 —— 少念一句比念错更难发现
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    // 第一块要短：它决定多久能听到声音
    expect(chunks[0].length).toBeLessThanOrEqual(180);
  });

  it('单句超长时按上限切开，且不超过上限', () => {
    const { splitTtsChunks } = load();
    const long = '啊'.repeat(500); // 一整个没有标点的长句
    const chunks = splitTtsChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(180);
    expect(chunks.join('')).toBe(long);
  });

  it('不在 emoji / 扩展区汉字中间切（孤立代理项会合成出杂音）', () => {
    const { splitTtsChunks } = load();
    // 让第 180 位正好是 emoji 的高代理
    const text = `${'a'.repeat(179)}😀${'b'.repeat(50)}`;
    const chunks = splitTtsChunks(text);
    for (const c of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(c)).toBe(false);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('空白 / 空串不产生块', () => {
    const { splitTtsChunks } = load();
    expect(splitTtsChunks('   ')).toEqual([]);
    expect(splitTtsChunks('')).toEqual([]);
  });
});

describe('playTtsText', () => {
  it('长回复分块合成：第一块先合成先播，其余在后面继续合成', async () => {
    const calls = [];
    const { playTtsText, audioCalls } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: async (method, params) => {
        calls.push(params.text);
        return { audioBase64: Buffer.from('ID3').toString('base64'), mimeType: 'audio/mpeg' };
      },
      toasts: []
    });
    const text = `${'这是第一句话，用来验证分块合成。'.repeat(8)}`;
    await playTtsText(text, makeEl('button'));
    expect(calls.length).toBeGreaterThan(1);
    // 第一块的文本必须来自原文开头（否则「先出声」就成了念错地方）
    expect(text.startsWith(calls[0])).toBe(true);
    expect(audioCalls).toHaveLength(calls.length);
  });

  it('把该模型的完整配置传给 speech.synthesize 并播放返回音频', async () => {
    const calls = [];
    const toasts = [];
    const { playTtsText, audioCalls } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({
        baseUrl: 'http://192.168.31.62:5018/v1',
        apiKey: 'k',
        model: 'mimo-v2.5-tts',
        voice: '茉莉',
        format: 'mp3',
        headers: { 'x-app': 'dieyun' }
      }),
      gatewayCall: async (method, params) => {
        calls.push({ method, params });
        return { audioBase64: Buffer.from('ID3').toString('base64'), mimeType: 'audio/mpeg' };
      },
      toasts
    });
    const btn = makeEl('button');
    await playTtsText('你好', btn);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('speech.synthesize');
    expect(calls[0].params).toMatchObject({
      text: '你好',
      model: 'mimo-v2.5-tts',
      baseUrl: 'http://192.168.31.62:5018/v1',
      apiKey: 'k',
      voice: '茉莉',
      format: 'mp3',
      headers: { 'x-app': 'dieyun' },
      sessionId: 'sess-1'
    });
    expect(audioCalls).toHaveLength(1);
    expect(audioCalls[0].url).toBe('blob:fake-1');
    expect(audioCalls[0].played).toBe(true);
    // 念完（ended）后按钮自动回到「朗读」状态
    expect(btn.attrs['aria-pressed']).toBe('false');
    expect(toasts.filter((t) => t.opts?.variant === 'error')).toHaveLength(0);
  });

  it('上游报错时弹错误提示，不静默失败', async () => {
    const toasts = [];
    const { playTtsText } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: async () => {
        throw new Error('语音合成失败：Param Incorrect');
      },
      toasts
    });
    await playTtsText('你好', makeEl('button'));
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('朗读失败');
    expect(toasts[0].body).toContain('Param Incorrect');
  });

  it('没有可朗读文本时提示，且不发请求', async () => {
    let called = 0;
    const toasts = [];
    const { playTtsText } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: async () => {
        called += 1;
        return {};
      },
      toasts
    });
    await playTtsText('   ', makeEl('button'));
    expect(called).toBe(0);
    expect(toasts[0].title).toBe('朗读失败');
  });

  it('播放失败只报一次错，并带上 media 错误码（CSP 拦 blob: 时的现场）', async () => {
    const toasts = [];
    const { playTtsText } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: async () => ({
        audioBase64: Buffer.from('ID3').toString('base64'),
        mimeType: 'audio/mpeg'
      }),
      toasts,
      audioFails: true
    });
    await playTtsText('你好', makeEl('button'));
    // error 事件 + play() rejection 是同一件事，不能弹两条
    const errors = toasts.filter((t) => t.opts && t.opts.variant === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].title).toBe('朗读失败');
    expect(errors[0].body).toContain('code 4');
  });

  it('合成途中点「停止」：迟到的结果不许补播，也不许弹错', async () => {
    const toasts = [];
    const pending = [];
    const { playTtsText, stopTtsPlayback, audioCalls } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: () => new Promise((resolve) => pending.push(resolve)),
      toasts
    });
    const done = playTtsText('这条合成很慢', makeEl('button'));
    stopTtsPlayback(); // 用户等不及，点了停止 / 切了会话
    pending[0]({ audioBase64: Buffer.from('ID3').toString('base64'), mimeType: 'audio/mpeg' });
    await done;
    expect(audioCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it('点另一条回复等于切歌：旧请求作废，只播新的', async () => {
    const pending = [];
    const { playTtsText, audioCalls } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: (method, params) =>
        new Promise((resolve) => pending.push({ text: params.text, resolve })),
      toasts: []
    });
    const b64 = Buffer.from('ID3').toString('base64');
    const first = playTtsText('第一条', makeEl('button'));
    const second = playTtsText('第二条', makeEl('button'));
    // 两条请求都发出去了（不再被 ttsPending 静默吞掉）
    expect(pending.map((p) => p.text)).toEqual(['第一条', '第二条']);
    pending[0].resolve({ audioBase64: b64, mimeType: 'audio/mpeg' }); // 第一条迟到
    pending[1].resolve({ audioBase64: b64, mimeType: 'audio/mpeg' });
    await Promise.all([first, second]);
    expect(audioCalls).toHaveLength(1);
  });

  it('整篇重渲染后，正在朗读的那条能把「停止」接回新按钮', async () => {
    const pending = [];
    const { attachTtsBarToBubble, playTtsText, audioCalls } = loadTtsModule({
      settings: settingsWithTts,
      modelCapabilities: ttsCapabilities({ baseUrl: 'http://x/v1', model: 'm' }),
      gatewayCall: () => new Promise((resolve) => pending.push(resolve)),
      toasts: [],
      audioEnds: 'manual' // 要断言「正在播」，不能让它在断言前播完
    });
    const b64 = Buffer.from('ID3').toString('base64');
    const bubble1 = makeBubbleWithText('这条回复很长');
    const parent1 = makeEl('div');
    parent1.appendChild(bubble1);
    const btn1 = attachTtsBarToBubble(bubble1).children[0];
    const playing = playTtsText('这条回复很长', btn1);
    pending[0]({ audioBase64: b64, mimeType: 'audio/mpeg' });
    // 让「合成 → 造 URL → 起播」这条链推进到「正在播」
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audioCalls).toHaveLength(1);
    expect(btn1.classList.contains('is-speaking')).toBe(true);

    // 每轮结束会整篇重渲染：旧气泡与旧按钮一起被丢掉
    btn1.isConnected = false;
    const bubble2 = makeBubbleWithText('这条回复很长');
    const parent2 = makeEl('div');
    parent2.appendChild(bubble2);
    const btn2 = attachTtsBarToBubble(bubble2).children[0];
    expect(btn2.classList.contains('is-speaking')).toBe(true);
    expect(btn2.getAttribute('aria-pressed')).toBe('true');

    // 点新按钮 = 停止（而不是重新合成一遍）
    btn2.listeners.click();
    await playing;
    expect(audioCalls[0].paused).toBe(true);
    expect(pending).toHaveLength(1);
    expect(btn2.classList.contains('is-speaking')).toBe(false);
  });
});

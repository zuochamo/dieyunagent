'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  llmRawTapEnabled,
  llmRawTapFile,
  captureLlmRaw,
  createRawAccumulator,
  safeUrl
} = require('../../src/llm-raw-tap');
const { flushLog, closeLog } = require('../../src/logs/rotating-file-log');

const ENV_KEY = 'DIEYUN_LLM_RAW_LOG';
const FILE_NAME = 'llm-raw.log';

describe('llm-raw-tap · LLM 原始响应体抓包', () => {
  let tmpDir = '';
  let originalEnv;
  let file = '';

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-raw-tap-'));
    file = path.join(tmpDir, FILE_NAME);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    try {
      closeLog(file);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('默认关闭：不产生任何落盘', () => {
    delete process.env[ENV_KEY];
    expect(llmRawTapEnabled()).toBe(false);
    expect(llmRawTapFile()).toBe('');
    expect(captureLlmRaw({ mode: 'stream', raw: 'data: {"choices":[]}' })).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('`0` / `off` / `false` / `no` 都是关闭（否则把变量设成 0 会误以为开了）', () => {
    for (const value of ['0', 'off', 'FALSE', 'no', ' ']) {
      process.env[ENV_KEY] = value;
      expect(llmRawTapFile()).toBe('');
      expect(llmRawTapEnabled()).toBe(false);
    }
  });

  it('打开后把原始 SSE 原样落盘：content 与 reasoning_content 都在，可直接搜出归属', () => {
    process.env[ENV_KEY] = file;
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"结论在这里"}}]}\n\n' +
      'data: [DONE]\n\n';

    expect(
      captureLlmRaw({
        tag: { runId: 'run-1', round: 2, model: 'deepseek-chat' },
        mode: 'stream',
        url: 'https://api.example.com/v1/chat/completions',
        raw: sse
      })
    ).toBe(true);
    flushLog(file);

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('--- raw ---');
    expect(text).toContain('"reasoning_content":"先想一下"');
    expect(text).toContain('"content":"结论在这里"');
    expect(text).toContain('"round":2');
    expect(text).toContain('mode: stream');
  });

  it('URL 丢掉 query：密钥不会随 URL 一起进抓包文件', () => {
    process.env[ENV_KEY] = file;
    captureLlmRaw({
      mode: 'json',
      url: 'https://api.example.com/v1/chat/completions?api-key=SECRET-KEY',
      raw: '{"choices":[]}'
    });
    flushLog(file);

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('https://api.example.com/v1/chat/completions');
    expect(text).not.toContain('SECRET-KEY');
    expect(safeUrl('https://host/path?k=1')).toBe('https://host/path');
  });

  it('单条超限时留头又留尾：那句话既可能在首个 delta，也可能在收尾轮', () => {
    const acc = createRawAccumulator(2000);
    acc.push(`开头甲${'x'.repeat(3000)}`);
    acc.push('结尾乙');

    const out = acc.text();
    expect(out.startsWith('开头甲')).toBe(true);
    expect(out.endsWith('结尾乙')).toBe(true);
    expect(out).toContain('中段省略');
    expect(acc.droppedChars()).toBeGreaterThan(0);
  });

  it('非流式 JSON 响应体同样原样落盘', () => {
    process.env[ENV_KEY] = file;
    captureLlmRaw({
      mode: 'json',
      url: 'https://api.example.com/v1/chat/completions',
      raw: '{"choices":[{"message":{"content":"正文","reasoning_content":"思考"}}]}'
    });
    flushLog(file);

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('mode: json');
    expect(text).toContain('"reasoning_content":"思考"');
  });
});

'use strict';

const {
  resolveLlmEndpoint,
  parseHeaderLines,
  normalizeConfiguredHeaders,
  renderHeaderTemplate,
  buildAuthHeaders,
  buildLlmHeaders,
  RESERVED_HEADERS
} = require('../../src/agent/llm-request');

describe('resolveLlmEndpoint', () => {
  it('chat：裸 host 补 /v1/chat/completions', () => {
    expect(resolveLlmEndpoint('https://api.example.com')).toBe(
      'https://api.example.com/v1/chat/completions'
    );
  });

  it('chat：已带版本段只补资源路径', () => {
    expect(resolveLlmEndpoint('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions'
    );
    expect(resolveLlmEndpoint('https://api.example.com/v2/')).toBe(
      'https://api.example.com/v2/chat/completions'
    );
  });

  it('chat：已点到资源（含 Azure 查询串）原样返回', () => {
    const azure =
      'https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-02-01';
    expect(resolveLlmEndpoint(azure, 'chat')).toBe(azure);
  });

  it('models：与 chat 共用规则但资源路径不同', () => {
    expect(resolveLlmEndpoint('https://api.example.com', 'models')).toBe(
      'https://api.example.com/v1/models'
    );
    expect(resolveLlmEndpoint('https://api.example.com/v1/models', 'models')).toBe(
      'https://api.example.com/v1/models'
    );
  });

  it('embeddings：兼容 /embed 直连写法', () => {
    expect(resolveLlmEndpoint('https://api.example.com', 'embeddings')).toBe(
      'https://api.example.com/v1/embeddings'
    );
    expect(resolveLlmEndpoint('https://api.example.com/embed', 'embeddings')).toBe(
      'https://api.example.com/embed'
    );
  });

  it('embeddings：v2 版本段不再拼出 /v2/v1/embeddings（修正旧副本）', () => {
    expect(resolveLlmEndpoint('https://api.example.com/v2', 'embeddings')).toBe(
      'https://api.example.com/v2/embeddings'
    );
  });

  it('transcriptions：语音端点', () => {
    expect(resolveLlmEndpoint('https://api.example.com', 'transcriptions')).toBe(
      'https://api.example.com/v1/audio/transcriptions'
    );
  });

  it('未知 kind 回落 chat；空 baseUrl 返回空串', () => {
    expect(resolveLlmEndpoint('https://api.example.com', 'nope')).toBe(
      'https://api.example.com/v1/chat/completions'
    );
    expect(resolveLlmEndpoint('', 'chat')).toBe('');
    expect(resolveLlmEndpoint(null, 'chat')).toBe('');
  });
});

describe('parseHeaderLines', () => {
  it('解析 Key: Value 多行，忽略空行与注释', () => {
    expect(
      parseHeaderLines('# 注释\nX-Title: dieyun\n\nHTTP-Referer: https://a.b\n  X-N: 1  ')
    ).toEqual([
      ['X-Title', 'dieyun'],
      ['HTTP-Referer', 'https://a.b'],
      ['X-N', '1']
    ]);
  });

  it('值里的冒号保留（URL 场景）', () => {
    expect(parseHeaderLines('Origin: https://a.b:8443')).toEqual([
      ['Origin', 'https://a.b:8443']
    ]);
  });

  it('无冒号 / 冒号开头的行丢弃', () => {
    expect(parseHeaderLines('garbage\n: novalue')).toEqual([]);
  });
});

describe('normalizeConfiguredHeaders', () => {
  it('接受对象、字符串、数组三种输入', () => {
    expect(normalizeConfiguredHeaders({ 'X-A': '1' })).toEqual({ 'X-A': '1' });
    expect(normalizeConfiguredHeaders('X-A: 1')).toEqual({ 'X-A': '1' });
    expect(normalizeConfiguredHeaders([['X-A', '1']])).toEqual({ 'X-A': '1' });
  });

  it('空输入返回空对象', () => {
    expect(normalizeConfiguredHeaders(null)).toEqual({});
    expect(normalizeConfiguredHeaders(undefined)).toEqual({});
    expect(normalizeConfiguredHeaders('')).toEqual({});
  });

  it('剔除传输层头，避免破坏请求', () => {
    const out = normalizeConfiguredHeaders({
      Host: 'evil',
      'Content-Length': '0',
      Connection: 'close',
      'X-Ok': '1'
    });
    expect(out).toEqual({ 'X-Ok': '1' });
    for (const name of ['Host', 'Content-Length', 'Connection']) {
      expect(RESERVED_HEADERS.has(name.toLowerCase())).toBe(true);
    }
  });

  it('剔除非法头名（会让上游整请求 400）', () => {
    expect(normalizeConfiguredHeaders({ 'X Bad Name': '1', 'X-Good': '2' })).toEqual({
      'X-Good': '2'
    });
  });
});

describe('renderHeaderTemplate', () => {
  it('无占位符原样返回', () => {
    expect(renderHeaderTemplate('dieyun', {})).toBe('dieyun');
  });

  it('渲染 {{sessionId}}', () => {
    expect(renderHeaderTemplate('{{sessionId}}', { sessionId: 's-1' })).toBe('s-1');
    expect(renderHeaderTemplate('sess-{{ sessionId }}', { sessionId: 's-1' })).toBe('sess-s-1');
    expect(renderHeaderTemplate('{{sessionId}}-{{runId}}', { sessionId: 's', runId: 'r' })).toBe(
      's-r'
    );
  });

  it('任一占位符缺值 → 整条为空（不发半截头）', () => {
    expect(renderHeaderTemplate('{{sessionId}}', {})).toBe('');
    expect(renderHeaderTemplate('{{sessionId}}', { sessionId: '   ' })).toBe('');
    expect(renderHeaderTemplate('{{sessionId}}-{{runId}}', { sessionId: 's' })).toBe('');
  });
});

describe('buildAuthHeaders', () => {
  it('默认 Bearer', () => {
    expect(buildAuthHeaders('sk-1')).toEqual({ Authorization: 'Bearer sk-1' });
  });

  it('x-api-key 模式', () => {
    expect(buildAuthHeaders('sk-1', 'x-api-key')).toEqual({ 'x-api-key': 'sk-1' });
  });

  it('none / 空 key 不产生鉴权头', () => {
    expect(buildAuthHeaders('sk-1', 'none')).toEqual({});
    expect(buildAuthHeaders('')).toEqual({});
    expect(buildAuthHeaders('   ')).toEqual({});
  });
});

describe('buildLlmHeaders', () => {
  it('默认头：Content-Type + Bearer', () => {
    expect(buildLlmHeaders({ apiKey: 'sk-1' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-1'
    });
  });

  it('json:false 时不设 Content-Type（multipart 上传用）', () => {
    expect(buildLlmHeaders({ apiKey: 'sk-1', json: false })).toEqual({
      Authorization: 'Bearer sk-1'
    });
  });

  it('accept 与 User-Agent', () => {
    expect(buildLlmHeaders({ accept: 'application/json', userAgent: 'dieyun/1.0' })).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'dieyun/1.0'
    });
  });

  it('自定义头 + 占位符渲染（OpenCode Go 场景）', () => {
    const headers = buildLlmHeaders({
      apiKey: 'sk-1',
      userAgent: 'dieyunagent/1.0',
      headers: {
        'x-opencode-session': '{{sessionId}}',
        'HTTP-Referer': 'https://dieyun.ai'
      },
      vars: { sessionId: 'conv-42' }
    });
    expect(headers['x-opencode-session']).toBe('conv-42');
    expect(headers['HTTP-Referer']).toBe('https://dieyun.ai');
    expect(headers['User-Agent']).toBe('dieyunagent/1.0');
  });

  it('占位符无值 → 该头不发送（而不是发空值）', () => {
    const headers = buildLlmHeaders({
      apiKey: 'sk-1',
      headers: { 'x-opencode-session': '{{sessionId}}' },
      vars: {}
    });
    expect(Object.prototype.hasOwnProperty.call(headers, 'x-opencode-session')).toBe(false);
  });

  it('自定义头可覆盖 Authorization（显式配置优先）', () => {
    const headers = buildLlmHeaders({
      apiKey: 'sk-1',
      headers: { Authorization: 'Custom abc' }
    });
    expect(headers.Authorization).toBe('Custom abc');
  });

  it('自定义头无法注入传输层头', () => {
    const headers = buildLlmHeaders({
      apiKey: 'sk-1',
      headers: { Host: 'evil', 'X-Ok': '1' }
    });
    expect(headers.Host).toBeUndefined();
    expect(headers.host).toBeUndefined();
    expect(headers['X-Ok']).toBe('1');
  });

  it('无参调用不抛错', () => {
    expect(buildLlmHeaders()).toEqual({ 'Content-Type': 'application/json' });
  });
});

'use strict';

const {
  buildSessionTitleBody,
  cleanGeneratedTitle,
  resolveUserText,
  resolveReplyText,
  maybeGenerateSessionTitle,
  extractCompletionContent
} = require('../../src/agent/session-title');

/** 用假的 Gateway：记录调用，按 handler 返回。 */
function fakeGateway(handlers = {}) {
  const calls = [];
  const invokeRpc = async (method, params) => {
    calls.push({ method, params });
    const h = handlers[method];
    return typeof h === 'function' ? h(params) : undefined;
  };
  return { calls, invokeRpc };
}

const LLM = { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' };
const USER_TURN = { role: 'user', content: '历史对话的标题能不能让 AI 总结？' };

describe('cleanGeneratedTitle', () => {
  it('剥掉引号 / 「标题：」前缀 / 结尾标点，只留一行', () => {
    expect(cleanGeneratedTitle('「给历史对话加 AI 标题」')).toBe('给历史对话加 AI 标题');
    expect(cleanGeneratedTitle('标题：会话标题 AI 总结。')).toBe('会话标题 AI 总结');
    expect(cleanGeneratedTitle('第一行\n第二行解释')).toBe('第一行');
    expect(cleanGeneratedTitle('  **加粗**   多  空白  ')).toBe('**加粗** 多 空白');
  });

  it('按上限截断，空内容返回空串（当失败处理）', () => {
    expect(cleanGeneratedTitle('一二三四五六七八九十', 4)).toBe('一二三四');
    expect(cleanGeneratedTitle('   \n  ', 20)).toBe('');
    expect(cleanGeneratedTitle(null, 20)).toBe('');
    expect(cleanGeneratedTitle('。。。', 20)).toBe('');
  });
});

describe('buildSessionTitleBody', () => {
  it('带上用户需求与答复节选，并要求不超过上限', () => {
    const body = buildSessionTitleBody({
      model: 'm',
      userText: '把历史标题改成 AI 总结',
      replyText: '已实现 session-title.js',
      maxChars: 24
    });
    expect(body.model).toBe('m');
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('把历史标题改成 AI 总结');
    expect(body.messages[1].content).toContain('已实现 session-title.js');
    expect(body.messages[1].content).toContain('24');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('没有答复时只发用户需求', () => {
    const body = buildSessionTitleBody({ model: 'm', userText: '查天气', replyText: '', maxChars: 16 });
    expect(body.messages[1].content).not.toContain('本轮答复节选');
  });
});

describe('resolveUserText / resolveReplyText', () => {
  it('取最后一条真实用户消息，并剥掉落库 meta', () => {
    const messages = [
      { role: 'user', content: '旧需求' },
      { role: 'assistant', content: '旧答复' },
      { role: 'user', content: '【叠云meta】{"inputText":"新需求"}\n新需求' }
    ];
    expect(resolveUserText(messages)).toBe('新需求');
  });

  it('跳过合成用户轮（[系统] / 完成验收），不留空标题素材', () => {
    const messages = [
      { role: 'user', content: '真需求' },
      { role: 'user', content: '[系统] 本段工具轮次已达上限，请收尾' },
      { role: 'user', content: '【完成验收】检查一下' }
    ];
    expect(resolveUserText(messages)).toBe('真需求');
    expect(resolveUserText([])).toBe('');
  });

  it('答复节选优先用本轮 done.content，没有才回退最后一条 assistant', () => {
    const messages = [{ role: 'assistant', content: '消息里的答复' }];
    expect(resolveReplyText({ content: '本轮正文' }, messages)).toBe('本轮正文');
    expect(resolveReplyText({ content: '' }, messages)).toBe('消息里的答复');
    expect(resolveReplyText({}, [])).toBe('');
  });
});

describe('maybeGenerateSessionTitle', () => {
  it('首次生成：写库并返回标题', async () => {
    const gw = fakeGateway({ 'memory.session_get': () => ({ titleSource: 'heuristic' }) });
    const titles = [];
    const title = await maybeGenerateSessionTitle({
      invokeRpc: gw.invokeRpc,
      llm: LLM,
      sessionId: 's1',
      messages: [USER_TURN],
      done: { content: '可以，加一个标题生成器' },
      fetchTitleOnce: async ({ body }) => {
        titles.push(body);
        return { choices: [{ message: { content: '「会话标题 AI 总结」' } }] };
      }
    });
    expect(title).toBe('会话标题 AI 总结');
    expect(titles).toHaveLength(1);
    const write = gw.calls.find((c) => c.method === 'memory.session_set_title');
    expect(write.params).toEqual({ sessionId: 's1', title: '会话标题 AI 总结', source: 'ai' });
  });

  it('已有 AI 标题的会话不再调模型（每会话只生成一次）', async () => {
    const gw = fakeGateway({ 'memory.session_get': () => ({ titleSource: 'ai' }) });
    let called = 0;
    const title = await maybeGenerateSessionTitle({
      invokeRpc: gw.invokeRpc,
      llm: LLM,
      sessionId: 's1',
      messages: [USER_TURN],
      done: { content: 'x' },
      fetchTitleOnce: async () => {
        called += 1;
        return { choices: [{ message: { content: '不该出现' } }] };
      }
    });
    expect(title).toBeNull();
    expect(called).toBe(0);
    expect(gw.calls.map((c) => c.method)).not.toContain('memory.session_set_title');
  });

  it('用户改过名的标题同样不覆盖', async () => {
    const gw = fakeGateway({ 'memory.session_get': () => ({ titleSource: 'user' }) });
    const title = await maybeGenerateSessionTitle({
      invokeRpc: gw.invokeRpc,
      llm: LLM,
      sessionId: 's1',
      messages: [USER_TURN],
      done: {},
      fetchTitleOnce: async () => ({ choices: [{ message: { content: '不该出现' } }] })
    });
    expect(title).toBeNull();
  });

  it('模型失败 / 空标题 / 被停止的轮次都不写库', async () => {
    const ai = fakeGateway({ 'memory.session_get': () => ({ titleSource: 'heuristic' }) });
    const failing = await maybeGenerateSessionTitle({
      invokeRpc: ai.invokeRpc,
      llm: LLM,
      sessionId: 's1',
      messages: [USER_TURN],
      done: { content: 'x' },
      fetchTitleOnce: async () => {
        throw new Error('boom');
      }
    });
    expect(failing).toBeNull();
    expect(ai.calls.map((c) => c.method)).not.toContain('memory.session_set_title');

    const empty = await maybeGenerateSessionTitle({
      invokeRpc: ai.invokeRpc,
      llm: LLM,
      sessionId: 's1',
      messages: [USER_TURN],
      done: { content: 'x' },
      fetchTitleOnce: async () => ({ choices: [{ message: { content: '   ' } }] })
    });
    expect(empty).toBeNull();

    const aborted = await maybeGenerateSessionTitle({
      invokeRpc: ai.invokeRpc,
      llm: LLM,
      sessionId: 's1',
      messages: [USER_TURN],
      done: { aborted: true },
      fetchTitleOnce: async () => ({ choices: [{ message: { content: '不该出现' } }] })
    });
    expect(aborted).toBeNull();
  });

  it('缺 sessionId / 缺 baseUrl / 无用户文本 / 无 Gateway 一律跳过', async () => {
    const gw = fakeGateway({ 'memory.session_get': () => ({ titleSource: 'heuristic' }) });
    const base = { llm: LLM, messages: [USER_TURN], done: {} };
    expect(await maybeGenerateSessionTitle({ ...base, invokeRpc: gw.invokeRpc })).toBeNull();
    expect(
      await maybeGenerateSessionTitle({ ...base, invokeRpc: gw.invokeRpc, sessionId: 's1', llm: {} })
    ).toBeNull();
    expect(
      await maybeGenerateSessionTitle({
        ...base,
        invokeRpc: gw.invokeRpc,
        sessionId: 's1',
        messages: []
      })
    ).toBeNull();
    expect(await maybeGenerateSessionTitle({ ...base, sessionId: 's1' })).toBeNull();
  });

  it('extractCompletionContent 兼容裸字符串与 {content}', () => {
    expect(extractCompletionContent('裸标题')).toBe('裸标题');
    expect(extractCompletionContent({ content: 'a' })).toBe('a');
    expect(extractCompletionContent({ choices: [{ message: { content: 'b' } }] })).toBe('b');
    expect(extractCompletionContent(null)).toBe('');
  });
});

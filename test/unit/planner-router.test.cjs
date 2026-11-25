import { describe, it, expect, vi } from 'vitest';

const router = require('../../src/agent/planner-router.js');

describe('planner-router / 解析判定（只认结构化 use）', () => {
  it('合法 JSON → use + reason', () => {
    const r = router.parsePlannerRoute('{"use":true,"reason":"多个模块各自要改"}');
    expect(r).toEqual({ use: true, reason: '多个模块各自要改' });
  });

  it('带 markdown 围栏 / 前后废话也能取到对象', () => {
    const r = router.parsePlannerRoute('好的：\n```json\n{"use":false,"reason":"只是问一句"}\n```');
    expect(r).toEqual({ use: false, reason: '只是问一句' });
  });

  it('use 不是布尔 → 不可用（不猜中文“要/不要”）', () => {
    expect(router.parsePlannerRoute('{"use":"yes","reason":"x"}')).toBeNull();
    expect(router.parsePlannerRoute('{"reason":"x"}')).toBeNull();
  });

  it('空 / 非 JSON → 不可用', () => {
    expect(router.parsePlannerRoute('')).toBeNull();
    expect(router.parsePlannerRoute('要拆')).toBeNull();
    expect(router.parsePlannerRoute('{"use":tru')).toBeNull();
  });
});

describe('planner-router / 请求体', () => {
  it('用户文本截到 2000 字，system 里带「拿不准就 false」', () => {
    const body = router.buildPlannerRouteBody({ userText: 'x'.repeat(5000), model: 'm' });
    expect(body.messages[0].content).toContain('拿不准就 false');
    expect(body.messages[1].content.length).toBeLessThan(5000);
    expect(body.max_tokens).toBe(router.ROUTER_MAX_OUTPUT_TOKENS);
    expect(body.stream).toBe(false);
    // 判定轮不给工具：给了它就会去调，而不是回答这个布尔
    expect(body.tools).toBeUndefined();
  });

  it('有工作区时带上，帮助判断「几件事」', () => {
    const body = router.buildPlannerRouteBody({ userText: 'hi', workspacePath: 'F:\\DesktopPet' });
    expect(body.messages[1].content).toContain('F:\\DesktopPet');
  });
});

describe('planner-router / 侧模型配置', () => {
  it('缺 model 或缺 baseUrl 都当没配（半套配置只会撞 401）', () => {
    expect(router.resolvePlannerRouterConfig({})).toBeNull();
    expect(router.resolvePlannerRouterConfig({ plannerRouterModel: 'm' })).toBeNull();
    expect(router.resolvePlannerRouterConfig({ plannerRouterBaseUrl: 'http://x/v1' })).toBeNull();
  });

  it('配全了才生效', () => {
    expect(
      router.resolvePlannerRouterConfig({
        plannerRouterModel: 'glm-5.3-flash',
        plannerRouterBaseUrl: 'http://x/v1',
        plannerRouterApiKey: 'k'
      })
    ).toEqual({ model: 'glm-5.3-flash', apiConfig: { baseUrl: 'http://x/v1', apiKey: 'k' } });
  });
});

describe('planner-router / 判定永不抛错（失败即不拆）', () => {
  it('没有用户文本 → 不拆', async () => {
    const r = await router.routeTurnToPlanner({ userText: '   ' });
    expect(r.use).toBe(false);
  });

  it('没有可用模型/端点 → 不拆', async () => {
    const r = await router.routeTurnToPlanner({ userText: '改三个模块', apiConfig: {} });
    expect(r.use).toBe(false);
    expect(r.reason).toContain('判定模型');
  });

  it('上游回了合法判定 → 按它走，并回报 side/main 来源', async () => {
    const coreBridge = {
      invoke: vi.fn(async () => ({ content: '{"use":true,"reason":"三个模块并行"}' }))
    };
    const r = await router.routeTurnToPlanner({
      userText: '把 A/B/C 三个模块各自补上测试',
      model: 'main-model',
      apiConfig: { baseUrl: 'http://x/v1', apiKey: 'k' },
      coreBridge
    });
    expect(r.use).toBe(true);
    expect(r.reason).toBe('三个模块并行');
    expect(r.model).toBe('main-model');
    expect(r.source).toBe('main');
    // 判定思考必须一起交出去（用户要能看见它凭什么这么判）
    expect(r.thinking).toContain('use');
  });

  it('思考通道优先于正文：判定模型的推理要能展示', async () => {
    const coreBridge = {
      invoke: vi.fn(async () => ({
        content: '{"use":false,"reason":"单点改动"}',
        reasoning: '用户只提到一个文件，没有并行价值'
      }))
    };
    const r = await router.routeTurnToPlanner({
      userText: '把标题改一下',
      model: 'm',
      apiConfig: { baseUrl: 'http://x/v1', apiKey: 'k' },
      coreBridge
    });
    expect(r.use).toBe(false);
    expect(r.thinking).toBe('用户只提到一个文件，没有并行价值');
  });

  it('思考过长要截断（卡片里能读就行）', () => {
    const long = 'x'.repeat(router.ROUTER_THINKING_MAX_CHARS + 50);
    const out = router.summarizeThinking(long, '');
    expect(out.length).toBe(router.ROUTER_THINKING_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(router.summarizeThinking('', '')).toBe('');
  });

  it('侧模型配了就优先用侧模型', async () => {
    const coreBridge = { invoke: vi.fn(async () => ({ content: '{"use":false,"reason":"单文件"}' })) };
    const r = await router.routeTurnToPlanner({
      userText: '把标题改一下',
      model: 'main-model',
      apiConfig: { baseUrl: 'http://main/v1', apiKey: 'mk' },
      settings: {
        plannerRouterModel: 'side-model',
        plannerRouterBaseUrl: 'http://side/v1',
        plannerRouterApiKey: 'sk'
      },
      coreBridge
    });
    expect(r.use).toBe(false);
    expect(r.model).toBe('side-model');
    expect(r.source).toBe('side');
  });

  it('上游只回垃圾（比如只有思考）→ 不拆，不把整轮拖进 planner', async () => {
    const coreBridge = { invoke: vi.fn(async () => ({ content: '' })) };
    const r = await router.routeTurnToPlanner({
      userText: '做完了？',
      model: 'm',
      apiConfig: { baseUrl: 'http://x/v1', apiKey: 'k' },
      coreBridge
    });
    expect(r.use).toBe(false);
  });

  it('请求失败 → 不拆（不抛错）', async () => {
    const coreBridge = {
      invoke: vi.fn(async () => {
        throw new Error('LLM_API: HTTP 500');
      })
    };
    const r = await router.routeTurnToPlanner({
      userText: '把 A/B 两个模块各改一处',
      model: 'm',
      apiConfig: { baseUrl: 'http://x/v1', apiKey: 'k' },
      coreBridge
    });
    expect(r.use).toBe(false);
    expect(r.reason).toContain('判定失败');
  });
});

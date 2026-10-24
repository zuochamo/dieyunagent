'use strict';
/**
 * MCP 配置弹窗的环境变量区必须**按服务声明了几个变量就渲染几个输入框**。
 *
 * 复现的问题：那里原本是一个写死的 `#mcp-config-env`，键名由服务端单个 `envHint` 决定，
 * 于是 mcp-postgres 的第二个变量（`MCP_DATABASE_URLS`）根本没有入口 —— 只能手改 mcp.json。
 *
 * `src/renderer/renderer-skills-ui.js` 是浏览器脚本（`<script>` 直接加载，没有 module.exports），
 * 所以这里用 `new Function` 造一个只带 window/document/$ 的求值环境，取出真实的
 * renderMcpEnvFields / collectMcpEnvValues 来断言 —— 与 composer-draft-session.test.cjs 同一手法。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-skills-ui.js');

/** 够用的元素替身：只实现被测函数真正用到的那几个成员 */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    dataset: {},
    className: '',
    textContent: '',
    value: '',
    type: '',
    id: '',
    hidden: false,
    checked: false,
    placeholder: '',
    spellcheck: false,
    autocomplete: '',
    onchange: null,
    append(...nodes) {
      el.children.push(...nodes);
    },
    appendChild(node) {
      el.children.push(node);
      return node;
    },
    /** 生产代码用 `list.innerHTML = ''` 清空列表 */
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.dataset && child.dataset.envName) out.push(child);
          walk(child);
        }
      };
      if (String(selector).includes('data-env-name')) walk(el);
      return out;
    }
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: (value) => {
      if (String(value) === '') el.children.length = 0;
    }
  });
  return el;
}

/**
 * 文件尾部是打包层用的 `window.X = renderY` 导出块，其中不少符号定义在**同批加载的其它脚本**里
 * （如 renderGridCategoryTabs 在 renderer-skills-grid.js）。单独求值本文件时它们并不存在，
 * 而导出块与被测函数无关，故先切掉 —— 只保留声明与函数体。
 */
function stripTopLevelWindowExports(source) {
  const lines = source.split('\n');
  const cut = lines.findIndex((line) => /^window\.[A-Za-z_$][\w$]*\s*=/.test(line));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n');
}

function loadSkillsUi() {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, makeEl('div'));
    return els.get(id);
  };
  for (const id of [
    'mcp-config-env-list',
    'mcp-config-env-hint',
    'mcp-config-env-reveal-wrap',
    'mcp-config-env-reveal'
  ]) {
    get(id);
  }
  const source = stripTopLevelWindowExports(fs.readFileSync(SRC, 'utf8'));
  const factory = new Function(
    'window',
    'document',
    '$',
    `${source}
    return { renderMcpEnvFields, collectMcpEnvValues };`
  );
  const api = factory({}, { createElement: (tag) => makeEl(tag) }, get);
  return { api, get };
}

/** 一次渲染后的输入框（输入框在每一行的第 2 个孩子） */
function inputsOf(get) {
  return get('mcp-config-env-list').children.map((row) => row.children[1]);
}

describe('MCP 配置弹窗的环境变量区', () => {
  it('声明几个变量就渲染几个输入框，并逐项给出状态', () => {
    const { api, get } = loadSkillsUi();
    api.renderMcpEnvFields({
      envRequirement: 'any',
      envHints: [
        {
          name: 'DATABASE_URL',
          label: '主库连接串（单库）',
          hint: '形如 postgresql://用户:口令@主机:5432/库名',
          required: true,
          saved: true
        },
        {
          name: 'MCP_DATABASE_URLS',
          label: '多库连接串（可选）',
          hint: '分隔符是分号',
          required: true,
          saved: false
        }
      ]
    });

    const rows = get('mcp-config-env-list').children;
    expect(rows).toHaveLength(2);
    expect(inputsOf(get).map((input) => input.dataset.envName)).toEqual([
      'DATABASE_URL',
      'MCP_DATABASE_URLS'
    ]);
    // 默认掩码，避免连接串里的口令直接显示在屏幕上
    expect(inputsOf(get).every((input) => input.type === 'password')).toBe(true);

    expect(rows[0].children[0].textContent).toContain('主库连接串');
    expect(rows[0].children[2].textContent).toContain('已就位');
    expect(rows[1].children[2].textContent).toContain('分号');
    // 互为替代的服务要说清「填一个就行」，否则用户以为两个都必须填
    expect(get('mcp-config-env-hint').textContent).toContain('database');
    expect(get('mcp-config-env-reveal-wrap').hidden).toBe(false);
  });

  it('收集时只提交填了值的项（留空＝不修改已保存的值）', () => {
    const { api, get } = loadSkillsUi();
    api.renderMcpEnvFields({
      envHints: [
        { name: 'DATABASE_URL', saved: true },
        { name: 'MCP_DATABASE_URLS', saved: false }
      ]
    });
    const [first, second] = inputsOf(get);
    expect(api.collectMcpEnvValues()).toEqual({});

    second.value = 'dz=postgresql://role_dz:pw@h:5432/daizhang';
    expect(api.collectMcpEnvValues()).toEqual({
      MCP_DATABASE_URLS: 'dz=postgresql://role_dz:pw@h:5432/daizhang'
    });

    first.value = 'postgresql://root:pw@h:5432/dieyun_biz';
    expect(Object.keys(api.collectMcpEnvValues()).sort()).toEqual([
      'DATABASE_URL',
      'MCP_DATABASE_URLS'
    ]);
  });

  it('重新打开弹窗不会残留上一次的输入（每次都重建）', () => {
    const { api, get } = loadSkillsUi();
    const config = { envHints: [{ name: 'A', saved: false }] };
    api.renderMcpEnvFields(config);
    inputsOf(get)[0].value = 'leftover';
    api.renderMcpEnvFields(config);
    expect(inputsOf(get)).toHaveLength(1);
    expect(api.collectMcpEnvValues()).toEqual({});
  });

  it('未声明环境变量的服务：不渲染输入框、隐藏显示明文开关', () => {
    const { api, get } = loadSkillsUi();
    api.renderMcpEnvFields({ envHints: [] });
    expect(get('mcp-config-env-list').children).toHaveLength(0);
    expect(get('mcp-config-env-hint').textContent).toBe('无需额外环境变量');
    expect(get('mcp-config-env-reveal-wrap').hidden).toBe(true);
  });

  it('勾选「显示明文」把已渲染的输入框全部切成 text，取消后切回', () => {
    const { api, get } = loadSkillsUi();
    api.renderMcpEnvFields({
      envHints: [{ name: 'A' }, { name: 'B' }]
    });
    const reveal = get('mcp-config-env-reveal');
    expect(reveal.checked).toBe(false);
    expect(typeof reveal.onchange).toBe('function');

    reveal.checked = true;
    reveal.onchange();
    expect(inputsOf(get).every((input) => input.type === 'text')).toBe(true);

    reveal.checked = false;
    reveal.onchange();
    expect(inputsOf(get).every((input) => input.type === 'password')).toBe(true);
  });

  it('解不开的凭据提示「请重新填写」而不是「请填写」', () => {
    const { api, get } = loadSkillsUi();
    api.renderMcpEnvFields({
      envHints: [{ name: 'DATABASE_URL', saved: false, undecryptable: true }]
    });
    expect(get('mcp-config-env-list').children[0].children[2].textContent).toContain('无法解密');
  });

  it('非 any 模式（多变量都要填）提示还缺哪些', () => {
    const { api, get } = loadSkillsUi();
    api.renderMcpEnvFields({
      envRequirement: 'all',
      envHints: [{ name: 'A', saved: true }, { name: 'B', saved: false }]
    });
    expect(get('mcp-config-env-hint').textContent).toContain('B');
    expect(get('mcp-config-env-hint').textContent).toContain('还需填写');
  });
});

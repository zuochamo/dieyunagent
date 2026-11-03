'use strict';

/**
 * 「MCP 凭据文件损坏」必须被摆到列表上方，而不是静默当空。
 *
 * 复现的问题：`mcp-secrets.json` 解析不出来时，之前的表现是列表里每个服务都像「没配过」。
 * 用户照着再填一次，保存就把整份文件重写成只剩这一条 —— 其余服务的 Token / 环境变量一起消失。
 * 现在 storage 层会拒绝这种写入（`SECRET_STORE_CORRUPT`，见 `test/unit/secret-store.test.cjs`），
 * UI 层则负责**提前告知**：提示条 + 「备份并重建」。
 *
 * 与 `mcp-env-fields-ui.test.cjs` 同一手法：Renderer 文件是浏览器脚本，
 * 用 `new Function` 造一个只带最小替身的求值环境，取真实函数来断言。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-skills-ui.js');

function makeEl(id) {
  return { id, hidden: true, textContent: '' };
}

/** 文件尾部的 `window.X = ...` 导出块引用了其它脚本的符号，与本次被测函数无关，先切掉 */
function stripTopLevelWindowExports(source) {
  const lines = source.split('\n');
  const cut = lines.findIndex((line) => /^window\.[A-Za-z_$][\w$]*\s*=/.test(line));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n');
}

function loadSkillsUi({ health, reset, confirmAnswer = true } = {}) {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  get('mcp-credentials-warning');
  get('mcp-credentials-warning-text');

  const calls = { health: 0, reset: 0 };
  const skillsApi = {
    mcpCredentialsHealth: async () => {
      calls.health += 1;
      if (typeof health === 'function') return health();
      return health || { corrupt: false, message: '' };
    },
    mcpCredentialsReset: async () => {
      calls.reset += 1;
      return typeof reset === 'function' ? reset() : reset || { moved: false, backupPath: '' };
    }
  };
  const source = stripTopLevelWindowExports(fs.readFileSync(SRC, 'utf8'));
  const factory = new Function(
    'window',
    'document',
    '$',
    'skillsApi',
    'showAgentToast',
    `${source}
    return { refreshMcpCredentialsWarning, resetMcpCredentialsStore };`
  );
  const toasts = [];
  const api = factory(
    { confirm: () => confirmAnswer },
    { createElement: () => makeEl('div') },
    get,
    skillsApi,
    (...args) => toasts.push(args)
  );
  return { api, get, calls, toasts };
}

describe('MCP 凭据文件损坏提示', () => {
  it('文件正常：提示条保持隐藏', async () => {
    const { api, get } = loadSkillsUi({ health: { corrupt: false, message: '' } });
    await api.refreshMcpCredentialsWarning();
    expect(get('mcp-credentials-warning').hidden).toBe(true);
  });

  it('文件损坏：提示条显形并说清「读不出来 + 先备份重建」', async () => {
    const { api, get } = loadSkillsUi({
      health: { corrupt: true, message: 'mcp-secrets.json 解析失败（…）' }
    });
    await api.refreshMcpCredentialsWarning();
    const box = get('mcp-credentials-warning');
    expect(box.hidden).toBe(false);
    const text = get('mcp-credentials-warning-text').textContent;
    expect(text).toContain('无法解析');
    expect(text).toContain('备份并重建');
    expect(text).toContain('会被拦截');
  });

  it('健康度接口失败时不挡页面：提示条不显示，也不抛', async () => {
    const { api, get } = loadSkillsUi({
      health: () => {
        throw new Error('ipc down');
      }
    });
    await expect(api.refreshMcpCredentialsWarning()).resolves.toBeUndefined();
    expect(get('mcp-credentials-warning').hidden).toBe(true);
  });

  it('用户取消「备份并重建」时不动任何文件', async () => {
    const { api, calls } = loadSkillsUi({ confirmAnswer: false });
    await api.resetMcpCredentialsStore();
    expect(calls.reset).toBe(0);
  });
});

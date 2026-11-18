'use strict';

/**
 * `tool-validate` 双跑夹具（docs/NODE-THINNING-PLAN.md N2.1 第二段）
 *
 * 夹具是**校验口径的契约**：每条「工具 + 入参 → 期望结论」。
 *   ① 现在：手写 `validateToolArgs` 必须全部通过（这是基线）；
 *   ② 之后：`tool-validate.generated.js` 落地时，**同一份夹具要在新实现上也全绿** ——
 *      任何一条结论变了，就是口径漂了，得逐条判「旧代码漏了还是新代码过严」。
 *
 * 只覆盖纯机械分支（语义块 computer / mcp_* / apply_patch / ssh 的凭据与路径正则不在此列）；
 * 覆盖面由 `coverage` 字段声明，用例数由下面的守卫兜住 —— 加分支却忘了加用例会红。
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateToolArgs } = require('../../src/agent/tool-validate');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tool-args-cases.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const MIN_CASES = 40;
const MIN_CASES_PER_TOOL = 2;

describe('tool-validate 双跑夹具（口径契约）', () => {
  test('夹具本身有覆盖度下限（防止「加了分支忘加用例」）', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    const perTool = new Map();
    for (const c of fixture.cases) perTool.set(c.tool, (perTool.get(c.tool) || 0) + 1);
    const thin = fixture.coverage.filter((t) => (perTool.get(t) || 0) < MIN_CASES_PER_TOOL);
    expect(thin).toEqual([]);
    // 夹具里的工具都必须被 coverage 声明（防「加了用例但没声明覆盖」）
    const undeclared = [...perTool.keys()].filter((t) => !fixture.coverage.includes(t));
    expect(undeclared).toEqual([]);
  });

  test('每条用例的结论与错误码都与当前实现一致', () => {
    const mismatches = [];
    for (const c of fixture.cases) {
      const result = validateToolArgs(c.tool, c.args, {});
      const ok = !!(result && result.ok);
      if (ok !== c.expect.ok) {
        mismatches.push(
          `${c.tool}（${c.why}）：期望 ok=${c.expect.ok}，实际 ok=${ok}（${result && (result.error || result.errorCode) || '无'}）`
        );
        continue;
      }
      if (c.expect.errorCode && result && result.errorCode !== c.expect.errorCode) {
        mismatches.push(
          `${c.tool}（${c.why}）：期望 errorCode=${c.expect.errorCode}，实际 ${result && result.errorCode}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('拒绝时一定要给 errorCode 与可读 error（模型要能据此重试）', () => {
    const bad = [];
    for (const c of fixture.cases) {
      const result = validateToolArgs(c.tool, c.args, {});
      if (result && result.ok === false) {
        if (!result.errorCode) bad.push(`${c.tool}（${c.why}）：缺 errorCode`);
        if (!result.error || !String(result.error).trim()) bad.push(`${c.tool}（${c.why}）：缺 error`);
      }
    }
    expect(bad).toEqual([]);
  });
});

'use strict';

/**
 * 技能与项目约定：skill_create（agent-home.createUserSkill）/ skill_delete（agent-home.deleteUserSkill）/ agents_md_propose（propose-tools-main）。
 * 扫描根白名单、种子技能保护、提议 diff 的组装都在各自的单一来源里，这里只搬参数。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createSkillsHandlers(shared) {
  const {
    gateway,
    userDataPath,
    createUserSkill,
    onSkillsChanged,
    deleteUserSkill,
    deps,
    executeAgentsMdProposeMain
  } = shared;

  return {
    agents_md_propose: async (a, ctx) => executeAgentsMdProposeMain(gateway, a, ctx, userDataPath),
    skill_create: async (a, ctx) => {
        if (!createUserSkill) return { error: '技能创建不可用' };
        const created = await createUserSkill(deps.userDataPath, ctx.workspacePath || null, {
          name: a.name,
          description: a.description,
          content: a.content
        });
        if (typeof onSkillsChanged === 'function') {
          try {
            onSkillsChanged(created);
          } catch {
            // ignore
          }
        }
        return {
          ok: true,
          name: created.name,
          dir: created.dir,
          skillPath: created.skillPath,
          message: `技能「${created.name}」已创建`
        };
    },
    skill_delete: async (a, ctx) => {
        // 与设置页删除按钮共用 agent-home.js#deleteUserSkill（扫描根白名单 + 种子技能保护）
        const dir = String(a.dir || '').trim();
        if (!dir) return { ok: false, error: 'skill_delete 需要 dir', errorCode: 'MISSING_ARG', retryable: false };
        try {
          const r = await deleteUserSkill(userDataPath, ctx.workspacePath || ctx.worktreePath || null, dir);
          if (typeof onSkillsChanged === 'function') {
            try {
              onSkillsChanged({ deleted: r.dir });
            } catch {
              // ignore
            }
          }
          return { ok: true, dir: r.dir, message: '技能目录已删除' };
        } catch (err) {
          return {
            ok: false,
            error: String((err && err.message) || err || '删除失败'),
            errorCode: 'SKILL_DELETE_FAILED',
            retryable: false
          };
        }
    }
  };
}

module.exports = { createSkillsHandlers };

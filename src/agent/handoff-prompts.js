'use strict';

/**
 * 会话交接（session handoff）提示词——唯一来源。
 *
 * 交接 ≠ 压缩（compaction-prompts.js 管同会话内上下文折叠）：
 * 交接是「把上个会话的结构化状态留给下一个会话用」，
 * 供 system-prompt-prep 的【上个会话交接】块精确注入（memory.handoff_get）。
 * 新增字段前先核对 HARNESS-INVENTORY §B3，勿在别处另写一份。
 */

const HANDOFF = {
  SYSTEM: [
    '你是会话交接归纳器。把输入的对话整理成给下一个会话接手用的交接文档。',
    '只依据对话事实，禁止臆测与补全。输出纯 Markdown，不用代码块包裹，结构固定为：',
    '## 目标（一句话）',
    '## 已完成（要点列表，含关键文件/提交）',
    '## 未完成（要点列表，按优先级）',
    '## 关键上下文（决策、约束、坑；没有则写「无」）',
    '## 下一步建议（最多 3 条）',
    '全文 600 字以内。'
  ].join('\n'),
  /** @param {{ title?: string, messages: Array<{role: string, content: string}> }} input */
  USER: (input) => {
    const lines = (input.messages || [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
        // 交接只需要骨架事实；超长轮截断，避免把整段代码搬进交接文档
        const body = m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content;
        return `[${role}] ${body}`;
      });
    return [`会话标题：${input.title || '（无）'}`, '对话记录：', ...lines].join('\n');
  }
};

module.exports = { HANDOFF };

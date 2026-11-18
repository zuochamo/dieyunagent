'use strict';

/**
 * 可被工具 / 维护流程写入的 AGENTS.md 区块（`changelog` 由系统自动维护，不对外暴露）。
 *
 * **单一来源**，三个消费者：
 *   - 执行侧 `src/agents-md.js`（模板 / 校验）；
 *   - 工具 schema `src/agent/catalog/memory.js`（`section.enum`）；
 *   - 手写校验 `src/agent/tool-validate.js`（从 schema 读 enum）。
 *
 * 为什么单独一个文件而不是放在 `agents-md.js` 里：catalog 会被打进 **Renderer bundle**，
 * `agents-md.js` 依赖 fs/path/crypto，esbuild 会直接构建失败（2026-11-18 实测）。
 * 这个文件必须保持**零依赖**。
 */
const EDITABLE_SECTION_IDS = [
  'overview',
  'structure',
  'commands',
  'conventions',
  'testing',
  'architecture',
  'gotchas'
];

module.exports = { EDITABLE_SECTION_IDS };

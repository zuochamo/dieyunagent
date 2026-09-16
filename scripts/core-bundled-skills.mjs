/**
 * 仓库内可维护的技能白名单（verify / vendor / prune）。
 * 安装包 extraResources 只打入天气；见 package.json build.extraResources。
 */
export const CORE_MINIMAX_IDS = [
  'frontend-dev',
  'fullstack-dev',
  'minimax-docx',
  'minimax-pdf',
  'minimax-xlsx',
  'pptx-generator',
  'minimax-multimodal-toolkit',
  'vision-analysis'
];

export const CORE_CURATED_IDS = [
  'multi-search-engine',
  'baidu-search',
  'weather-china',
  'skill-vetter',
  'skill-creator'
];

export const CORE_WEATHER = 'weather/SKILL.md';

export const CORE_REQUIRED = [
  ...CORE_MINIMAX_IDS.map((id) => `minimax/${id}/SKILL.md`),
  ...CORE_CURATED_IDS.map((id) => `curated/${id}/SKILL.md`),
  CORE_WEATHER
];

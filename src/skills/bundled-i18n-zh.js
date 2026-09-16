'use strict';

/** 预装技能中文简介（与 SKILL.md 中 description 成对展示） */
const ZH_BY_SKILL_KEY = {
  weather: '查询中国及全球城市实时天气（温度、湿度、风力等），须用 web_fetch 调用 Open-Meteo，勿编造气温。',
  'curated:skill-vetter':
    '安装第三方技能前的安全审查：检查权限范围、可疑模式与红旗项，避免恶意 Skill。',
  'curated:skill-creator': '在用户目录创建符合规范的 SKILL.md 技能包，含名称与描述 frontmatter。',
  'curated:multi-search-engine':
    '多搜索引擎聚合（含百度、必应、Google 等），无需 API Key，支持站点限定与时间过滤。',
  'curated:weather-china': '专用于中国城市天气查询，用 web_fetch 调用 Open-Meteo，勿编造气温。',
  'curated:baidu-search': '通过百度搜索关键词；可打开结果页或结合多引擎技能获取摘要。',
  'minimax:frontend-dev': 'MiniMax 前端工作室：高质感页面、动效、AI 素材与文案一体化落地。',
  'minimax:fullstack-dev': 'MiniMax 全栈开发：前后端协作、接口设计与完整产品交付流程。',
  'minimax:minimax-docx': 'MiniMax Word 文档：创建、编辑、套模板与国标/论文格式排版（.docx）。',
  'minimax:minimax-pdf': 'MiniMax PDF：阅读、提取、合并拆分与版式处理。',
  'minimax:minimax-xlsx': 'MiniMax Excel：表格读写、公式、透视与数据整理。',
  'minimax:pptx-generator': 'MiniMax PPT：生成与编辑演示文稿、版式与图表。',
  'minimax:minimax-multimodal-toolkit': 'MiniMax 多模态工具包：图文音混合任务编排。',
  'minimax:vision-analysis': 'MiniMax 图像分析：识图、OCR 与视觉问答。',
  'minimax:minimax-music-gen': 'MiniMax 音乐生成：根据描述生成音乐片段。',
  'minimax:minimax-music-playlist': 'MiniMax 歌单/音乐组织与播放列表相关能力。',
  'minimax:buddy-sings': 'MiniMax 歌声合成与演唱风格相关生成。',
  'minimax:gif-sticker-maker': 'MiniMax GIF/贴纸制作与动图导出。',
  'minimax:shader-dev': 'MiniMax Shader 开发：WebGL/GLSL 特效与可视化。',
  'minimax:react-native-dev': 'MiniMax React Native 移动应用开发。',
  'minimax:flutter-dev': 'MiniMax Flutter 跨平台应用开发。',
  'minimax:ios-application-dev': 'MiniMax iOS 原生应用开发。',
  'minimax:android-native-dev': 'MiniMax Android 原生应用开发。'
};

/**
 * @param {string} skillKey meta.skillKey 或推导的 builtin id
 */
function zhDescriptionForSkillKey(skillKey) {
  if (!skillKey) return '';
  const k = String(skillKey).trim();
  if (ZH_BY_SKILL_KEY[k]) return ZH_BY_SKILL_KEY[k];
  const bare = k.replace(/^builtin:/, '');
  return ZH_BY_SKILL_KEY[bare] || '';
}

module.exports = { ZH_BY_SKILL_KEY, zhDescriptionForSkillKey };

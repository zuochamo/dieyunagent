/* global window, document, $ */
'use strict';

const I18N_KEY = 'diecloud.ui.language.v1';
const I18N_DEFAULT = 'zh-CN';

const I18N_MESSAGES = {
  'zh-CN': {
    app_title: '叠云 Agent',
    menu_settings: '设置',
    menu_mobile: '手机连接',
    menu_help: '帮助',
    history_title: '历史对话',
    history_folder_unbound: '未绑定工作区',
    history_time_now: '刚刚',
    new_chat: '新对话',
    new_chat_in_folder: '在此工作空间新建对话',
    remove_folder: '移除此工作空间',
    remove_folder_confirm: '确定移除「%s」及其下的 %d 条对话？此操作不可恢复。',
    workspace_unset: '未设置工作空间',
    mention_codebase_desc: '工作区语义检索',
    model_auto: '自动模式',
    builtin_models: '供应商',
    custom_models: '自定义模型',
    config_custom_models: '配置自定义模型',
    send: '发送',
    stop: '停止',
    artifacts: '产物',
    side_panel: '工作区面板',
    side_panel_title: '工作区面板（文件 / 浏览器 / 终端）',
    settings_model: '模型',
    settings_theme: '主题',
    settings_worktrees: 'Worktree',
    settings_database: '数据库',
    settings_plugins: '插件',
    settings_perms: '权限',
    settings_agent_knowledge: '知识',
    settings_extensions: '扩展',
    settings_skills_list: '技能',
    settings_mcp: 'MCP',
    settings_automation: '定时',
    settings_components: '组件',
    model_defined: '定义模型',
    model_embedding: '向量索引',
    model_graph: '结构索引',
    model_builtin: '供应商',
    theme_dark_title: '黑色主题',
    theme_dark_desc: '深色背景，适合弱光环境',
    theme_light_title: '白色主题',
    theme_light_desc: '浅色背景，高对比正文',
    theme_color_label: '颜色主题',
    theme_dark_short: '深色',
    theme_light_short: '浅色',
    language_label: '界面语言',
    language_zh: '中文',
    language_en: 'English',
    font_size: '界面字体大小',
    opacity: '窗口透明度',
    color_temperature: '色温',
    color_temp_neutral: '中性',
    color_temp_cool: '冷',
    color_temp_warm: '暖',
    theme_auto_launch: '开机自启',
    theme_auto_launch_hint: '开发模式下不可用；请使用安装包。',
    theme_long_horizon: '长程 Agent 任务',
    trace_reasoning: '显示推理摘要',
    trace_titles: '显示思考标题',
    trace_shell: '展开 Shell 工具部分',
    trace_edit: '展开编辑工具部分',
    help_usage: '使用说明',
    help_stats: '统计信息',
    help_logs: '运行日志',
    help_about: '关于应用',
    connected: '已连接',
    disconnected: '未连接',
    gateway_connected: 'Gateway 已连接',
    gateway_disconnected: 'Gateway 未连接',
    stat_keys: '今日按键',
    stat_clicks: '鼠标点击',
    stat_tokens_today: '今日 Token',
    stat_prompt_tokens: '输入 Token',
    stat_completion_tokens: '输出 Token',
    stat_cached_tokens: '缓存命中',
    stat_hit_today: '今日命中率',
    stat_hit_month: '本月命中率',
    stat_version: '版本',
    stat_gateway: '本地 Gateway',
    chart_today: '今天模型用量',
    chart_month: '本月模型用量',
    no_model_usage: '暂无模型调用',
    mobile_connect_title: '手机连接',
    mobile_connect_browser: '用手机浏览器扫码打开',
    mobile_connect_desc: '手机需与电脑在同一内网。手机端只负责查看会话、同步思考过程、发送任务和停止任务，实际执行仍在电脑完成。',
    mobile_connect_url: '连接地址',
    copy_link: '复制',
    refresh: '刷新',
    close: '关闭',
    close_tray: '关闭到托盘',
    minimize: '最小化',
    maximize: '最大化',
    restore: '向下还原'
  },
  en: {
    app_title: 'Dieyun Agent',
    menu_settings: 'Settings',
    menu_mobile: 'Mobile',
    menu_help: 'Help',
    history_title: 'Conversations',
    history_folder_unbound: 'No workspace',
    history_time_now: 'now',
    new_chat: 'New conversation',
    new_chat_in_folder: 'New chat in this workspace',
    remove_folder: 'Remove this workspace',
    remove_folder_confirm: 'Remove “%s” and its %d conversations? This cannot be undone.',
    workspace_unset: 'No workspace selected',
    mention_codebase_desc: 'Workspace semantic search',
    model_auto: 'Auto mode',
    builtin_models: 'Suppliers',
    custom_models: 'Custom models',
    config_custom_models: 'Configure custom models',
    send: 'Send',
    stop: 'Stop',
    artifacts: 'Artifacts',
    side_panel: 'Workspace panel',
    side_panel_title: 'Workspace panel (files / browser / terminal)',
    settings_model: 'Models',
    settings_theme: 'Theme',
    settings_worktrees: 'Worktree',
    settings_database: 'Database',
    settings_plugins: 'Plugins',
    settings_perms: 'Permissions',
    settings_agent_knowledge: 'Knowledge',
    settings_extensions: 'Extensions',
    settings_skills_list: 'Skills',
    settings_mcp: 'MCP',
    settings_automation: 'Timed',
    settings_components: 'Components',
    model_defined: 'Custom models',
    model_embedding: 'Vector index',
    model_graph: 'Structure index',
    model_builtin: 'Suppliers',
    theme_dark_title: 'Dark theme',
    theme_dark_desc: 'Dark surfaces for low-light use',
    theme_light_title: 'Light theme',
    theme_light_desc: 'Bright surfaces with high-contrast text',
    theme_color_label: 'Color theme',
    theme_dark_short: 'Dark',
    theme_light_short: 'Light',
    language_label: 'Interface language',
    language_zh: '中文',
    language_en: 'English',
    font_size: 'Interface font size',
    opacity: 'Window opacity',
    color_temperature: 'Color temperature',
    color_temp_neutral: 'Neutral',
    color_temp_cool: 'Cool',
    color_temp_warm: 'Warm',
    theme_auto_launch: 'Launch at startup',
    theme_auto_launch_hint: 'Not available in development; use the installed app.',
    theme_long_horizon: 'Long-horizon agent tasks',
    trace_reasoning: 'Show reasoning summary',
    trace_titles: 'Show thought titles',
    trace_shell: 'Expand Shell tool sections',
    trace_edit: 'Expand edit tool sections',
    help_usage: 'Guide',
    help_stats: 'Stats',
    help_logs: 'Logs',
    help_about: 'About',
    connected: 'Connected',
    disconnected: 'Disconnected',
    gateway_connected: 'Gateway connected',
    gateway_disconnected: 'Gateway disconnected',
    stat_keys: 'Keystrokes today',
    stat_clicks: 'Mouse clicks',
    stat_tokens_today: 'Tokens today',
    stat_prompt_tokens: 'Input tokens',
    stat_completion_tokens: 'Output tokens',
    stat_cached_tokens: 'Cache hits',
    stat_hit_today: 'Hit rate today',
    stat_hit_month: 'Hit rate this month',
    stat_version: 'Version',
    stat_gateway: 'Local Gateway',
    chart_today: 'Model usage today',
    chart_month: 'Model usage this month',
    no_model_usage: 'No model calls yet',
    mobile_connect_title: 'Mobile connection',
    mobile_connect_browser: 'Scan with your mobile browser',
    mobile_connect_desc: 'Keep your phone and computer on the same LAN. Mobile only views conversations, syncs thoughts, sends tasks, and stops tasks; execution still happens on the computer.',
    mobile_connect_url: 'Connection URL',
    copy_link: 'Copy',
    refresh: 'Refresh',
    close: 'Close',
    close_tray: 'Close to tray',
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore'
  }
};

function normalizeLanguage(lang) {
  return lang === 'en' ? 'en' : I18N_DEFAULT;
}

function getLanguage() {
  try {
    return normalizeLanguage(window.localStorage.getItem(I18N_KEY));
  } catch {
    return I18N_DEFAULT;
  }
}

function i18nText(key, lang = getLanguage()) {
  return I18N_MESSAGES[lang]?.[key] || I18N_MESSAGES[I18N_DEFAULT]?.[key] || key;
}

function agentLanguagePrompt(lang = getLanguage()) {
  const normalized = normalizeLanguage(lang);
  if (normalized === 'en') {
    return [
      '【Response Language】',
      'The interface language is English. Prefer English for explanations and final answers.',
      'Keep code, commands, file paths, logs, and exact error messages in their original language. If the user explicitly asks for another language, follow the user.'
    ].join('\n');
  }
  return [
    '【回答语言】',
    '当前界面语言是中文。除非用户明确要求其它语言，解释、总结、追问和最终回答都尽量使用中文。',
    '代码、命令、文件路径、日志、API 字段、错误原文、专有名词可以保留原文；不要为了中文而翻译会影响准确性的内容。'
  ].join('\n');
}

function applyLanguage(lang) {
  const next = normalizeLanguage(lang);
  try {
    window.localStorage.setItem(I18N_KEY, next);
  } catch {
    // ignore
  }
  document.documentElement.lang = next;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = i18nText(el.dataset.i18n, next);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', i18nText(el.dataset.i18nPlaceholder, next));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', i18nText(el.dataset.i18nTitle, next));
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', i18nText(el.dataset.i18nAria, next));
  });
  document.querySelectorAll('.language-choice').forEach((btn) => {
    btn.classList.toggle('active', normalizeLanguage(btn.dataset.language) === next);
  });
  document.title = i18nText('app_title', next);
  window.dispatchEvent(new CustomEvent('dieyun:language-change', { detail: { language: next } }));
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.language-choice').forEach((btn) => {
    btn.addEventListener('click', () => applyLanguage(btn.dataset.language));
  });
  applyLanguage(getLanguage());
});

window.dieyunI18n = {
  getLanguage,
  setLanguage: applyLanguage,
  t: i18nText,
  agentLanguagePrompt
};

function uiText(key, fallback) {
  const translated = i18nText(key);
  if (translated != null && translated !== '' && translated !== key) return translated;
  return fallback != null ? fallback : key;
}

function t(key) {
  return i18nText(key);
}

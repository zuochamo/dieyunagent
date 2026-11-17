'use strict';

/**
 * catalog 里跨域共用的参数片段（模型可见文案）。
 * 「本机路径」与浏览器 frame/force/mode/annotate 这几段被多个工具拼进 description/parameters，
 * 抄第二份就会出现「同一参数两种说法」——它们是 schema 文案，不是执行逻辑。
 */

/**
 * 「本机路径」那句提示的**唯一来源**：凡接受路径参数的工具都拼它。
 * 语义实现（前缀解析、白名单、沙箱判定）在 `src/gateway/host-local.js` +
 * `gateway/rpc.js:resolveFsTarget`；这里只是模型可见的那一句，改口径只改这一处。
 */
const LOCAL_PATH_HINT =
  '路径写 local: 前缀 = 本机（跑叠云这台机器）的文件，例 local:C:\\Users\\me\\AppData\\Roaming\\dieyunagent\\auth.json；' +
  '不带前缀的路径一律指当前会话工作空间（SSH 会话里就是远端主机）。';


/**
 * frame 定位参数：所有目标类/观测类浏览器工具共用同一语义。
 * 单一来源，避免每个工具各写一套描述导致模型用法不一致。
 */
const FRAME_PARAM = {
  type: 'string',
  description:
    '目标 frame：省略或 "main" 为顶层；"0"、"0.1" 为 frame 路径（按文档顺序的 iframe 下标链）；"/正则/" 匹配 frame URL；含 "/" 或 "://" 视为 URL 子串；其它视为 frame 的 name。先用 browser_frames 看 frame 树。'
};
const FORCE_PARAM = {
  type: 'boolean',
  description: '目标被遮挡时仍强制点击/输入（默认 false：会先重试到超时，再明确回报被谁遮挡）'
};
const SNAPSHOT_MODE_PARAM = {
  type: 'string',
  description:
    'interactive（默认，语义化可交互元素）| all（额外含无 role 但 cursor:pointer 的可点容器，如 Vue @click 的 div、菜单项）| dom（所有可见元素，纯结构视图）'
};
const ANNOTATE_PARAM = {
  type: 'boolean',
  description: 'true 时在截图上叠加 ref 编号方框，便于像素级核对元素位置（截完自动清除，不污染页面）'
};


module.exports = {
  LOCAL_PATH_HINT,
  FRAME_PARAM,
  FORCE_PARAM,
  SNAPSHOT_MODE_PARAM,
  ANNOTATE_PARAM
};

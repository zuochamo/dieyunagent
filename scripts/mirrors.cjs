'use strict';

/**
 * 国内镜像地址的唯一来源（供构建脚本共用）。
 *
 * 为什么不写 `.npmrc`：`electron_mirror` 这类自定义键在 npm 11 已被判为「未知配置」，
 * 每跑一次 npm 就刷 4 条 warn，官方明确说下个大版本会直接报错。镜像本质是进程环境变量，
 * 由本模块注入即可，不依赖 npm 是否愿意把自定义键透传成 `npm_config_*`。
 *
 * 需要手动装依赖时（如清库后自己 `npm install`）：
 *   PowerShell:  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
 *   或直接跑 `npm run bootstrap`（bootstrap 会调 applyMirrorEnv）。
 */

const NPM_REGISTRY = 'https://registry.npmmirror.com';
const ELECTRON_MIRROR_URL = 'https://npmmirror.com/mirrors/electron/';
const ELECTRON_BUILDER_BINARIES_MIRROR_URL =
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

/**
 * 只补默认值：外部已显式设置的环境变量不覆盖（海外/代理环境可以自己指）。
 * @param {Record<string, string | undefined>} [env]
 */
function applyMirrorEnv(env = process.env) {
  if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = ELECTRON_MIRROR_URL;
  if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) {
    env.ELECTRON_BUILDER_BINARIES_MIRROR = ELECTRON_BUILDER_BINARIES_MIRROR_URL;
  }
  return env;
}

module.exports = {
  NPM_REGISTRY,
  ELECTRON_MIRROR_URL,
  ELECTRON_BUILDER_BINARIES_MIRROR_URL,
  applyMirrorEnv
};

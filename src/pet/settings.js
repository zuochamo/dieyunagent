'use strict';

/**
 * 宠物（设置 → 宠物 → 点点）设置的唯一来源：默认值、夹取、读写 `<userData>/pet/settings.json`。
 *
 * 为什么是 Main 侧 JSON 而不是 localStorage：设置 UI（主窗口）与点点悬浮窗是**两个渲染进程**，
 * 必须有一份双方都认的权威状态；悬浮窗的创建/销毁/尺寸也发生在 Main，.Main 侧一份文件 + IPC
 * 广播是唯一权威（同 `alive/settings.json` 的做法）。
 *
 * 数字边界（size/motion 的夹取区间）只在这一份里；HTML 滑杆的 min/max 只是 UI 提示，权威以这里的夹取为准。
 * 色板在 `src/renderer/pet-window/pet-shapes.js`（渲染与校验共用同一份，纯函数无 DOM，Main 可直接 require）。
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_COLOR, isValidColorId } = require('../renderer/pet-window/pet-shapes');

const PET_DIR_NAME = 'pet';
const SETTINGS_FILE_NAME = 'settings.json';

/** 窗口边长倍率：1.0 = 基准 280px（基准值在 pet-window.js，这里是合法区间与默认值）。默认 0.75 = 210px */
const SIZE_MIN = 0.6;
const SIZE_MAX = 1.8;
const SIZE_DEFAULT = 0.75;
/** 动效强度：0 = 静止，2 = 明显活泼；作用于呼吸/摆动/自转/涟漪幅度 */
const MOTION_MIN = 0;
const MOTION_MAX = 2;
const MOTION_DEFAULT = 1.0;
/** 点数量：形态表按点数重新生成。64 以下猫脸/笔画读不出 */
const COUNT_MIN = 64;
const COUNT_MAX = 512;
const COUNT_DEFAULT = 128;
/** 点大小：单点渲染半径的倍率（0.5×–2×）。默认 0.5 = 基准点半径的一半（用户定） */
const DOT_SCALE_MIN = 0.5;
const DOT_SCALE_MAX = 2;
const DOT_SCALE_DEFAULT = 0.5;

const DEFAULTS = Object.freeze({
  /**
   * 预装默认关闭：没有 `pet/settings.json`（新装 / 从没点过开关）就是不显示。
   * 判定口径是「只有显式 true 才显示」——'no' / 0 / 缺键一律当关，错在保守一侧（桌面上不凭空多一个悬浮体）。
   */
  enabled: false,
  /** 绑定生命感：体征映射到动效（疲劳下垂/负载噪声/事件涟漪）+ 心跳轮的它可调 pet_set/pet_act。闲逛日程保留作兜底 */
  aliveBind: true,
  count: COUNT_DEFAULT,
  size: SIZE_DEFAULT,
  motion: MOTION_DEFAULT,
  dotScale: DOT_SCALE_DEFAULT,
  color: DEFAULT_COLOR,
  /** 悬浮窗左上角（DIP）。null = 未拖过，用默认位（主屏工作区右下角） */
  x: null,
  y: null
});

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 归一化：人可以手改 settings.json，读进来与打进来（IPC patch）的都要夹一次；
 * 非法值一律退默认（错在保守一侧）。
 */
function normalizePetSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const color = isValidColorId(src.color) ? src.color : DEFAULT_COLOR;
  const hasPoint = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  return {
    enabled: src.enabled === true,
    aliveBind: src.aliveBind !== false,
    count: Math.round(clampNum(src.count, COUNT_MIN, COUNT_MAX, COUNT_DEFAULT)),
    size: clampNum(src.size, SIZE_MIN, SIZE_MAX, SIZE_DEFAULT),
    motion: clampNum(src.motion, MOTION_MIN, MOTION_MAX, MOTION_DEFAULT),
    dotScale: clampNum(src.dotScale, DOT_SCALE_MIN, DOT_SCALE_MAX, DOT_SCALE_DEFAULT),
    color,
    x: hasPoint(src.x) ? clampNum(src.x, -20000, 20000, 0) : null,
    y: hasPoint(src.y) ? clampNum(src.y, -20000, 20000, 0) : null
  };
}

function petSettingsPath(userDataPath) {
  return path.join(userDataPath, PET_DIR_NAME, SETTINGS_FILE_NAME);
}

function loadPetSettings(userDataPath) {
  try {
    const text = fs.readFileSync(petSettingsPath(userDataPath), 'utf8');
    return normalizePetSettings(JSON.parse(text));
  } catch {
    // 文件缺失/损坏都退默认：宠物设置不是关键数据，不值得为它做迁移或告警链
    return normalizePetSettings(null);
  }
}

/** 原子写（tmp + rename），同 alive/store 的落盘纪律 */
function savePetSettings(userDataPath, settings) {
  const file = petSettingsPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读-改-写一个 patch；返回归一化后的完整设置。唯一写入口，调用方不要再各写一份合并逻辑 */
function patchPetSettings(userDataPath, patch) {
  const current = loadPetSettings(userDataPath);
  const merged = normalizePetSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  savePetSettings(userDataPath, merged);
  return merged;
}

module.exports = {
  DEFAULTS,
  SIZE_MIN,
  SIZE_MAX,
  MOTION_MIN,
  MOTION_MAX,
  COUNT_MIN,
  COUNT_MAX,
  DOT_SCALE_MIN,
  DOT_SCALE_MAX,
  normalizePetSettings,
  petSettingsPath,
  loadPetSettings,
  savePetSettings,
  patchPetSettings
};

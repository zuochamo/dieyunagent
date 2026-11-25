'use strict';

/**
 * 点点「猫」形态的步态（纯函数，无 DOM / 无 electron）：把「走路」写成
 * 支撑相/摆动相占空比的腿摆 + 脚掌抬落 + 躯干起伏 + 尾巴慢摆，输出逐点偏移量。
 *
 * 为什么单独一份：步态是**几何 + 时间**的函数，与渲染/窗口无关；放在这里才能被
 * 离线预览脚本与单元测试直接驱动（`test/unit/pet-gait.test.cjs`），
 * `pet.js` 只负责把偏移量加到自己那批变量上。
 *
 * 步态是**对角交替的四拍步行**：右前 → 左后 → 左前 → 右后，每条腿相差 1/4 拍。
 * 坐标口径与形态表一致：单位空间、y 向上、猫面朝右；点云是侧视描边，前后腿区各画着
 * 两笔（远侧那条 + 近侧那条），四笔就是四条腿。
 *
 * 三个几何前提（来自 `CAT_CLOUD` 的实测，`test/unit/pet-gait.test.cjs` 会替它们把关）：
 *   - 脚线 y ≈ -0.95 / 背线 y ≈ +0.32 / 腹线（两腿之间那段横线）y ≈ -0.41..-0.46
 *   - 后腿团块 x ∈ [-0.63, -0.02]，前腿团块 x ∈ [0.08, 0.63]
 *   - 尾巴卷在左上加一根垂到脚线附近：x ≤ -0.68 或 (x < -0.55 且 y > -0.18)
 * 换了轮廓图要先重测这几处，否则腿会被切错（症状：腹线被拽走 / 尾巴跟着腿抖）。
 *
 * 为什么用「按深度线性摆」而不是绕枢轴旋转：这是**描边**点云（不是实心体），
 * 旋转会把腿根那条描边跟腹线撕开一道口子；按离髋深度线性位移则是连续场，
 * 髋不动、脚掌满幅，脚掌高度只由抬脚量决定 —— 支撑相脚是踩住地面的，不会溜冰。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetCatGait = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  /**
   * 判定线：腹线以下才算腿。腹线本身在 y ≈ -0.41..-0.46（两腿之间的那段横线），
   * 所以判定线要压到它下面 —— 否则腿一转就把腹线一起拽走。
   */
  const LEG_TOP_Y = -0.47;

  /**
   * 四条腿：猫是**对角交替的四拍步行**，落足顺序 右前 → 左后 → 左前 → 右后
   * （每条腿相差 1/4 拍；同一侧的前后腿相差也是 1/4，看起来才是走而不是小跑）。
   *
   * 轮廓是侧视描边，每条腿只画成一笔，所以前后各两笔 = 「远侧那条 + 近侧那条」：
   *   - 后腿区 x ∈ [-0.68, -0.02]：左笔 = 左后（远），右笔 = 右后（近）
   *   - 前腿区 x ∈ [-0.02, 0.72]：左笔 = 左前（远），右笔 = 右前（近）
   * 两条腿的位移在分界处**交叉淡入淡出**（同一个连续场），所以描边不会被撕开。
   */
  const ZONES = [
    {
      id: 'hind',
      hipY: -0.46,
      xMin: -0.68,
      xMax: -0.02,
      /** 远近两笔的分界与过渡宽度（实测：两笔中心约 -0.55 / -0.25） */
      midX: -0.40,
      blend: 0.16,
      farPhase: 0.75, // 左后
      nearPhase: 0.25 // 右后
    },
    {
      id: 'front',
      hipY: -0.46,
      xMin: -0.02,
      xMax: 0.72,
      /** 实测：两笔中心约 0.20 / 0.50 */
      midX: 0.35,
      blend: 0.16,
      farPhase: 0.5, // 左前
      nearPhase: 0.0 // 右前
    }
  ];
  /** 落足顺序（测试与文档共用这一份） */
  const FOOTFALL_ORDER = [
    { id: 'RF', zone: 'front', phase: 0.0 },
    { id: 'LH', zone: 'hind', phase: 0.75 },
    { id: 'LF', zone: 'front', phase: 0.5 },
    { id: 'RH', zone: 'hind', phase: 0.25 }
  ];
  const TAIL = { baseX: -0.58, baseY: 0.30 };
  const HEAD = { xMin: 0.55, yMin: 0.05 };

  /** 支撑相占空比：猫步行大部分时间脚着地（0.66 ≈ 任意时刻两到三只脚着地） */
  const DUTY = 0.66;
  /** 摆动相抬脚高度（单位空间） */
  const LIFT = 0.13;
  /** 脚掌横向半行程（单位空间）：走起来一步 ≈ 体长的 1/5 */
  const STRIDE = 0.18;
  /** 腿长（髋到脚掌），把 STRIDE 换算成「每单位深度摆多少」 */
  const LEG_DEPTH = 0.5;
  /** 躯干起伏：每周期两次（每落一只脚沉一下），头只吃 HEAD_BOB（猫的头部稳定） */
  const BOB = 0.04;
  const HEAD_BOB = 0.3;
  /** 头自己的小点头：跟着前脚落地，每周期两次、幅度很小（全抑制会像假头） */
  const HEAD_NOD = 0.01;
  /** 躯干前后轻摆（推进感）：比起伏小一个量级，否则像在抖 */
  const SWAY = 0.018;
  /** 尾巴：随步伐轻摆（沿长度有延迟，越靠尖越大）+ 静止时的慢摆 */
  const TAIL_WALK = 0.085;
  const TAIL_IDLE = 0.05;
  /** 抬脚权重沿腿长渐入：关节不抬、脚掌抬满（不然整条腿离地像被提起来） */
  const LIFT_RAMP = 0.3;
  /** 背线沿 x 的行波（躯干起伏不只整体上下，猫的背是「一节一节」往前的） */
  const SPINE_WAVE = 0.02;

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function smoothstep(v) {
    const t = clamp01(v);
    return t * t * (3 - 2 * t);
  }

  function isTail(x, y) {
    return x <= -0.68 || (x < -0.55 && y > -0.18);
  }

  function isHead(x, y) {
    return x > HEAD.xMin && y > HEAD.yMin;
  }

  /** 相位 u∈[0,1) → 腿的相对角度（+ = 脚在前）与抬脚高度 0..1 */
  function limbState(u, out) {
    const t = u - Math.floor(u);
    if (t < DUTY) {
      // 支撑相：脚贴地不动，身体前进 → 腿相对身体匀速向后扫
      out.theta = 1 - (2 * t) / DUTY;
      out.lift = 0;
      return out;
    }
    // 摆动相：快速收回，脚走弧线（前慢后快由 smoothstep 给）
    const s = (t - DUTY) / (1 - DUTY);
    out.theta = -1 + 2 * smoothstep(s);
    out.lift = Math.sin(Math.PI * s);
    return out;
  }

  /**
   * 远侧那条腿的「在后面」处理：轮廓是描边，四条腿只能靠**明暗与粗细**分出前后
   * （不往 z 后面推 —— 透视是按画面中心缩放的，推远了脚掌会被抬离地面线）。
   * 只作用于远侧那条，权重是连续场（分界处渐变），不会撕描边。
   */
  const FAR_SHADE = 0.5;

  const limbFar = { theta: 0, lift: 0 };
  const limbNear = { theta: 0, lift: 0 };

  /**
   * 逐点算步态偏移（写进 outDx/outDy，长度 ≥ count）。
   * opts: { phase（弧度，一个周期 = 2π）, amp（0..N，0 = 站着不动；>1 = 动效强度调高后更活泼）, tMs（时钟，尾巴静止慢摆用） }
   * outShade（可选）: 亮度/粗细乘子 0..1，远侧腿更暗更细（渲染层据此调 alpha 与点半径）
   */
  function computeGait(rest, count, opts, outDx, outDy, outShade) {
    const o = opts || {};
    const phase = Number(o.phase) || 0;
    const amp = Math.max(0, Number(o.amp) || 0);
    const tMs = Number(o.tMs) || 0;
    const cycle = phase / (Math.PI * 2); // 0..1 的周期相位

    const bobBody = -BOB * amp * Math.cos(4 * Math.PI * cycle);
    const swayBody = SWAY * amp * Math.sin(2 * Math.PI * cycle);
    const tailIdle = TAIL_IDLE * Math.sin(tMs * 0.00055);

    for (let i = 0; i < count; i++) {
      const x = rest[i * 3];
      const y = rest[i * 3 + 1];
      outDx[i] = 0;
      outDy[i] = 0;
      if (outShade) outShade[i] = 1;

      if (isTail(x, y)) {
        // 尾巴：绕尾根转，摆动沿长度延迟（尾尖甩得晚一点才像尾巴）
        const dx = x - TAIL.baseX;
        const dy = y - TAIL.baseY;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 1.2);
        const a = (TAIL_WALK * amp * Math.sin(2 * Math.PI * cycle - 1.4 * d) + tailIdle) * (0.45 + 0.9 * d);
        const c = Math.cos(a);
        const s = Math.sin(a);
        outDx[i] = TAIL.baseX + dx * c - dy * s - x;
        outDy[i] = TAIL.baseY + dx * s + dy * c - y;
        continue;
      }

      const zone = y < LEG_TOP_Y ? (x < ZONES[1].xMin ? ZONES[0] : ZONES[1]) : null;
      if (zone && x > zone.xMin && x < zone.xMax) {
        // 远近两条腿各按自己的相位踩/抬；分界处按 x 交叉分配权重（连续场，不撕描边）
        const wNear = smoothstep((x - (zone.midX - zone.blend)) / (2 * zone.blend));
        const wFar = 1 - wNear;
        const far = limbState(cycle + zone.farPhase, limbFar);
        const near = limbState(cycle + zone.nearPhase, limbNear);
        const theta = far.theta + (near.theta - far.theta) * wNear;
        const lift = far.lift + (near.lift - far.lift) * wNear;
        const depth = zone.hipY - y; // 离髋多深（脚掌 ≈ LEG_DEPTH）
        outDx[i] = amp * (STRIDE / LEG_DEPTH) * theta * depth;
        outDy[i] = amp * LIFT * lift * smoothstep(depth / LIFT_RAMP);
        // 远侧那条往后站：压暗 + 变细（渲染层乘在 alpha 与点半径上）
        if (outShade) outShade[i] = 1 - (1 - FAR_SHADE) * wFar;
        continue;
      }

      // 躯干 / 头：起伏 + 前后轻摆 + 背线行波；头抑制大部分起伏、只留一点点自己点头
      const head = isHead(x, y);
      const k = head ? HEAD_BOB : 1;
      const spine = y > LEG_TOP_Y ? SPINE_WAVE * amp * Math.sin(2 * Math.PI * cycle - x * 3.1) : 0;
      const nod = head ? HEAD_NOD * amp * Math.sin(4 * Math.PI * cycle) : 0;
      outDx[i] = swayBody * k;
      outDy[i] = bobBody * k + spine + nod;
    }
    return { dx: outDx, dy: outDy };
  }

  return {
    LEG_TOP_Y,
    ZONES,
    FOOTFALL_ORDER,
    TAIL,
    HEAD,
    DUTY,
    LIFT,
    STRIDE,
    LEG_DEPTH,
    FAR_SHADE,
    isTail,
    isHead,
    limbState,
    computeGait
  };
});

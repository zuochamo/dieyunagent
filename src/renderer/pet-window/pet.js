/* global PetShapes, PetCatGait, petHost */
'use strict';

/**
 * 点点本体：128 个点 = 128 组变量（身体即状态）。
 *
 * 每个点的变量：rest（形态目标）/ pos / vel（弹簧）/ phase（闲置微动相位）/ glow（亮度，涟漪沿它传播）。
 * 一切表现都是「改写这些变量的函数」：
 *   形态层 = shapePoints 的目标表；动力学层 = 呼吸/自转/摆动/挤压；事件层 = 点击涟漪；
 *   生命感绑定与模型动词是后续分期（都只改写同一批变量）。
 *
 * 渲染：Canvas 2D + 手写透视投影（128 点不值得引 three.js）——近大远小、近亮远暗、按深度排序。
 * 拖动走「页面报屏幕坐标绝对值 + Main 定位」：窗口追指针，无增量反馈回路。
 */

(function () {
  const canvas = document.getElementById('pet-canvas');
  const ctx2d = canvas.getContext('2d');

  // —— 身体即状态：点数可调（设置里 64–256），数组随点数重分配
  let N = PetShapes.PET_POINT_COUNT;
  let fromRest; // morph 起点
  let toRest; // 当前形态的目标位置
  let pos; // 当前位置（从原点弹出 = 出生活）
  let vel;
  let target; // 每帧算出的弹簧目标（含行为偏移）
  let phase; // 闲置微动相位（各点不同才像活的）
  let glow;
  let screenXY; // 投影后的屏幕坐标（命中检测共用）
  let screenR;
  let depth01;
  let drawOrder;
  let morphDelay;
  let gaitDx; // 猫步态的逐点偏移（pet-cat-gait.js 写、这里只加）
  let gaitDy;
  let gaitShade; // 0..1：远侧那条腿更暗更细（分不清前后四条腿就靠它）
  let shade; // 每帧生效的亮度乘子（非猫形态恒 1）

  function allocate(n) {
    N = n;
    fromRest = new Float32Array(N * 3);
    toRest = new Float32Array(N * 3);
    pos = new Float32Array(N * 3);
    vel = new Float32Array(N * 3);
    target = new Float32Array(N * 3);
    phase = new Float32Array(N);
    glow = new Float32Array(N);
    screenXY = new Float32Array(N * 2);
    screenR = new Float32Array(N);
    depth01 = new Float32Array(N);
    drawOrder = new Int32Array(N);
    morphDelay = new Float32Array(N);
    gaitDx = new Float32Array(N);
    gaitDy = new Float32Array(N);
    gaitShade = new Float32Array(N).fill(1);
    shade = new Float32Array(N).fill(1);
    for (let i = 0; i < N; i++) {
      phase[i] = Math.random() * Math.PI * 2;
      drawOrder[i] = i;
    }
  }

  allocate(PetShapes.PET_POINT_COUNT);

  const settings = {
    shape: PetShapes.DEFAULT_SHAPE,
    motion: 1,
    dotScale: 1,
    color: PetShapes.DEFAULT_COLOR
  };

  // —— 行为参数（纯动画常数，不是护栏数字）
  const MORPH_STAGGER_MS = 220; // 逐点错峰总跨度
  const MORPH_JITTER_MS = 90;
  const MORPH_TRAVEL_MS = 520; // 单点行程
  const SPRING_K = 110; // 弹簧刚度（阻尼比 ≈0.62，有一点过冲才像生物）
  const SPRING_D = 13;
  const RIPPLE_MAX = 4;
  const RIPPLE_SPEED = 0.0016; // 涟漪环半径速度（形状半径/ms）
  const RIPPLE_BAND = 0.22;

  // —— 自主变形：换形象是点点自己的动作，不是用户选的标签。
  // 球=休息形态、猫/鱼=玩耍形态；闲逛日程随机触发，拖动中顺延。
  const AUTO_SHAPES = ['sphere', 'cat', 'fish'];
  const SPHERE_STAY_MS = [22000, 48000];
  const CAT_STAY_MS = [14000, 30000];
  const FIRST_MORPH_MS = [8000, 20000]; // 启动后第一次变身别让用户等太久
  let nextMorphAt = -1; // 首帧用 rAF 时钟初始化（别混 performance.now 基准）
  let morphClockInit = false;

  function nextAutoShape() {
    const i = AUTO_SHAPES.indexOf(settings.shape);
    return AUTO_SHAPES[(i < 0 ? 0 : i + 1) % AUTO_SHAPES.length];
  }

  let morphStart = -1; // <0 = 不在 morph 中
  let yawAngle = 0; // 3D 形态慢自转
  let squishT = -1e9; // 上次被点的时间（挤压衰减）
  let lastFrame = 0;
  let lastRenderAt = 0; // 上一帧真正绘制/推进的时刻（帧率上限用）
  const FRAME_MIN_MS = 1000 / 30;
  let loopStarted = false;
  let thinkAngle = 0; // 思考内旋累积角（3D 形态，聚神时点各自缓慢公转）
  const ripples = [];

  // —— 猫的步态：走 6s → 站 12s 交替；walkAmp 缓动避免腿部瞬移
  let walkPhase = 0;
  let walkAmp = 0;
  let walking = false;
  let walkToggleAt = 0;

  let press = null; // {sx, sy, moved}
  let overBody = false;

  // —— 问号动画：不确定 / 被问到时，点云拼成「?」停一会儿再变回去（瞬时姿势，不进轮换）
  const QUESTION_HOLD_MS = 2600;
  let questionShapeBefore = null; // 摆问号前的形态
  let questionUntil = 0;

  // —— 生命感绑定（设置 → 宠物 → 绑定生命感）：体征映射到动效，心跳轮的它可调 pet_set/pet_act
  let aliveBound = false;
  let aliveState = null; // { phase, fatigue, load }
  let thinking = false; // 唤醒轮真的在推理（Main 直发起止信号，不落事件文件）
  let thinkHoldUntil = 0; // pet_act 'think' 的短促表演截止时间
  let dimT = -1e9; // pet_act 'dim'（REFUSE）的起手时刻
  let dimAmp = 0; // 暗下去的幅度（指数衰减回 1）
  let thinkActiveNow = false; // 每帧刷新，render/computeTargets 用
  const ALIVE_EVENT_FX = {
    WAKE: ['ripple', 1],
    ACT: ['pulse', 0.8],
    DEFER: ['question', 1],
    REFUSE: ['dim', 1],
    SPEAK: ['wave', 0.9],
    ACTION: ['ripple', 0.5]
  };

  function is2dShape() {
    return PetShapes.shapeKind(settings.shape) === '2d';
  }

  function randMs(range) {
    return range[0] + Math.random() * (range[1] - range[0]);
  }

  function stayMs(shape) {
    return randMs(shape === 'sphere' ? SPHERE_STAY_MS : CAT_STAY_MS);
  }

  // —— 形态切换：换目标表 + 逐点错峰，弹簧把身体「散开再聚成形」
  function snapshotBaseInto(dst, now) {
    if (morphStart < 0) {
      dst.set(toRest);
      return;
    }
    for (let i = 0; i < N; i++) {
      const m = morphMix(i, now);
      dst[i * 3] = fromRest[i * 3] + (toRest[i * 3] - fromRest[i * 3]) * m;
      dst[i * 3 + 1] = fromRest[i * 3 + 1] + (toRest[i * 3 + 1] - fromRest[i * 3 + 1]) * m;
      dst[i * 3 + 2] = fromRest[i * 3 + 2] + (toRest[i * 3 + 2] - fromRest[i * 3 + 2]) * m;
    }
  }

  function morphMix(i, now) {
    if (morphStart < 0) return 1;
    const t = (now - morphStart - morphDelay[i]) / MORPH_TRAVEL_MS;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t); // smoothstep
  }

  function applyShape(name, first) {
    const now = performance.now();
    if (first) {
      toRest.set(PetShapes.shapePointsFor(name, N));
      fromRest.set(toRest);
      morphStart = -1;
      settings.shape = name;
      reportShape();
      return;
    }
    if (name === settings.shape && morphStart < 0) return;
    snapshotBaseInto(fromRest, now);
    toRest.set(PetShapes.shapePointsFor(name, N));
    for (let i = 0; i < N; i++) {
      morphDelay[i] = (i / N) * MORPH_STAGGER_MS + Math.random() * MORPH_JITTER_MS;
    }
    morphStart = now;
    settings.shape = name;
    reportShape();
  }

  /**
   * 把**当前形态**报给 Main：`bodyLine`（心跳轮的事实块）要能说出它现在长什么样，
   * 而形态是它自己的运行状态（自主轮换 / pet_set / 问号姿势），Main 猜不出来。
   * 问号是瞬时姿势，不报（Main 该知道的是「球还是猫」）。
   */
  function reportShape() {
    if (!PetShapes.SHAPE_IDS.includes(settings.shape)) return;
    try {
      if (typeof petHost.reportState === 'function') petHost.reportState({ shape: settings.shape });
    } catch {
      // 桥不在（浏览器里直接开页面调试）就算
    }
  }

  // —— 生命感体征映射（绑定后常驻）：疲劳 → 下垂+迟缓，负载 → 活跃，相位 → 节律
  function aliveFx() {
    if (!aliveBound || !aliveState) return { droop: 0, excite: 0, load: 0, huddle: 1 };
    const fatigue = Math.max(0, Math.min(100, Number(aliveState.fatigue) || 0)) / 100;
    const phase = String(aliveState.phase || '');
    return {
      droop: fatigue,
      excite: phase === 'ALERT' ? 1 : 0,
      /** 负载 0..1：心跳轮在忙着跑东西时点更躁动（「负载让它活跃」的唯一落点） */
      load: Math.max(0, Math.min(1, Number(aliveState.load) || 0)),
      huddle: phase === 'COMPRESS' ? 0.93 : phase === 'LOW' ? 0.97 : 1
    };
  }

  // —— 每帧目标 = 形态基线 × 行为变换（自转/轻摆/呼吸/挤压）+ 闲置微动
  function computeTargets(now) {
    const motion = settings.motion;
    const fx = aliveFx();
    // 思考（聚神）：收拢到 ~62% + 慢脉动；3D 形态额外缓慢内旋
    const thinkOn = thinkActive(now);
    const gather = thinkOn ? 0.62 * (1 + 0.03 * Math.sin(now * 0.0052)) : 1;
    const spin = is2dShape() ? 0 : yawAngle + (thinkOn ? thinkAngle : 0);
    const cosY = Math.cos(spin);
    const sinY = Math.sin(spin);
    const breath = 1 + Math.sin(now * 0.00135 * (1 - 0.35 * fx.droop)) * 0.032 * motion;
    const sq = squishValue(now);
    const sx = 1 - 0.16 * sq;
    const sy = 1 + 0.2 * sq;
    const wob = Math.max(0.004, 0.016 * motion * (1 + 0.6 * fx.excite + 0.5 * fx.load) * (1 - 0.45 * fx.droop) * (thinkOn ? 0.5 : 1));
    const morphing = morphStart >= 0;

    // 猫的步态在 `pet-cat-gait.js`（纯函数，离线预览与单测都驱动它）：支撑/摆动占空比的腿摆
    // + 脚掌抬落 + 躯干起伏与背线行波 + 尾巴慢摆。这里只做一件事：把逐点偏移加到自己这批变量上。
    // 动效强度 0 = 站着不动，1 = 正常步幅，2 = 明显活泼（与呼吸/摆动同一口径）。
    const isCat = settings.shape === 'cat' && morphStart < 0 && !questionShapeBefore;
    if (isCat) {
      PetCatGait.computeGait(toRest, N, { phase: walkPhase, amp: walkAmp * motion, tMs: now }, gaitDx, gaitDy, gaitShade);
    }

    for (let i = 0; i < N; i++) {
      const m = morphing ? morphMix(i, now) : 1;
      let x = morphing ? fromRest[i * 3] + (toRest[i * 3] - fromRest[i * 3]) * m : toRest[i * 3];
      let y = morphing ? fromRest[i * 3 + 1] + (toRest[i * 3 + 1] - fromRest[i * 3 + 1]) * m : toRest[i * 3 + 1];
      let z = morphing ? fromRest[i * 3 + 2] + (toRest[i * 3 + 2] - fromRest[i * 3 + 2]) * m : toRest[i * 3 + 2];

      if (!is2dShape()) {
        const rx = x * cosY + z * sinY;
        const rz = -x * sinY + z * cosY;
        x = rx;
        z = rz;
      } else if (isCat) {
        x += gaitDx[i];
        y += gaitDy[i];
      }
      shade[i] = isCat ? gaitShade[i] : 1;
      x *= breath * sx * fx.huddle * gather;
      y *= breath * sy * fx.huddle * gather;
      z *= breath * fx.huddle * gather;
      y -= 0.25 * fx.droop; // 疲劳：身体整体往下坠一点
      x += Math.sin(now * 0.0011 + phase[i]) * wob;
      y += Math.sin(now * 0.0017 + phase[i] * 1.31) * wob;
      z += Math.sin(now * 0.0013 + phase[i] * 0.73) * wob;
      target[i * 3] = x;
      target[i * 3 + 1] = y;
      target[i * 3 + 2] = z;
    }

    if (morphing && now - morphStart > MORPH_STAGGER_MS + MORPH_JITTER_MS + MORPH_TRAVEL_MS + 60) {
      morphStart = -1;
      fromRest.set(toRest);
    }
  }

  function squishValue(now) {
    const tau = (now - squishT) / 1000;
    if (tau < 0 || tau > 1.2) return 0;
    return Math.exp(-5 * tau) * Math.cos(9 * tau);
  }

  // —— 弹簧积分：半隐式欧拉，两个子步（dt 钳到 50ms，唤醒后不跳变）
  // 注意钳制单位是毫秒：Math.min(50, dtMs)。写成 0.05 会把弹簧放慢 ~330 倍，
  // x/z 目标随自转旋转时点永远追不上（128 个点瘫成一条 Y 轴竖线）——已实测踩过。
  function integrate(dtMs) {
    const steps = 2;
    const h = Math.min(50, dtMs) / 1000 / steps;
    for (let s = 0; s < steps; s++) {
      for (let j = 0; j < N * 3; j++) {
        vel[j] += (SPRING_K * (target[j] - pos[j]) - SPRING_D * vel[j]) * h;
        pos[j] += vel[j] * h;
      }
    }
  }

  function addRipple(now, strength) {
    ripples.push({ t0: now, strength: Math.max(0.2, Math.min(1.5, Number(strength) || 1)) });
    if (ripples.length > RIPPLE_MAX) ripples.shift();
  }

  function applyRipples(now, dtMs) {
    const decay = Math.exp(-dtMs * 0.0026);
    for (let i = 0; i < N; i++) glow[i] *= decay;
    for (let r = ripples.length - 1; r >= 0; r--) {
      const ring = (now - ripples[r].t0) * RIPPLE_SPEED;
      if (ring > 1.7) {
        ripples.splice(r, 1);
        continue;
      }
      for (let i = 0; i < N; i++) {
        const x = target[i * 3];
        const y = target[i * 3 + 1];
        const z = target[i * 3 + 2];
        const d = Math.sqrt(x * x + y * y + z * z);
        const band = Math.exp(-((d - ring) * (d - ring)) / (RIPPLE_BAND * RIPPLE_BAND));
        if (band < 0.01) continue;
        const glowBoost = band * 0.9 * ripples[r].strength;
        if (glowBoost > glow[i]) glow[i] = glowBoost;
        // 径向轻推：涟漪经过时把点往外送一把
        const inv = d > 1e-4 ? 1 / d : 0;
        const push = band * 0.55 * ripples[r].strength * (dtMs / 1000);
        vel[i * 3] += x * inv * push;
        vel[i * 3 + 1] += y * inv * push;
        vel[i * 3 + 2] += z * inv * push;
      }
    }
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 深度排序比较器（模块级：每帧复用，不给 512 个点各造一个闭包） */
  function byDepth(a, b) {
    return pos[a * 3 + 2] - pos[b * 3 + 2];
  }

  /**
   * 颜色字符串按 alpha 量化分桶缓存：每点每帧拼一次 `rgba(...)` 是纯浪费
   * （512 点 × 30fps = 每秒一万五千次字符串分配），量到 1/ALPHA_STEPS 肉眼看不出来。
   */
  const ALPHA_STEPS = 24;
  let styleCache = { key: '', rgba: null, dimmed: [] };

  function stylesFor(colorId) {
    if (styleCache.key === colorId) return styleCache;
    const rgb = PetShapes.colorRgb(colorId);
    const rgba = new Array(ALPHA_STEPS + 1);
    for (let i = 0; i <= ALPHA_STEPS; i++) {
      rgba[i] = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(i / ALPHA_STEPS).toFixed(3)})`;
    }
    styleCache = { key: colorId, rgba };
    return styleCache;
  }

  function alphaStyle(styles, alpha) {
    return styles.rgba[Math.round(Math.max(0, Math.min(1, alpha)) * ALPHA_STEPS)];
  }

  // —— 投影与绘制：近大远小 / 近亮远暗 / 深度排序； halo 给高 glow 的点
  function render(now) {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    ctx2d.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.335;
    hitFloorPx = Math.max(6, R * 0.14); // 命中容差下限随身体大小走（见 hitTest）
    const cx = w / 2;
    const cy = h / 2;
    const f = 3.4; // 视距（单位 = 形态半径），z∈[-1,1] 时缩放约 0.77–1.42
    const styles = stylesFor(settings.color);
    const dim = dimValue(now); // 1 = 正常；pet_act 'dim'（REFUSE）会把整体压暗几秒

    for (let i = 0; i < N; i++) {
      const z = Math.max(-0.98, Math.min(0.98, pos[i * 3 + 2]));
      const s = f / (f - z);
      depth01[i] = (pos[i * 3 + 2] + 1) / 2;
      screenXY[i * 2] = cx + pos[i * 3] * s * R;
      screenXY[i * 2 + 1] = cy - pos[i * 3 + 1] * s * R;
      screenR[i] = Math.max(1.2, R * 0.052 * s * settings.dotScale * (0.72 + 0.28 * shade[i]) * (0.85 + 0.15 * dim));
    }
    drawOrder.sort(byDepth);

    for (let k = 0; k < N; k++) {
      const i = drawOrder[k];
      const amb = 0.5 + 0.45 * Math.sin(now * 0.0009 - i * 0.055);
      const g = Math.min(1, glow[i] + amb * 0.35 + (thinkActiveNow ? 0.18 : 0));
      const alpha = (0.3 + 0.7 * depth01[i]) * (0.45 + 0.55 * g) * shade[i] * dim;
      const x = screenXY[i * 2];
      const y = screenXY[i * 2 + 1];
      if (g > 0.62) {
        ctx2d.fillStyle = alphaStyle(styles, (g - 0.62) * 0.5 * alpha);
        ctx2d.beginPath();
        ctx2d.arc(x, y, screenR[i] * 2.1, 0, Math.PI * 2);
        ctx2d.fill();
      }
      ctx2d.fillStyle = alphaStyle(styles, alpha);
      ctx2d.beginPath();
      ctx2d.arc(x, y, screenR[i], 0, Math.PI * 2);
      ctx2d.fill();
    }
  }

  function frame(now) {
    // 帧率上限 ~30fps：rAF 仍按屏幕刷新回调，但只在够一个间隔时才推进与绘制。
    // 这种点云动效 30fps 与 60fps 肉眼无差，省一半 CPU/GPU（桌面常驻窗，这点很重要）。
    if (now - lastRenderAt < FRAME_MIN_MS - 1) {
      window.requestAnimationFrame(frame);
      return;
    }
    // 页面不可见（窗口被系统隐藏/最小化）就只转空循环、不推进状态：回来时不会突然跳一大步
    if (document.hidden) {
      lastFrame = now;
      window.requestAnimationFrame(frame);
      return;
    }
    lastRenderAt = now;
    const dtMs = lastFrame > 0 ? Math.min(50, now - lastFrame) : 16;
    lastFrame = now;
    thinkActiveNow = thinkActive(now);
    if (!is2dShape()) {
      yawAngle += 0.0004 * settings.motion * dtMs * (aliveBound && aliveState && aliveState.phase === 'ALERT' ? 1.6 : 1);
      // 思考内旋：聚神时点云缓慢公转（叠加在基础自转上）
      if (thinkActiveNow) thinkAngle += 0.0002 * dtMs;
    }
    // 问号姿势到点：等问号 morph 完成后变回原来的形态
    if (questionShapeBefore !== null && now >= questionUntil && morphStart < 0) {
      const back = questionShapeBefore;
      questionShapeBefore = null;
      applyShape(back, false);
    }
    if (!morphClockInit) {
      morphClockInit = true;
      nextMorphAt = now + randMs(FIRST_MORPH_MS);
    } else if (thinkActiveNow) {
      // 思考中闲逛顺延：形态变化会把「聚神」打断
      if (now >= nextMorphAt) nextMorphAt = now + 2000;
    } else if (now >= nextMorphAt) {
      if (press) {
        nextMorphAt = now + 4000; // 拖动中顺延，放手后再变
      } else {
        applyShape(nextAutoShape(), false);
        nextMorphAt = now + stayMs(settings.shape);
      }
    }
    // 猫的步态节拍：走 6s → 站 12s；变形态/问号/思考时腿缓动收回
    if (settings.shape === 'cat' && !questionShapeBefore && !thinkActiveNow) {
      if (now >= walkToggleAt) {
        walking = !walking;
        walkToggleAt = now + (walking ? 6000 : 12000);
      }
    } else if (walking) {
      walking = false;
      walkToggleAt = now + 3000;
    }
    walkAmp += ((walking ? 1 : 0) - walkAmp) * Math.min(1, dtMs * 0.004);
    // 步频：一个周期 = 四拍（右前→左后→左前→右后）。0.0024 rad/ms ≈ 2.6s 一周期 ≈ 1.5 步/秒
    // （猫的悠闲步态；四拍步行不能照两拍的频率算，否则看起来像小跑）
    if (walkAmp > 0.01) walkPhase += dtMs * 0.0024;
    computeTargets(now);
    integrate(dtMs);
    applyRipples(now, dtMs);
    render(now);
    window.requestAnimationFrame(frame);
  }

  // —— 交互：命中检测决定穿透与否；拖动报屏幕绝对坐标；点一下 = 涟漪 + 挤压
  /**
   * 命中检测。`pad` 是额外的容差倍数：判定「可以放下」时用大一档，
   * 这样指针在点云边缘来回蹭时不会每几像素就切一次穿透（每次切换都是一次 IPC + 系统调用）。
   * 下限跟着身体大小走（`R * 0.14`），小尺寸下不会把半个窗口都当成身体。
   */
  function hitTest(px, py, pad) {
    const extra = pad || 1;
    for (let i = 0; i < N; i++) {
      const r = Math.max(hitFloorPx * extra, screenR[i] * 2.4 * extra);
      const dx = px - screenXY[i * 2];
      const dy = py - screenXY[i * 2 + 1];
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  function setCursor(c) {
    canvas.style.cursor = c;
  }

  /**
   * 能不能开始按下：**窗口此刻已经可交互（`overBody`）就允许**。
   *
   * 为什么不再用严格命中判按下：命中区是 128 个小圆盘（猫/鱼形态是描边，中间是空的），
   * 身体还在动 —— 而「进入」用的是严格命中、「停留」用的是 1.35× 容差。按下若又回到严格命中，
   * 指针停在 1–1.35 环带里（光标已经是 grab）或点云刚好漂走时，**按下去什么都不发生**：
   * 看到的是「能抓」、做的是「拖不动」，这是「宠物抓不住/拖不动」投诉的头号来源。
   */
  function canGrab(px, py) {
    if (overBody) return true;
    return hitTest(px, py, HIT_PAD);
  }

  /**
   * 结束一次按下（mouseup 正常收尾，或 mouseup 丢了之后由 `buttons === 0` 兜底调用）。
   *
   * `focusable: false` 的无边框窗口在指针快速离开窗口 / 被夹在屏幕边缘时**会丢 mouseup**。
   * 没有这个统一出口，`press` 会永远挂着：之后所有 mousemove 都走拖动分支并 return，
   * 命中判定与「放行穿透」再也不会执行 —— 窗口就一直挡着鼠标、拖动状态也是死的。
   */
  function endPress(movedOverride) {
    if (!press) return;
    const didMove = movedOverride === undefined ? press.moved : movedOverride !== false;
    press = null;
    setCursor(overBody ? 'grab' : 'default');
    // 位置落盘在 Main；没移动过就只清拖动状态（单击不该每次写一次 settings.json）
    petHost.dragEnd(didMove);
    if (!didMove) {
      const now = performance.now();
      addRipple(now);
      squishT = now;
    }
  }

  /** 命中容差下限（px）：跟着身体半径走，在 render 里更新 —— 小尺寸时命中区不会肥得离谱 */
  let hitFloorPx = 8;
  /** 指针离开身体后的放行延迟：点云是虚线，边缘上每几像素就切一次穿透会抖（也白花 IPC） */
  const MOUSE_OFF_DELAY_MS = 90;
  /** 放行判定放宽的倍数（滞回：进来容易、出去难） */
  const HIT_PAD = 1.35;
  let mouseOffTimer = 0;
  const lastMouse = { x: 0, y: 0 };

  function cancelMouseOff() {
    if (mouseOffTimer) {
      clearTimeout(mouseOffTimer);
      mouseOffTimer = 0;
    }
  }

  function releaseMousePassSoon() {
    cancelMouseOff();
    mouseOffTimer = setTimeout(() => {
      mouseOffTimer = 0;
      if (press) return;
      if (hitTest(lastMouse.x, lastMouse.y, HIT_PAD)) return; // 还在身上（抖动），不放
      overBody = false;
      setCursor('default');
      petHost.setMousePass(true);
    }, MOUSE_OFF_DELAY_MS);
  }

  // —— 问号动画：身体拼成「?」，停一会儿再变回原来的形态（闲逛日程顺延）
  function poseQuestion() {
    if (questionShapeBefore === null) questionShapeBefore = settings.shape;
    applyShape('question', false);
    const now = performance.now();
    questionUntil = now + QUESTION_HOLD_MS;
    nextMorphAt = Math.max(nextMorphAt, questionUntil + 800);
  }

  // —— 思考（聚神）：收拢 + 微光 + 慢脉动（+3D 内旋）。真实推理期间常驻，pet_act 'think' 短促表演
  function thinkActive(nowMs) {
    return thinking || nowMs < thinkHoldUntil;
  }

  function applyEffect(effect, strength) {
    const now = performance.now();
    if (effect === 'question') {
      poseQuestion();
      return;
    }
    if (effect === 'think') {
      thinkHoldUntil = Math.max(thinkHoldUntil, now + 4000);
      return;
    }
    if (effect === 'ripple' || effect === 'wave' || effect === 'pulse') addRipple(now, strength);
    if (effect === 'squish' || effect === 'pulse') squishT = now;
    if (effect === 'dim') {
      // 「暗下去」= REFUSE 的表情。只压 glow 是看不见的（glow 平时是 0，底色来自 amb），
      // 所以记一个会自己衰减的乘子，渲染时乘进 alpha/半径。
      dimT = now;
      dimAmp = Math.max(dimAmp, 0.7 * Math.min(1, Math.max(0.2, Number(strength) || 1)));
      for (let i = 0; i < N; i++) glow[i] *= 1 - 0.8 * strength;
    }
  }

  /** 变暗乘子：dim 起手 0.x，指数回到 1（约 2–3 秒） */
  function dimValue(nowMs) {
    if (dimAmp <= 0) return 1;
    const tau = (nowMs - dimT) / 1000;
    if (tau > 8) {
      dimAmp = 0;
      return 1;
    }
    return 1 - dimAmp * Math.exp(-tau * 0.9);
  }

  window.addEventListener('mousemove', (e) => {
    if (press) {
      // mouseup 丢了（focusable:false 的窗口在指针快速离开时常见）：靠「按键已经松开」自愈。
      // 没有这条，press 会永远挂着，窗口再也不恢复穿透（挡住桌面点击），拖动也停在半路。
      if (typeof e.buttons === 'number' && e.buttons === 0) {
        endPress();
        return;
      }
      if (Math.abs(e.screenX - press.sx) + Math.abs(e.screenY - press.sy) > 5) press.moved = true;
      if (press.moved) petHost.dragMoveTo(e.screenX, e.screenY);
      return;
    }
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    if (overBody) {
      // 已经可交互：只有「真的走远了」才放行（放宽一档 + 延迟，边缘不抖）
      if (!hitTest(e.clientX, e.clientY, HIT_PAD)) releaseMousePassSoon();
      else cancelMouseOff();
      return;
    }
    // 现在是穿透态：压到身上就立刻接手（进来要快，出去要稳）
    if (hitTest(e.clientX, e.clientY)) {
      cancelMouseOff();
      overBody = true;
      setCursor('grab');
      petHost.setMousePass(false);
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (!canGrab(e.clientX, e.clientY)) return;
    // 上一次的 mouseup 丢了：先收尾再开新的，别让两段拖动叠在一起
    endPress(false);
    press = { sx: e.screenX, sy: e.screenY, moved: false };
    petHost.dragStart(e.screenX, e.screenY);
    setCursor('grabbing');
  });

  window.addEventListener('mouseup', () => {
    endPress();
  });

  window.addEventListener('mouseleave', () => {
    if (press) return;
    cancelMouseOff();
    overBody = false;
    setCursor('default');
    petHost.setMousePass(true);
  });

  // 双击身体 = 切换到下一个形态（球 ↔ 猫循环；开发调试与随手把玩用；单击仍是涟漪）
  window.addEventListener('dblclick', (e) => {
    if (!canGrab(e.clientX, e.clientY)) return;
    applyShape(nextAutoShape(), false);
  });

  window.addEventListener('resize', resizeCanvas);

  /** 生命感推送（体征快照 / 心跳事件 / pet_act）→ 身体的即时表现 */
  function applyAlive(p) {
    if (!p || typeof p !== 'object') return;
    if (p.kind === 'vitals') {
      aliveState = {
        phase: String(p.phase || ''),
        fatigue: Math.max(0, Math.min(100, Number(p.fatigue) || 0)),
        load: Math.max(0, Math.min(1, Number(p.load) || 0))
      };
      return;
    }
    if (p.kind === 'event') {
      aliveState = {
        phase: String(p.phase || ''),
        fatigue: Math.max(0, Math.min(100, Number(p.fatigue) || 0)),
        load: Math.max(0, Math.min(1, Number(p.load) || 0))
      };
      const fx = ALIVE_EVENT_FX[String(p.name || '')];
      if (!fx) return;
      applyEffect(fx[0], fx[1]);
      return;
    }
    if (p.kind === 'act') {
      // pet_act：心跳轮的它让自己做的瞬时动作（Main 已白名单归一，这里再夹一次幅度）
      const strength = Math.max(0, Math.min(1, Number(p.strength) || 0.8));
      applyEffect(String(p.effect || ''), strength * 1.2);
    }
    if (p.kind === 'shape') {
      // pet_act 的 shape 动作：现在就换过去。**瞬时动作、不落设置** ——
      // 之后照旧按闲逛日程自己变（没有「钉死形态」这一项，见 docs/PET.md §3）。
      const name = String(p.shape || '');
      if (PetShapes.SHAPE_IDS.includes(name)) applyShape(name, false);
      return;
    }
    if (p.kind === 'think') {
      // 唤醒轮推理的起止（Main 直发）：真思考期间聚神常驻
      thinking = p.on === true;
    }
  }

  function applySettings(s, first) {
    if (!s || typeof s !== 'object') return;
    // 点数变化：重分配状态向量，并按当前形态重生（点从中心弹出，正好像换了副身体）。
    // 边界只在 pet-shapes（生成器物理上限）；用户可调区间在 settings.js，这里不另写一份。
    const nc = PetShapes.clampPointCount(s.count);
    if (nc !== N) {
      allocate(nc);
      applyShape(settings.shape, true);
    }
    // 形态不是设置项：它自己按闲逛日程换（轮换在帧循环里排）。设置里就算还留着旧键
    // `shapeMode` 也**不读** —— 删掉的设置项就当没看见，不写迁移链。
    if (first) applyShape(PetShapes.DEFAULT_SHAPE, true); // 起步是休息形态（球）
    aliveBound = s.aliveBind !== false;
    settings.motion = Math.max(0, Math.min(2, Number(s.motion) || 0));
    settings.dotScale = Math.max(0.5, Math.min(2, Number(s.dotScale) || 1));
    if (PetShapes.isValidColorId(s.color)) settings.color = s.color;
  }

  function start() {
    if (loopStarted) return;
    loopStarted = true;
    resizeCanvas();
    window.requestAnimationFrame(frame);
  }

  petHost
    .ready()
    .then((res) => {
      const s = res && res.ok && res.settings ? res.settings : {};
      applySettings(s, true);
      if (res && res.alive) applyAlive({ kind: 'vitals', ...res.alive });
      start();
    })
    .catch(() => {
      // 没桥（比如直接在浏览器里开这个页面调试）：用默认设置画
      applySettings(null, true);
      start();
    });

  petHost.onApply((s) => applySettings(s, false));
  petHost.onAlive((p) => applyAlive(p));
})();

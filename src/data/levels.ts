// 关卡数据：48 个普通关（9 章）+ 3 个特殊关 + 1 个彩蛋关
//
// 设计约定：
// - 同色圆环（传送门）互相传送；地面↔天花板传送时重力自动翻转
// - 金色晶片（COLLECTIBLE）全部拾取才拿 ★2；终点不因缺片关闭，到达即通关
// - 紫色 ✦ 星门（SPECIAL_DOOR）通往特殊地图，内含彩色星核
// - 磁暴摆锤：异极相吸、同极相斥，切换极性即可摆脱
// - 磁能柱最高 64px（最大跳跃高度约 96px），相邻柱净空间距 ≥370px（边沿到边沿），保证可跳过

import { ObstacleKind, ObstacleMeta } from '../entities/Obstacle';
import { GAME_CONFIG } from './config';

export interface LevelObstacle {
  kind: ObstacleKind;
  x: number;
  y?: number;
  w?: number;
  h?: number;
  meta?: ObstacleMeta;
}

export interface LevelDef {
  id: number;
  name: string;
  chapter: number;
  parTime: number;
  maxCombo: number;
  length: number; // 关卡总长度（px）
  bg: string;
  bpm: number;
  /** 按 x 坐标排序的障碍配置 */
  obstacles: LevelObstacle[];
  /** text=键盘/默认文案，touch=触屏设备文案（可选） */
  tutorials?: { x: number; text: string; touch?: string }[];
  /** 检查点 x 列表（教学段起点）：死亡后回到最近已过检查点而非关卡开头 */
  checkpoints?: number[];
  /** 特殊/彩蛋关标记 */
  special?: boolean;
}

const GROUND = 440;
const CEIL = 100;
const BASE_S = 32;

type K = ObstacleKind;
type O = LevelObstacle;

function spike(kind: K, x: number, w = BASE_S): O {
  return { kind, x, y: GROUND - BASE_S, w, h: BASE_S };
}
function ceilSpike(kind: K, x: number, w = BASE_S): O {
  return { kind, x, y: CEIL, w, h: BASE_S };
}
/** 落地磁能柱 */
function wall(x: number, h = 56, w = 40): O {
  return { kind: 'WALL', x, y: GROUND - h, w, h };
}
/** 吊顶磁能柱（重力翻转路段用） */
function ceilWall(x: number, h = 56, w = 40): O {
  return { kind: 'WALL', x, y: CEIL, w, h };
}
function portal(kind: 'PORTAL_A' | 'PORTAL_B', x: number, y: number, id: number): O {
  return { kind, x, y, w: 48, h: 64, meta: { portalId: id } };
}
/** 地面门（贴地） */
function portalG(kind: 'PORTAL_A' | 'PORTAL_B', x: number, id: number): O {
  return portal(kind, x, GROUND - 64, id);
}
/** 天花板门 */
function portalC(kind: 'PORTAL_A' | 'PORTAL_B', x: number, id: number): O {
  return portal(kind, x, CEIL, id);
}
/** 浮空平台（单向支撑：从下方穿过、落到顶面站稳） */
function plat(x: number, y: number, w: number): O {
  return { kind: 'PLATFORM', x, y, w, h: 14 };
}
/** 平台上的门（门底对齐平台面，传送后正好站在平台上） */
function portalP(kind: 'PORTAL_A' | 'PORTAL_B', x: number, platY: number, id: number): O {
  return portal(kind, x, platY - 64, id);
}
/** 平台面晶片（站在平台奔跑即可拾取） */
function gemP(x: number, platY: number): O {
  return { kind: 'COLLECTIBLE', x, y: platY - 52, w: 24, h: 24 };
}
function reverseZone(x: number, p: 'RED' | 'BLUE'): O {
  return { kind: 'POLARITY_ZONE', x, y: CEIL, w: 64, h: GROUND - CEIL, meta: { forcedPolarity: p } };
}
function gravityFlip(x: number): O {
  return { kind: 'GRAVITY_FLIP', x, y: CEIL, w: 56, h: GROUND - CEIL };
}
function boost(x: number, w = 120, duration = 3, multiplier = 2.0): O {
  return { kind: 'SPEED_BOOST', x, y: GROUND - 20, w, h: 20, meta: { multiplier, duration } };
}
/** 地面晶片（奔跑即可拾取）。color 省略 = 任意极性可拾取 */
function gem(x: number, color?: 'RED' | 'BLUE'): O {
  const o: O = { kind: 'COLLECTIBLE', x, y: GROUND - 52, w: 24, h: 24 };
  if (color) o.meta = { color };
  return o;
}
/** 高空晶片（需要跳跃） */
function gemJ(x: number): O {
  return { kind: 'COLLECTIBLE', x, y: GROUND - 128, w: 24, h: 24 };
}
/** 天花板路线晶片（倒立奔跑拾取；须紧贴天花板：玩家碰撞箱 y∈[100,132]，AABB 收缩5px后需保持重叠） */
function gemC(x: number): O {
  return { kind: 'COLLECTIBLE', x, y: CEIL + 2, w: 24, h: 24 };
}
/** 特殊星核 */
function star(x: number, itemId: string, itemName: string, y = GROUND - 128): O {
  return { kind: 'SPECIAL_ITEM', x, y, w: 34, h: 34, meta: { itemId, itemName } };
}
/** 特殊星门（立地） */
function sdoor(x: number, targetId: number): O {
  return { kind: 'SPECIAL_DOOR', x, y: GROUND - 120, w: 46, h: 120, meta: { targetId } };
}
/** 摆锤整体抬升量：缩短绳长，避免摆球垂到贴近地面/贴脸 */
const PENDULUM_LIFT = 70;

/** 磁暴摆锤（锚点在天花板，rope 经抬升缩短后悬挂） */
function pend(x: number, rope: number, polarity: 'RED' | 'BLUE', amplitude = 0.62, swingSpeed = 2.2, phase?: number): O {
  return {
    kind: 'PENDULUM', x, y: CEIL, w: 40, h: 40,
    meta: { rope: Math.max(150, rope - PENDULUM_LIFT), polarity, amplitude, swingSpeed, ...(phase !== undefined ? { phase } : {}) },
  };
}
/** 摆锤下方陷阱刺：与摆锤同极性（同色安全穿过，异色被吸上去撞球或被刺扎） */
function pendTrap(kind: 'RED_SPIKE' | 'BLUE_SPIKE', pendX: number, w = 160): O {
  return spike(kind, pendX + 20 - w / 2, w);
}
function finish(x: number): O {
  return { kind: 'FINISH', x, y: CEIL, w: 24, h: GROUND - CEIL };
}
/** 高线 currency（不计入 ★2 全晶片，但仍产出 1 连击源） */
function currency(x: number, platY: number): O {
  return { kind: 'COLLECTIBLE', x, y: platY - 52, w: 24, h: 24, meta: { currency: 1 } };
}

/** 相位墙：同色可穿、异色立即致命（不受切换无敌保护） */
function pwall(x: number, polarity: 'RED' | 'BLUE', w = 24, h = GROUND - CEIL): O {
  return { kind: 'POLARITY_WALL', x, y: CEIL, w, h, meta: { polarity } };
}

/** 移动浮台：正弦往复；axis 默认垂直，range 60–140、period 2.4–4.0、phase 0–1 */
function mplat(
  x: number, y: number, w: number,
  axis: 'x' | 'y' = 'y', range = 90, period = 3.0, phase = 0,
): O {
  return { kind: 'MOVING_PLATFORM', x, y, w, h: 14, meta: { axis, range, period, phase } };
}

/**
 * 垂直脉冲激光（顶部光柱）：从天花板垂下，底部留出 90px 贴地安全通道。
 * 贴地奔跑可通过；站在地面等待节拍即可，跳跃则会被光束击中。
 */
function vlaser(x: number, period = 2.8, phase?: number, w = 18): O {
  const gap = 90;
  return {
    kind: 'PULSE_LASER', x, y: CEIL, w, h: GROUND - CEIL - gap,
    meta: {
      orientation: 'V', period, warn: GAME_CONFIG.PULSE_LASER_WARN, on: 0.5,
      ...(phase !== undefined ? { phase } : {}),
    },
  };
}

/** 水平脉冲激光（贴地光束）：高 42px，激活时跳过即可 */
function hlaser(x: number, w = 200, period = 2.8, phase?: number): O {
  return {
    kind: 'PULSE_LASER', x, y: GROUND - GAME_CONFIG.PULSE_LASER_HEIGHT,
    w, h: GAME_CONFIG.PULSE_LASER_HEIGHT,
    meta: {
      orientation: 'H', period, warn: GAME_CONFIG.PULSE_LASER_WARN, on: 0.5,
      ...(phase !== undefined ? { phase } : {}),
    },
  };
}

/** M01 磁芯雨：520px 雨带，3 枚红蓝交替下落（同色可收） */
function rain(x: number, polarity: 'RED' | 'BLUE' = 'RED', count = 3): O {
  return { kind: 'MAGNET_RAIN', x, y: CEIL, w: 520, h: GROUND - CEIL, meta: { polarity, count } };
}
/** M02 极性锁：全高门廊，门内拒绝换色 */
function lock(x: number, w = 64): O {
  return { kind: 'POLARITY_LOCK', x, y: CEIL, w, h: GROUND - CEIL };
}
/** M07 磁芯诱饵：悬空金芯，拾取后锁换色 1.2s（每关最多 2 枚） */
function bait(x: number): O {
  const size = 40;
  return { kind: 'CORE_BAIT', x, y: GROUND - 70 - size / 2, w: size, h: size };
}
/** M09 磁极镜：强制反转极性一次 */
function mirror(x: number, y = GROUND - 110): O {
  return { kind: 'MAGNET_MIRROR', x, y, w: 44, h: 90 };
}
/** M03 极性弹射板：同色高弹、异色低弹 */
function launch(x: number, polarity: 'RED' | 'BLUE' = 'RED'): O {
  return { kind: 'LAUNCH_PAD', x, y: GROUND - 22, w: 96, h: 22, meta: { polarity } };
}
/** M05 滑动相位墙：水平正弦往复，同色可穿 */
function swall(x: number, polarity: 'RED' | 'BLUE', range = 100, period = 3.0): O {
  return { kind: 'POLARITY_WALL', x, y: CEIL, w: 32, h: GROUND - CEIL, meta: { polarity, range, period } };
}
/** M06 极性传送带：dir=+1 加速、−1 减速 */
function conveyor(x: number, dir: 1 | -1 = 1, w = 320, speed = 90): O {
  return { kind: 'CONVEYOR', x, y: GROUND - 20, w, h: 20, meta: { dir, speed } };
}
/** M10 断桥：宽度 180/240/300，站进去即坠落 */
function pit(x: number, w = 180): O {
  return { kind: 'PIT', x, y: GROUND - 1, w, h: 30 };
}

// ================= 新手教程（id 0，不计入正式关卡） =================
//
// 顺序讲解全部机制：自动奔跑 → 跳跃 → 滑铲 → 红蓝极性/尖刺 → 黄色强制力场
// → 紫环传送（含天花板路线）→ 绿场重力翻转 → 白色加速板 → 浮空平台
// → 磁暴摆锤 → ✦ 特殊星门（仅演示）→ 晶片与终点。
// 所有晶片均放在必经路线上，间距宽松，零惩罚性陷阱。

export const TUTORIAL_LEVEL: LevelDef = {
  id: 0, name: '新手教程', chapter: 0, parTime: 45, maxCombo: 30, length: 9900, bg: '#1B1F25', bpm: 120,
  // 每个教学段的起点：死亡后回到当前段开头重练，而不是退回关卡原点。
  // 注意：检查点与下一处致命障碍必须留 ≥300px（约1秒）反应距离，否则复活即死循环
  checkpoints: [700, 1400, 2100, 4200, 5250, 6250, 7900, 9000],
  obstacles: [
    // 1) 跳跃入门（矮柱）
    wall(420, 40),
    // 2) 极性切换：先蓝后红
    spike('BLUE_SPIKE', 1050),
    spike('RED_SPIKE', 1260),
    // 3) 黄色强制力场
    reverseZone(1620, 'BLUE'),
    spike('BLUE_SPIKE', 1900), spike('BLUE_SPIKE', 2030),
    // 4) 紫环：地面 → 天花板（重力自动翻转）
    portalG('PORTAL_A', 2350, 1),
    portalC('PORTAL_A', 2800, 1),
    ceilSpike('BLUE_SPIKE', 3000), ceilSpike('BLUE_SPIKE', 3130),
    // 5) 天花板 → 地面
    portalC('PORTAL_A', 3400, 2),
    portalG('PORTAL_A', 3850, 2),
    spike('RED_SPIKE', 4050), spike('RED_SPIKE', 4170),
    // 6) 绿色重力翻转场
    gravityFlip(4450),
    ceilSpike('BLUE_SPIKE', 4750), ceilSpike('BLUE_SPIKE', 4880),
    gravityFlip(5200),
    // 7) 白色加速板 + 单柱
    boost(5550),
    wall(6050, 56),
    // 8) 浮空平台段（紫门送上，尽头紫门回地面；平台同高且首尾交叠，新手不跳也不会摔下去）
    portalG('PORTAL_A', 6500, 3),
    plat(6850, 300, 180),
    portalP('PORTAL_A', 6880, 300, 3),
    plat(7020, 300, 150),
    plat(7160, 300, 250),
    portalP('PORTAL_A', 7410, 300, 4),
    portalG('PORTAL_A', 7820, 4),
    // 9) 磁暴摆锤（温和摆动，教学同色通过）
    pend(8300, 230, 'RED', 0.5, 2.0),
    pendTrap('RED_SPIKE', 8300, 150),
    spike('BLUE_SPIKE', 8750),
    // 10) ✦ 特殊星门（演示用，可直接穿过，不会传送）
    { kind: 'SPECIAL_DOOR', x: 9050, y: GROUND - 120, w: 46, h: 120, meta: { demo: true } },
    // 11) 终点
    gem(1000), gem(1390), gem(1760),
    gemC(3060),
    gem(3950),
    gemC(4810),
    gem(5350),
    gemJ(6050),
    gemP(6960, 300), gemP(7185, 300),
    gem(7960),
    gem(8500),
    gem(9350), gem(9450),
    finish(9700),
  ],
  tutorials: [
    { x: 170, text: '欢迎！方块会自动向右奔跑，无需操作也会前进' },
    { x: 300, text: '↑ / W：跳跃，越过前方矮柱', touch: '左下 ▲：跳跃，越过前方矮柱' },
    { x: 720, text: '↓ / S：滑铲，可以缩小身体', touch: '在跳跃按钮上向下滑：滑铲缩小身体' },
    { x: 900, text: '空格：切换红蓝极性', touch: '右下 ●：切换红蓝极性' },
    { x: 990, text: '前方蓝刺 → 切成蓝色，同色尖刺可以安全穿过！' },
    { x: 1180, text: '前方红刺 → 切回红色！撞异色尖刺会爆炸重来' },
    { x: 1500, text: '黄色力场：会强制把你变成指定颜色' },
    { x: 2200, text: '紫色圆环：踩进去，瞬间传送到另一个同色圆环' },
    { x: 2900, text: '已被送到天花板！切成蓝色穿过尖刺' },
    { x: 3300, text: '再进圆环，返回地面' },
    { x: 3960, text: '回到地面，切回红色！' },
    { x: 4300, text: '绿色力场：翻转重力，到天花板上奔跑' },
    { x: 5050, text: '再穿一次绿色力场，重力恢复' },
    { x: 5430, text: '白色加速板：踩上后短时加速，跳得更远' },
    { x: 5900, text: '加速中也能跳过柱子，提前起跳即可！' },
    { x: 6380, text: '踩进紫门，送上空中浮台' },
    { x: 7050, text: '浮台可以落脚，向前跳到尽头的门' },
    { x: 7720, text: '穿过紫门回到地面，继续前进！' },
    { x: 8080, text: '磁暴摆锤：球体发光（充能）时异色会被吸过去；切成红色即可安全穿过' },
    { x: 8650, text: '蓝色尖刺 → 切回蓝色' },
    { x: 8950, text: '紫色 ✦ 星门：正式关卡中通往隐藏特殊地图（此处仅演示，可穿过）' },
    { x: 9550, text: '晶片决定 ★2；先跑到终点也可以通关。教程完成！' },
  ],
};

// ================= 第一章：初识极性 1-5 =================

const L1: LevelDef = {
  id: 1, name: '极性初体验', chapter: 1, parTime: 15, maxCombo: 4, length: 3400, bg: '#171D24', bpm: 128,
  obstacles: [
    spike('RED_SPIKE', 600), spike('RED_SPIKE', 720),
    spike('BLUE_SPIKE', 1100), spike('BLUE_SPIKE', 1220),
    spike('RED_SPIKE', 1800), spike('RED_SPIKE', 1920),
    gem(860), gem(1500), gem(2300),
    finish(2600),
  ],
  tutorials: [
    { x: 300, text: '切换极性！撞上同色尖刺才安全' },
    { x: 1500, text: '晶片决定 ★2，未集齐也可以先到终点通关！' },
  ],
};

const L2: LevelDef = {
  id: 2, name: '跳跃入门', chapter: 1, parTime: 16, maxCombo: 5, length: 3600, bg: '#171D24', bpm: 128,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    spike('RED_SPIKE', 850), spike('BLUE_SPIKE', 1000),
    spike('RED_SPIKE', 1200), spike('BLUE_SPIKE', 1350),
    wall(1650, 56), wall(2070, 56),
    spike('RED_SPIKE', 2400), spike('RED_SPIKE', 2520),
    gem(720), gem(1820), gem(1500), gem(2200), gem(2750),
    finish(3000),
  ],
  tutorials: [{ x: 1450, text: '跳起来越过磁能柱！' }],
};

const L3: LevelDef = {
  id: 3, name: '节奏训练', chapter: 1, parTime: 16, maxCombo: 6, length: 3200, bg: '#171D24', bpm: 128,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    spike('RED_SPIKE', 800), spike('BLUE_SPIKE', 950),
    spike('RED_SPIKE', 1100), spike('BLUE_SPIKE', 1250),
    wall(1650, 64),
    gem(750), gemJ(1650), gem(1350), gem(2100),
    finish(2500),
  ],
};

const L4: LevelDef = {
  id: 4, name: '传送初见', chapter: 1, parTime: 18, maxCombo: 6, length: 3800, bg: '#171D24', bpm: 128,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650), spike('RED_SPIKE', 800),
    // 紫色同色门：地面 → 天花板（重力自动翻转）
    portalG('PORTAL_A', 1100, 1),
    portalC('PORTAL_A', 1500, 1),
    ceilSpike('BLUE_SPIKE', 1750), ceilSpike('BLUE_SPIKE', 1870),
    gemC(1600), gemC(1810),
    // 天花板 → 地面
    portalC('PORTAL_A', 2150, 2),
    portalG('PORTAL_A', 2550, 2),
    spike('RED_SPIKE', 2800),
    gem(700), gem(2700),
    finish(3200),
  ],
  tutorials: [{ x: 850, text: '紫色圆环会把你送到同色圆环！' }],
};

const L5: LevelDef = {
  id: 5, name: '综合挑战', chapter: 1, parTime: 20, maxCombo: 8, length: 5000, bg: '#171D24', bpm: 128,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650), spike('RED_SPIKE', 800), spike('BLUE_SPIKE', 950),
    wall(1300, 56), wall(1760, 56),
    spike('RED_SPIKE', 2000), spike('BLUE_SPIKE', 2150),
    // 绿色同色门：地面 → 天花板路线
    portalG('PORTAL_B', 2400, 3),
    portalC('PORTAL_B', 2800, 3),
    ceilSpike('RED_SPIKE', 3000), ceilSpike('RED_SPIKE', 3120),
    gemC(3060),
    portalC('PORTAL_B', 3450, 4),
    portalG('PORTAL_B', 3850, 4),
    spike('BLUE_SPIKE', 4100),
    gem(1100), gemJ(1300), gem(2250), gem(3950), gem(4300),
    finish(4500),
  ],
};

// ================= 第二章：切换之道 6-10 =================

const L6: LevelDef = {
  id: 6, name: '强制反转', chapter: 2, parTime: 16, maxCombo: 5, length: 2800, bg: '#1E1B26', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    reverseZone(900, 'BLUE'),
    spike('BLUE_SPIKE', 1300), spike('BLUE_SPIKE', 1420),
    gem(750), gem(1100), gem(1750),
    finish(2100),
  ],
  tutorials: [{ x: 600, text: '黄色力场会强制改变你的极性！' }],
};

const L7: LevelDef = {
  id: 7, name: '反转陷阱', chapter: 2, parTime: 18, maxCombo: 6, length: 2700, bg: '#1E1B26', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    reverseZone(900, 'BLUE'),
    spike('RED_SPIKE', 1100), spike('RED_SPIKE', 1220),
    gem(750), gemJ(1050), gem(1550),
    finish(1900),
  ],
};

const L8: LevelDef = {
  id: 8, name: '浮空跃迁', chapter: 2, parTime: 22, maxCombo: 10, length: 4000, bg: '#1E1B26', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 620), spike('RED_SPIKE', 740),
    spike('BLUE_SPIKE', 860), spike('RED_SPIKE', 980), spike('BLUE_SPIKE', 1100),
    // 浮空平台段：紫门送上空中平台，跳到尽头再乘门回地面
    portalG('PORTAL_A', 1300, 1),
    plat(1600, 300, 190),
    portalP('PORTAL_A', 1630, 300, 1),
    gemP(1690, 300),
    plat(1880, 255, 150),
    gemP(1935, 255),
    plat(2120, 300, 160),
    portalP('PORTAL_A', 2160, 300, 2),
    portalG('PORTAL_A', 2530, 2),
    // 平台下方的地面惩罚路（掉下去也能走，但空中晶片就没了）
    spike('BLUE_SPIKE', 1800), spike('RED_SPIKE', 2050), spike('BLUE_SPIKE', 2300),
    reverseZone(2800, 'RED'),
    spike('RED_SPIKE', 3050), spike('BLUE_SPIKE', 3170), spike('RED_SPIKE', 3290),
    // M01 磁芯雨首次登场：雨带内红蓝磁芯交替下落，同色可收
    rain(2880),
    gem(800), gem(2950), gem(3450),
    finish(3650),
  ],
  tutorials: [
    { x: 1150, text: '紫色圆环通向空中浮台！' },
    { x: 1560, text: '浮台之间跳跃前进，尽头乘门回地面' },
    { x: 2830, text: '磁芯雨：切到与磁芯同色再穿过，才能收进磁芯' },
  ],
};

const L9: LevelDef = {
  id: 9, name: '墙壁迷宫', chapter: 2, parTime: 20, maxCombo: 8, length: 3600, bg: '#1E1B26', bpm: 140,
  obstacles: [
    wall(500, 56), wall(900, 64),
    reverseZone(1200, 'RED'),
    wall(1560, 64), wall(1980, 64),
    spike('RED_SPIKE', 2350), spike('BLUE_SPIKE', 2500),
    gemJ(500), gem(1350), gemJ(1560), gem(2150), gem(2800),
    finish(3100),
  ],
};

const L10: LevelDef = {
  id: 10, name: '切换试炼', chapter: 2, parTime: 25, maxCombo: 12, length: 5200, bg: '#1E1B26', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 620), spike('RED_SPIKE', 740),
    reverseZone(1000, 'BLUE'),
    spike('BLUE_SPIKE', 1300), spike('RED_SPIKE', 1420),
    wall(1800, 56), wall(2220, 64),
    portalG('PORTAL_A', 2500, 5),
    portalC('PORTAL_A', 2900, 5),
    ceilSpike('BLUE_SPIKE', 3100), ceilSpike('RED_SPIKE', 3250),
    gemC(3175),
    portalC('PORTAL_A', 3600, 6),
    portalG('PORTAL_A', 4000, 6),
    spike('RED_SPIKE', 4250),
    gem(850), gem(1600), gemJ(1800), gemC(3400), gem(4500),
    finish(4800),
  ],
};

// ================= 第三章：空间扭曲 11-15 =================

const L11: LevelDef = {
  id: 11, name: '传送之道', chapter: 3, parTime: 18, maxCombo: 7, length: 4600, bg: '#162022', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    // 同色地面平移门
    portalG('PORTAL_A', 1000, 7),
    portalG('PORTAL_A', 1450, 7),
    spike('RED_SPIKE', 1750), spike('BLUE_SPIKE', 1900),
    portalG('PORTAL_B', 2150, 8),
    portalC('PORTAL_B', 2550, 8),
    ceilSpike('RED_SPIKE', 2750),
    gemC(2820),
    portalC('PORTAL_B', 3100, 9),
    portalG('PORTAL_B', 3500, 9),
    gem(800), gemJ(1600), gem(2000), gem(3700),
    finish(4000),
  ],
};

const L12: LevelDef = {
  id: 12, name: '浮空回廊', chapter: 3, parTime: 24, maxCombo: 10, length: 5300, bg: '#162022', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    portalG('PORTAL_B', 1000, 10),
    portalC('PORTAL_B', 1550, 10),
    ceilSpike('BLUE_SPIKE', 1750), ceilSpike('RED_SPIKE', 1900),
    gemC(1825),
    portalC('PORTAL_B', 2200, 11),
    portalG('PORTAL_B', 2550, 11),
    // 浮空平台段：乘紫门上空中浮台
    portalG('PORTAL_A', 2750, 12),
    plat(3050, 300, 190),
    portalP('PORTAL_A', 3070, 300, 12),
    gemP(3140, 300),
    plat(3330, 255, 150),
    gemP(3385, 255),
    plat(3570, 300, 170),
    portalP('PORTAL_A', 3620, 300, 13),
    portalG('PORTAL_A', 4020, 13),
    // 平台下方地面惩罚路
    spike('RED_SPIKE', 3300), spike('BLUE_SPIKE', 3650),
    wall(4300, 64),
    spike('BLUE_SPIKE', 4550), spike('BLUE_SPIKE', 4670),
    gem(800), gem(2650), gem(4180), gem(4780),
    finish(4950),
  ],
  tutorials: [{ x: 2620, text: '乘紫门上空中浮台，别掉下去！' }],
};

const L13: LevelDef = {
  id: 13, name: '空间连环', chapter: 3, parTime: 22, maxCombo: 10, length: 6200, bg: '#162022', bpm: 140,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    portalG('PORTAL_A', 900, 12),
    portalC('PORTAL_A', 1300, 12),
    ceilSpike('BLUE_SPIKE', 1500),
    gemC(1650),
    portalC('PORTAL_A', 1900, 13),
    portalG('PORTAL_A', 2300, 13),
    // ✦ 特殊星门（可选挑战 → 特殊关 101）
    sdoor(2700, 101),
    spike('RED_SPIKE', 3200), spike('BLUE_SPIKE', 3350),
    portalG('PORTAL_B', 3700, 14),
    portalC('PORTAL_B', 4100, 14),
    ceilSpike('RED_SPIKE', 4300),
    gemC(4450),
    portalC('PORTAL_B', 4750, 15),
    portalG('PORTAL_B', 5150, 15),
    gem(700), gem(2500), gem(3500), gem(5350),
    finish(5700),
  ],
  tutorials: [{ x: 2550, text: '✦ 星门通往特殊地图（可选挑战，内含星核）' }],
};

const L14: LevelDef = {
  id: 14, name: '双门迷阵', chapter: 3, parTime: 24, maxCombo: 12, length: 5900, bg: '#162022', bpm: 140,
  obstacles: [
    portalG('PORTAL_A', 500, 16),
    portalC('PORTAL_A', 900, 16),
    ceilSpike('BLUE_SPIKE', 1100), ceilSpike('RED_SPIKE', 1250),
    gemC(1175),
    portalC('PORTAL_A', 1600, 17),
    portalG('PORTAL_A', 2000, 17),
    spike('RED_SPIKE', 2300), spike('BLUE_SPIKE', 2450),
    portalG('PORTAL_B', 2800, 18),
    portalC('PORTAL_B', 3200, 18),
    ceilSpike('RED_SPIKE', 3400), ceilSpike('BLUE_SPIKE', 3550),
    gemC(3475),
    portalC('PORTAL_B', 3950, 19),
    portalG('PORTAL_B', 4350, 19),
    wall(4650, 64),
    spike('RED_SPIKE', 4950),
    gem(420), gem(2150), gem(2600), gem(4500), gemJ(4650),
    finish(5300),
  ],
};

const L15: LevelDef = {
  id: 15, name: '磁暴摆锤', chapter: 3, parTime: 25, maxCombo: 14, length: 5000, bg: '#162022', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    pend(950, 275, 'RED', 0.62),
    pendTrap('RED_SPIKE', 950),
    portalG('PORTAL_A', 1350, 20),
    portalG('PORTAL_A', 1750, 20),
    reverseZone(2050, 'BLUE'),
    wall(2450, 56), wall(2870, 56),
    pend(3200, 265, 'BLUE', 0.7),
    pendTrap('BLUE_SPIKE', 3200),
    spike('RED_SPIKE', 3600), spike('BLUE_SPIKE', 3750), spike('RED_SPIKE', 3900),
    gem(700), gemJ(1880), gem(2250), gemJ(2450), gem(3450), gem(4150),
    finish(4500),
  ],
  tutorials: [{ x: 720, text: '摆锤：异极相吸、同极相斥，切换颜色摆脱！' }],
};

// ================= 第四章：抉择时刻 16-20 =================

const L16: LevelDef = {
  id: 16, name: '初次抉择', chapter: 4, parTime: 18, maxCombo: 7, length: 3100, bg: '#211D1A', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    // 分裂通道：上方红刺路（跳起），下方蓝刺路（滑行/直跑）
    ceilSpike('RED_SPIKE', 1100), spike('BLUE_SPIKE', 1100),
    ceilSpike('RED_SPIKE', 1250), spike('BLUE_SPIKE', 1250),
    // M02 极性锁首次登场：门廊内禁止换色
    lock(1450),
    wall(1800, 64),
    gem(1175), gem(1500), gemJ(1800), gem(2250),
    finish(2500),
  ],
  tutorials: [
    { x: 800, text: '上路红刺、下路蓝刺：跳跃选择路线！' },
    { x: 1380, text: '极性锁门廊：穿过去之前不能换色，提前切好颜色' },
  ],
};

const L17: LevelDef = {
  id: 17, name: '抉择之中', chapter: 4, parTime: 20, maxCombo: 9, length: 3400, bg: '#211D1A', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    ceilSpike('RED_SPIKE', 1000), spike('BLUE_SPIKE', 1000),
    ceilSpike('RED_SPIKE', 1150), spike('BLUE_SPIKE', 1150),
    spike('RED_SPIKE', 1600), spike('BLUE_SPIKE', 1750),
    wall(2100, 64),
    gem(1075), gem(1400), gemJ(2100), gem(1950), gem(2550),
    finish(2800),
  ],
};

const L18: LevelDef = {
  id: 18, name: '摆锤抉择', chapter: 4, parTime: 22, maxCombo: 11, length: 3200, bg: '#211D1A', bpm: 155,
  obstacles: [
    ceilSpike('RED_SPIKE', 500), spike('BLUE_SPIKE', 500),
    ceilSpike('RED_SPIKE', 650), spike('BLUE_SPIKE', 650),
    pend(1050, 270, 'RED', 0.66),
    pendTrap('RED_SPIKE', 1050),
    wall(1550, 56),
    ceilSpike('RED_SPIKE', 1950), spike('BLUE_SPIKE', 1950),
    ceilSpike('RED_SPIKE', 2100), spike('BLUE_SPIKE', 2100),
    gem(575), gem(1250), gemJ(1550), gem(1750), gem(2350),
    finish(2600),
  ],
};

const L19: LevelDef = {
  id: 19, name: '极速抉择', chapter: 4, parTime: 24, maxCombo: 13, length: 3400, bg: '#211D1A', bpm: 155,
  obstacles: [
    ceilSpike('RED_SPIKE', 500), spike('BLUE_SPIKE', 500),
    ceilSpike('RED_SPIKE', 600), spike('BLUE_SPIKE', 600),
    ceilSpike('RED_SPIKE', 900), spike('BLUE_SPIKE', 900),
    ceilSpike('RED_SPIKE', 1000), spike('BLUE_SPIKE', 1000),
    wall(1350, 56), wall(1770, 56),
    pend(2100, 255, 'BLUE', 0.72, 2.5),
    pendTrap('BLUE_SPIKE', 2100),
    gem(700), gem(950), gemJ(1350), gemJ(1770), gem(2350),
    finish(2700),
  ],
};

const L20: LevelDef = {
  id: 20, name: '三重奏', chapter: 4, parTime: 26, maxCombo: 15, length: 5300, bg: '#211D1A', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    portalG('PORTAL_A', 900, 21),
    portalC('PORTAL_A', 1300, 21),
    ceilSpike('RED_SPIKE', 1500),
    // 天花板/地面同时分叉
    ceilSpike('RED_SPIKE', 1750), spike('BLUE_SPIKE', 1750),
    gemC(1620),
    portalC('PORTAL_A', 2100, 22),
    portalG('PORTAL_A', 2500, 22),
    reverseZone(2800, 'BLUE'),
    wall(3200, 64),
    // M07 磁芯诱饵首次登场：跳起拾取，磁芯 +1、连击 +2，换色锁定 1.2s
    bait(3400),
    sdoor(3700, 102),
    spike('RED_SPIKE', 4150), spike('BLUE_SPIKE', 4300),
    gem(700), gem(2650), gemJ(3200), gem(3950), gem(4550),
    finish(4800),
  ],
  tutorials: [{ x: 3300, text: '磁芯诱饵：跳起拾取磁芯，换色会被锁住 1.2 秒' }],
};

// ================= 第五章：颠倒世界 21-25 =================

const L21: LevelDef = {
  id: 21, name: '重力初感', chapter: 5, parTime: 18, maxCombo: 7, length: 3500, bg: '#1A1C28', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    gravityFlip(1000),
    ceilSpike('BLUE_SPIKE', 1600), ceilSpike('RED_SPIKE', 1750),
    gravityFlip(2150),
    gem(800), gemC(1675), gemC(1950), gem(2550),
    finish(2900),
  ],
  tutorials: [{ x: 750, text: '绿色力场翻转重力，在天花板上奔跑！' }],
};

const L22: LevelDef = {
  id: 22, name: '倒立跳跃', chapter: 5, parTime: 20, maxCombo: 9, length: 4200, bg: '#1A1C28', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    gravityFlip(900),
    ceilWall(1400, 64),
    ceilSpike('BLUE_SPIKE', 2000), ceilSpike('RED_SPIKE', 2150),
    gemC(1700),
    gravityFlip(2550),
    gem(700), gemC(2350), gemJ(2900),
    wall(2900, 56),
    // M10 断桥首次登场：坑宽 180，普通跳跃 238px 可过
    pit(3250, 180),
    finish(3600),
  ],
  tutorials: [{ x: 3140, text: '断桥：坑宽 180，在边缘提前起跳即可越过' }],
};

const L23: LevelDef = {
  id: 23, name: '颠倒门', chapter: 5, parTime: 22, maxCombo: 9, length: 4100, bg: '#1A1C28', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    gravityFlip(900),
    portalC('PORTAL_A', 1400, 23),
    portalG('PORTAL_A', 2200, 23),
    spike('RED_SPIKE', 2600), spike('BLUE_SPIKE', 2750),
    gem(700), gemC(1250), gem(2450), gemJ(2950),
    finish(3400),
  ],
};

const L24: LevelDef = {
  id: 24, name: '天花板路径', chapter: 5, parTime: 24, maxCombo: 13, length: 4200, bg: '#1A1C28', bpm: 155,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    gravityFlip(900),
    ceilSpike('RED_SPIKE', 1400), ceilSpike('BLUE_SPIKE', 1500),
    ceilSpike('RED_SPIKE', 1620), ceilSpike('BLUE_SPIKE', 1720),
    ceilWall(1950, 56),
    gemC(1820),
    gravityFlip(2400),
    wall(2850, 64),
    // M03 极性弹射板首次登场：同色 vy −780（约 217px），异色 −420（约 63px）
    launch(2580, 'RED'),
    gem(700), gemC(2200), gemJ(2850), gem(3200),
    finish(3600),
  ],
  tutorials: [{ x: 2480, text: '极性弹射板：同色弹得更高，可越过前方磁能柱' }],
};

const L25: LevelDef = {
  id: 25, name: '逆重狂奔', chapter: 5, parTime: 26, maxCombo: 9, length: 4400, bg: '#1A1C28', bpm: 174,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    gravityFlip(900),
    ceilSpike('BLUE_SPIKE', 1400), ceilSpike('RED_SPIKE', 1550),
    ceilSpike('RED_SPIKE', 2050), ceilSpike('BLUE_SPIKE', 2200),
    gemC(1800),
    gravityFlip(2600),
    boost(2950),
    gem(700), gemC(2400), gem(3300),
    finish(3800),
  ],
};

// ================= 第六章：极速狂飙 26-30 =================

const L26: LevelDef = {
  id: 26, name: '速度觉醒', chapter: 6, parTime: 18, maxCombo: 9, length: 4000, bg: '#151F22', bpm: 174,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 620), spike('RED_SPIKE', 740),
    // 短程冲刺：加速在柱阵前结束，保证柱子按常速节奏可跳
    boost(1100, 120, 0.6),
    wall(1650, 56), wall(2120, 56),
    spike('BLUE_SPIKE', 2450), spike('RED_SPIKE', 2570),
    gem(900), gemJ(1650), gem(2300), gem(2950),
    finish(3400),
  ],
  tutorials: [{ x: 800, text: '白色加速带：速度飙升！' }],
};

const L27: LevelDef = {
  id: 27, name: '极速走廊', chapter: 6, parTime: 20, maxCombo: 12, length: 4300, bg: '#151F22', bpm: 174,
  obstacles: [
    // 短程冲刺，在三连柱前结束
    boost(400, 120, 0.7),
    spike('RED_SPIKE', 700), spike('BLUE_SPIKE', 820), spike('RED_SPIKE', 940),
    wall(1300, 56), wall(1800, 56), wall(2300, 56),
    // M06 极性传送带首次登场：−90px/s 减速带，长 320
    conveyor(2380, -1),
    sdoor(2700, 103),
    spike('BLUE_SPIKE', 3050), spike('RED_SPIKE', 3170),
    gem(600), gemJ(1300), gemJ(1800), gem(2600), gem(3350),
    finish(3700),
  ],
  tutorials: [{ x: 2300, text: '极性传送带：减速带会拖慢脚步，提前起跳' }],
};

const L28: LevelDef = {
  id: 28, name: '全面混乱', chapter: 6, parTime: 24, maxCombo: 11, length: 4800, bg: '#151F22', bpm: 174,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 550),
    reverseZone(850, 'BLUE'),
    gravityFlip(1200),
    portalC('PORTAL_A', 1700, 24),
    portalG('PORTAL_A', 2500, 24),
    boost(2900),
    spike('RED_SPIKE', 3400), spike('BLUE_SPIKE', 3520),
    gem(700), gemC(1500), gem(2700), gemJ(3200), gem(3900),
    finish(4300),
  ],
};

const L29: LevelDef = {
  id: 29, name: '终极试炼', chapter: 6, parTime: 26, maxCombo: 15, length: 5500, bg: '#151F22', bpm: 174,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 520),
    gravityFlip(800),
    ceilSpike('RED_SPIKE', 1300), ceilSpike('BLUE_SPIKE', 1400),
    portalC('PORTAL_B', 1800, 25),
    portalG('PORTAL_B', 2600, 25),
    reverseZone(2900, 'RED'),
    boost(3300),
    pend(3750, 270, 'RED', 0.66, 2.4),
    pendTrap('RED_SPIKE', 3750),
    spike('BLUE_SPIKE', 4200), spike('RED_SPIKE', 4320),
    gemC(1500), gem(2750), gem(3100), gemJ(3750), gem(4550),
    finish(5000),
  ],
};

const L30: LevelDef = {
  id: 30, name: '磁极风暴', chapter: 6, parTime: 28, maxCombo: 22, length: 7600, bg: '#151F22', bpm: 174,
  obstacles: [
    spike('RED_SPIKE', 400), spike('BLUE_SPIKE', 500), spike('RED_SPIKE', 600),
    gravityFlip(900),
    ceilSpike('RED_SPIKE', 1400), ceilSpike('BLUE_SPIKE', 1520),
    reverseZone(1800, 'BLUE'),
    portalC('PORTAL_A', 2200, 26),
    portalG('PORTAL_A', 3000, 26),
    // 短程冲刺，在双柱前结束
    boost(3500, 120, 0.6),
    pend(3950, 280, 'BLUE', 0.7, 2.4),
    pendTrap('BLUE_SPIKE', 3950),
    wall(4350, 64), wall(4850, 56),
    pend(5050, 260, 'RED', 0.6, 2.6, 1.3),
    pendTrap('RED_SPIKE', 5050),
    gravityFlip(5400),
    ceilSpike('RED_SPIKE', 5850), ceilSpike('BLUE_SPIKE', 5970), ceilSpike('RED_SPIKE', 6090),
    gravityFlip(6400),
    gem(700), gemC(1600), gem(3300), gemJ(4350), gemJ(4520), gem(5250), gemC(6040), gem(6700),
    finish(7000),
  ],
};

// ================= 第七章：新机制 31-36 =================
//
// 设计约定：每关只引入一个新变量，下一关再叠加；同一关最多同时出现两种新机制。
// - 31 相位墙 → 32 移动浮台 → 33 脉冲激光 → 34 相位墙+摆锤 → 35 浮台+传送门 → 36 三机制综合
// - 长度 ≥6000 的关卡在 1/3、2/3 处设检查点，检查点前后 300px 内无障碍

const L31: LevelDef = {
  id: 31, name: '相位初现', chapter: 7, parTime: 17, maxCombo: 8, length: 4800, bg: '#221D19', bpm: 160,
  obstacles: [
    // 每面墙前留 ≥400px 观察区；同色可穿，异色立死
    pwall(700, 'RED'), pwall(1150, 'BLUE'), pwall(1600, 'RED'),
    // M05 滑动相位墙首次登场：±100px、周期 3.0s
    swall(1830, 'RED'),
    pwall(2050, 'BLUE'), pwall(2500, 'RED'), pwall(2950, 'BLUE'),
    // 节奏重排：后半程补齐 4 面墙，密度 ≈2.3 危险点/1000px
    pwall(3400, 'RED'), pwall(3850, 'BLUE'), pwall(4150, 'RED'),
    gem(500), gem(950), gem(1400), gem(1980), gem(2300), gem(2750),
    gem(3250), gem(3750), gem(4100),
    finish(4350),
  ],
  tutorials: [
    { x: 520, text: '相位墙：同色可直接穿过，异色立即致命', touch: '相位墙：切到同色再冲过去' },
    { x: 1760, text: '这面墙会左右滑动：看准位置再穿' },
  ],
};

const L32: LevelDef = {
  id: 32, name: '浮台回声', chapter: 7, parTime: 19, maxCombo: 10, length: 5200, bg: '#221D19', bpm: 160,
  obstacles: [
    // 垂直浮台错开相位，观察周期再落脚
    mplat(650, 320, 180, 'y', 80, 2.8, 0),
    mplat(1050, 300, 180, 'y', 100, 3.2, 0.33),
    mplat(1450, 330, 160, 'y', 70, 2.6, 0.66),
    mplat(2000, 250, 180, 'y', 90, 3.0, 0.5),
    gemJ(560), gemP(730, 320), gemJ(1250), gem(1750), gemJ(2100), gem(2500), gem(2900), gem(3300),
    spike('RED_SPIKE', 1350), spike('BLUE_SPIKE', 2250), spike('RED_SPIKE', 3100),
    // 节奏重排：补 2 面相位墙 + 3 根尖刺，危险密度 ≈1.9
    pwall(1200, 'RED'), pwall(2600, 'BLUE'),
    spike('RED_SPIKE', 3550), spike('BLUE_SPIKE', 3900), spike('RED_SPIKE', 4250),
    gem(3650), gem(3950), gem(4200),
    finish(4650),
  ],
  tutorials: [
    { x: 480, text: '移动浮台会上下往复：看准最高点再落脚', touch: '移动浮台上下浮动，等它靠近再跳' },
  ],
};

const L33: LevelDef = {
  id: 33, name: '红色节拍', chapter: 7, parTime: 19, maxCombo: 6, length: 5400, bg: '#221D19', bpm: 165,
  obstacles: [
    // 顶部光柱：贴地通过，跳跃会被击中
    vlaser(650, 2.8, 0), vlaser(1150, 3.0, 0.25), vlaser(1650, 2.6, 0.5),
    // 贴地光束：激活时跳过
    hlaser(2150, 200, 2.8, 0.2), hlaser(2650, 220, 3.0, 0.5), hlaser(3150, 200, 2.6, 0.8),
    // 节奏重排：后半程补 4 道光束（错相位，保证总有可读节拍）
    vlaser(3650, 2.8, 0.75), hlaser(3950, 200, 3.0, 0.4),
    vlaser(4250, 2.6, 0.9), hlaser(4550, 200, 2.8, 0.6),
    gem(520), gem(950), gem(1400), gem(1900), gem(2400), gem(2900), gem(3400),
    gem(3600), gem(3900), gem(4250), gem(4550),
    finish(4900),
  ],
  tutorials: [
    { x: 500, text: '红色光柱有节拍：贴地等它熄灭，别跳', touch: '光柱预警后亮起：贴地通过，不要跳' },
  ],
};

const L34: LevelDef = {
  id: 34, name: '交错的磁极', chapter: 7, parTime: 22, maxCombo: 14, length: 5600, bg: '#221D19', bpm: 165,
  obstacles: [
    pwall(700, 'RED'),
    pend(1250, 270, 'RED', 0.62, 2.3),
    pendTrap('RED_SPIKE', 1250),
    pwall(1800, 'BLUE'),
    pend(2350, 280, 'BLUE', 0.7, 2.5, 1.2),
    pendTrap('BLUE_SPIKE', 2350),
    // M09 磁极镜首次登场：强制反转极性，随后 260px 内必须重新切色
    mirror(2650),
    pwall(2900, 'RED'),
    pend(3450, 275, 'RED', 0.66, 2.4, 2.0),
    pendTrap('RED_SPIKE', 3450),
    pwall(3950, 'BLUE'),
    // 节奏重排：后半程补 1 墙 + 1 刺
    pwall(4400, 'BLUE'), spike('RED_SPIKE', 4700),
    gem(500), gem(1000), gem(1500), gem(2050), gem(2600), gem(3150), gem(3700), gem(4200),
    gem(2650), gem(4620),
    finish(4900),
  ],
  tutorials: [
    { x: 520, text: '相位墙 + 磁暴摆锤：先看颜色，再借磁力通过', touch: '先切同色穿墙，再用极性躲开摆锤' },
    { x: 2580, text: '磁极镜：穿过镜面会被强制反转极性，立刻准备下一次切色' },
  ],
};

const L35: LevelDef = {
  id: 35, name: '浮空追踪', chapter: 7, parTime: 20, maxCombo: 16, length: 5600, bg: '#221D19', bpm: 170,
  obstacles: [
    // 传送出口必须有静态安全落点：平台作为落脚点
    portalG('PORTAL_A', 600, 40),
    plat(850, 320, 200),
    portalP('PORTAL_A', 880, 320, 40),
    mplat(1200, 320, 160, 'y', 70, 2.8, 0.5),
    spike('RED_SPIKE', 1550),
    spike('BLUE_SPIKE', 1850),
    mplat(2250, 280, 180, 'x', 100, 3.4, 0.2),
    // 节奏重排：补 2 根地面刺 + 1 面相位墙
    pwall(2600, 'BLUE'), spike('RED_SPIKE', 2750),
    plat(3000, 300, 180),
    portalP('PORTAL_B', 3030, 300, 41),
    portalG('PORTAL_B', 3450, 41),
    spike('RED_SPIKE', 3800),
    spike('BLUE_SPIKE', 4100),
    spike('BLUE_SPIKE', 4500),
    gem(500), gemP(880, 320), gem(1400), gemJ(1700), gem(2500), gem(3200), gem(3700), gem(4400),
    finish(4850),
  ],
  tutorials: [
    { x: 480, text: '浮台与传送门组合：出传送后先踩稳再跳', touch: '先落到浮台，再决定下一次跳跃' },
  ],
};

const L36: LevelDef = {
  id: 36, name: '边境风暴', chapter: 7, parTime: 23, maxCombo: 16, length: 6400, bg: '#221D19', bpm: 174,
  // 1/3、2/3 检查点；前后 300px 内无障碍
  checkpoints: [2150, 4300],
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 620),
    pwall(1000, 'RED'),
    mplat(1500, 300, 180, 'y', 80, 3.0, 0),
    pwall(1900, 'BLUE'),
    // 检查点 2150 附近留空
    hlaser(2550, 200, 2.8, 0.3),
    vlaser(2950, 2.8, 0.6),
    pwall(3350, 'RED'),
    mplat(3800, 280, 180, 'x', 100, 3.2, 0.4),
    // 检查点 4300 附近留空
    pend(4700, 270, 'RED', 0.66, 2.4),
    pendTrap('RED_SPIKE', 4700),
    hlaser(5150, 200, 3.0, 0.2),
    pwall(5550, 'BLUE'),
    spike('RED_SPIKE', 5900),
    gem(700), gem(1200), gem(1800), gem(2450), gem(3050), gem(3600), gem(4200), gem(5000),
    finish(6100),
  ],
  tutorials: [
    { x: 480, text: '边境风暴：相位墙、浮台、激光三机制综合', touch: '三机制综合关：先看节拍，再行动' },
    { x: 2100, text: '检查点：死亡后从最近的检查点继续', touch: '检查点已保存，死亡不用从头跑' },
  ],
};

// ================= 第八章：代价之门 37-42 =================
//
// 设计约定（见 docs/新关卡设计与视觉特效升级.html）：
// - 每关只增加一种“代价”：37 锁 → 38 饵 → 39 镜 → 40 路线 → 41 锁镜合算 → 42 章末
// - 锁期内不叠加“必须换色”的相位墙；颜色决策与跳跃决策至少隔 240px
// - 诱饵只放在有替代路线处，每关 ≤2；不得进入 ★2 全晶片必经路径

const L37: LevelDef = {
  id: 37, name: '锁门之外', chapter: 8, parTime: 18, maxCombo: 12, length: 4600, bg: '#211A1E', bpm: 165,
  obstacles: [
    // 呼吸段：只复习尖刺，不做颜色约束
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 650),
    gem(260, 'RED'), gem(700),
    // 第一道锁：门内不能手动换色
    lock(900),
    gem(1150, 'BLUE'),
    // 第二道锁：两道锁间隔 600px，中间只留 1 次换色窗口
    lock(1500),
    spike('BLUE_SPIKE', 1800), spike('RED_SPIKE', 1950),
    // 锁后第一面相位墙
    wall(2200),
    gem(1700), gem(2400),
    pwall(2600, 'RED'),
    spike('RED_SPIKE', 3000), spike('BLUE_SPIKE', 3150),
    gem(3300, 'RED'),
    // 终点锁 + B 墙
    lock(3600),
    gem(3800),
    pwall(3900, 'BLUE'),
    spike('RED_SPIKE', 4100),
    gem(4250),
    finish(4400),
  ],
  tutorials: [
    { x: 150, text: '彩色晶片：只有同色极性才能拾取；颜色不符会被弹开并提示（白色晶片任意极性）' },
    { x: 760, text: '极性锁：门内不能手动换色，只能带着进门前定好的颜色通过' },
    { x: 1420, text: '连续两道锁：进第一道前就要想好第二道用什么颜色' },
  ],
};

const L38: LevelDef = {
  id: 38, name: '诱饵门廊', chapter: 8, parTime: 20, maxCombo: 14, length: 5000, bg: '#211A1E', bpm: 165,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    // 门廊 1：锁内 200px 的诱饵
    lock(1200),
    bait(1400),
    gem(1150, 'BLUE'),
    pwall(1800, 'RED'),
    spike('RED_SPIKE', 2100), spike('BLUE_SPIKE', 2250),
    gem(1750), gem(2300),
    // 休整段：无锁无饵，只给节奏
    wall(2600),
    gem(3100, 'RED'),
    // 门廊 2：第二次取舍
    lock(3300),
    bait(3600),
    gem(3700),
    pwall(3900, 'BLUE'),
    spike('RED_SPIKE', 4200), spike('BLUE_SPIKE', 4350),
    gem(4300),
    finish(4650),
  ],
  tutorials: [
    { x: 800, text: '磁芯诱饵：吃下 +2 连击，但 1.2 秒内不能换色' },
    { x: 1320, text: '诱饵不一定要吃：前面就是相位墙，先确认颜色再决定' },
  ],
};

const L39: LevelDef = {
  id: 39, name: '镜前换色', chapter: 8, parTime: 20, maxCombo: 14, length: 5200, bg: '#211A1E', bpm: 165,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    // 第一面镜：翻色后正好通过 R 墙
    mirror(1200),
    gem(1150),
    pwall(1500, 'RED'),
    gem(1650, 'BLUE'),
    spike('BLUE_SPIKE', 1950), spike('RED_SPIKE', 2100),
    pwall(2500, 'BLUE'),
    gem(2300),
    wall(2800),
    gem(2950),
    // 第二面镜：镜前刺组，镜后 R 墙
    spike('RED_SPIKE', 3000), spike('BLUE_SPIKE', 3150),
    gem(3350),
    mirror(3400),
    pwall(3900, 'RED'),
    gem(4050, 'RED'),
    spike('RED_SPIKE', 4350),
    finish(4850),
  ],
  tutorials: [
    { x: 1080, text: '磁极镜：穿过镜面会被强制反转极性，提前把颜色算好' },
    { x: 3300, text: '镜后 500px 才出现墙：镜给的是“提前量”，不是安全区' },
  ],
};

const L40: LevelDef = {
  id: 40, name: '双线代价', chapter: 8, parTime: 22, maxCombo: 11, length: 5600, bg: '#211A1E', bpm: 170,
  obstacles: [
    gem(300, 'RED'), gem(700), gem(1100, 'BLUE'),
    // 高线：3 枚 currency，不计入 ★2
    plat(1450, 344, 180),
    currency(1550, 344),
    plat(1850, 250, 200),
    currency(1950, 250),
    plat(2250, 250, 220),
    currency(2350, 250),
    spike('RED_SPIKE', 1600), spike('BLUE_SPIKE', 1750),
    spike('RED_SPIKE', 2100), spike('BLUE_SPIKE', 2250),
    mplat(2600, 300, 160),
    wall(2800),
    // 低线：★2 只认这 3 枚普通晶片
    gem(2500, 'RED'),
    spike('RED_SPIKE', 3150), spike('BLUE_SPIKE', 3300),
    gem(3400),
    wall(3900),
    gem(4300),
    finish(5200),
  ],
  tutorials: [
    { x: 1350, text: '高线只给 currency（不计 ★2），低线才是全晶片路线' },
    { x: 2500, text: '贪高线会错过低线晶片：★2 直接失败' },
  ],
};

const L41: LevelDef = {
  id: 41, name: '锁镜夹层', chapter: 8, parTime: 22, maxCombo: 16, length: 5800, bg: '#211A1E', bpm: 170,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    // 夹层 1：锁内不能手动换色，出锁靠镜翻色
    lock(1100),
    gem(1150),
    mirror(1700),
    gem(1600),
    spike('BLUE_SPIKE', 1900),
    bait(1900),
    spike('RED_SPIKE', 2050),
    gem(2100),
    pwall(2300, 'BLUE'),
    gem(2700, 'BLUE'),
    // 夹层之间：纯跳跃，恢复手动换色的节奏
    spike('RED_SPIKE', 2900), spike('BLUE_SPIKE', 3050),
    gem(3300),
    wall(3500),
    // 夹层 2：出锁即墙，没有镜可借
    lock(3900),
    gem(4100),
    pwall(4300, 'RED'),
    spike('RED_SPIKE', 4500), spike('BLUE_SPIKE', 4650),
    gem(4800, 'RED'),
    finish(5450),
  ],
  tutorials: [
    { x: 1000, text: '锁住换色后，镜仍然会翻色：学会借镜换色' },
    { x: 3800, text: '这一段没有镜：必须在出锁瞬间手动换色' },
  ],
};

const L42: LevelDef = {
  id: 42, name: '代价风暴', chapter: 8, parTime: 26, maxCombo: 21, length: 7000, bg: '#211A1E', bpm: 174,
  checkpoints: [2350, 4700],
  obstacles: [
    // 锁段
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    lock(1000),
    bait(1300),
    gem(1200),
    // 镜段
    mirror(2000),
    gem(1800),
    spike('BLUE_SPIKE', 2100), spike('RED_SPIKE', 2250),
    pwall(2400, 'BLUE'),
    gem(2500, 'BLUE'),
    plat(2700, 300, 180),
    pend(3000, 280, 'RED', 0.66, 2.4),
    // 饵段
    wall(3200),
    gem(3000),
    pwall(3400, 'RED'),
    gem(3600, 'RED'),
    spike('RED_SPIKE', 4000), spike('BLUE_SPIKE', 4150),
    gem(4200),
    // 风暴段
    lock(4500),
    bait(4800),
    gem(5000),
    mirror(5200),
    pwall(5600, 'BLUE'),
    spike('RED_SPIKE', 5800), spike('BLUE_SPIKE', 5950),
    gem(6000),
    wall(6300),
    finish(6650),
  ],
  tutorials: [
    { x: 900, text: '代价风暴：锁、镜、饵、摆锤各占一段，每段只有一个主决策' },
    { x: 4600, text: '最后 2000px 才允许两种代价同框' },
  ],
};

// ================= 第九章：动量边境 43-48 =================
//
// 设计约定：本章第一次把“颜色”与“动量/空间”绑在一起。
// - 43 弹射选线 → 44 传送带改时间 → 45 断桥三档 → 46 重力翻转 → 47 摆锤相位 → 48 四段考试
// - 每个断桥都必须有一个明确工具；翻转后 240px 内不叠新机制

const L43: LevelDef = {
  id: 43, name: '弹射分岔', chapter: 9, parTime: 22, maxCombo: 12, length: 5600, bg: '#141A20', bpm: 174,
  obstacles: [
    gem(300, 'RED'), gem(700), gem(1100, 'BLUE'),
    // 红弹射板 → 高线（只有 currency）
    launch(1200, 'RED'),
    plat(1450, 250, 200),
    currency(1500, 250),
    plat(1800, 250, 200),
    currency(1850, 250),
    mplat(2150, 250, 180),
    spike('RED_SPIKE', 1600), spike('BLUE_SPIKE', 1750),
    spike('RED_SPIKE', 2100), spike('BLUE_SPIKE', 2250),
    gem(2500, 'RED'),
    wall(2800),
    gem(3300),
    // 低线蓝弹射板 → 断桥
    spike('RED_SPIKE', 3500), spike('BLUE_SPIKE', 3650),
    launch(3700, 'BLUE'),
    pit(3800, 300),
    gem(4400),
    wall(4550),
    spike('RED_SPIKE', 4700), spike('BLUE_SPIKE', 4850),
    gem(5000),
    finish(5300),
  ],
  tutorials: [
    { x: 1100, text: '弹射板：同色高弹、异色低弹——颜色决定你落在高线还是低线' },
    { x: 3600, text: '蓝板把你压回低线并加速：断桥要靠它过去' },
  ],
};

const L44: LevelDef = {
  id: 44, name: '逆流与顺流', chapter: 9, parTime: 23, maxCombo: 15, length: 6000, bg: '#141A20', bpm: 170,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    // 顺流 +1：先教加速，不接危险
    conveyor(900, 1),
    gem(1100),
    lock(1500),
    gem(1600),
    // 逆流 -1 + 断桥
    conveyor(1750, -1, 200),
    spike('BLUE_SPIKE', 2000), spike('RED_SPIKE', 2150),
    gem(2050),
    pwall(2300, 'BLUE'),
    gem(2500, 'RED'),
    pit(2600, 180),
    spike('RED_SPIKE', 2800), spike('BLUE_SPIKE', 2950),
    gem(3000),
    // 逆流后的长减速段
    conveyor(3600, -1, 240),
    gem(3600),
    lock(4000),
    bait(4100),
    gem(4300),
    pwall(4450, 'RED'),
    // 顺流收尾
    conveyor(4600, 1, 240),
    spike('RED_SPIKE', 5000), spike('BLUE_SPIKE', 5150),
    finish(5650),
  ],
  tutorials: [
    { x: 820, text: '传送带会改变你的到达时间：加速后要更早做决定' },
    { x: 3560, text: '减速带让你以为还有时间，实际到墙时间比 1x 晚' },
  ],
};

const L45: LevelDef = {
  id: 45, name: '断桥三重', chapter: 9, parTime: 24, maxCombo: 11, length: 6200, bg: '#141A20', bpm: 170,
  obstacles: [
    gem(300, 'RED'), gem(700),
    spike('RED_SPIKE', 800), spike('BLUE_SPIKE', 950),
    gem(1100, 'BLUE'),
    boost(1300, 120),
    gem(1700),
    // 桥 1（180）：单跳可过
    pit(1800, 180),
    gem(2300),
    spike('BLUE_SPIKE', 2400), spike('RED_SPIKE', 2550),
    wall(2900),
    gem(3000, 'RED'),
    // 桥 2（240）：浮台架在缺口里
    pit(3400, 240),
    mplat(3520, 330, 160),
    gem(3700),
    wall(3900),
    gem(4100),
    // 桥 3（300）：加速带是唯一稳定解
    boost(4850, 120),
    gem(4700),
    pit(5000, 300),
    mplat(5200, 330, 160),
    spike('RED_SPIKE', 5700), spike('BLUE_SPIKE', 5850),
    finish(5950),
  ],
  tutorials: [
    { x: 1720, text: '断桥：180px 缺口单跳即可，落点后 160px 内没有尖刺' },
    { x: 3350, text: '240px 缺口：踩上缺口里的移动浮台再跳' },
    { x: 4800, text: '300px 缺口：先踩加速带，用速度换距离' },
  ],
};

const L46: LevelDef = {
  id: 46, name: '倒置折跃', chapter: 9, parTime: 24, maxCombo: 14, length: 6400, bg: '#141A20', bpm: 170,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    // 翻转 1：天花板变地面
    gravityFlip(1000),
    ceilSpike('BLUE_SPIKE', 1100), ceilSpike('RED_SPIKE', 1250),
    ceilWall(1350, 56),
    gemC(1150), gemC(1450),
    // C→G 门回地面
    portalC('PORTAL_A', 1600, 46),
    portalG('PORTAL_A', 1800, 46),
    gem(1950, 'BLUE'),
    mplat(2600, 300, 180),
    spike('RED_SPIKE', 2400), spike('BLUE_SPIKE', 2550),
    gem(2300),
    spike('RED_SPIKE', 3000), spike('BLUE_SPIKE', 3150),
    gem(2900),
    // 翻转 2：再次上到天花板
    gravityFlip(3400),
    ceilSpike('BLUE_SPIKE', 3500), ceilSpike('RED_SPIKE', 3650),
    gemC(3600), gemC(3900),
    ceilWall(3800, 56),
    // C→G 门回地面
    portalC('PORTAL_A', 4200, 47),
    portalG('PORTAL_A', 4400, 47),
    mplat(4600, 300, 180),
    spike('RED_SPIKE', 4700), spike('BLUE_SPIKE', 4850),
    gem(4550), gem(5000),
    // 翻转 3：最后一次，之后只留终点
    gravityFlip(5200),
    ceilSpike('BLUE_SPIKE', 5400),
    finish(6050),
  ],
  tutorials: [
    { x: 900, text: '重力翻转：天花板变成地面，“跳”的方向也反过来' },
    { x: 1560, text: '天花板的门把你送回地面，出口落点已经安全' },
    { x: 5150, text: '最后一次翻转后不再叠新机制，留足重新适应的时间' },
  ],
};

const L47: LevelDef = {
  id: 47, name: '摆锤相位', chapter: 9, parTime: 24, maxCombo: 17, length: 6200, bg: '#141A20', bpm: 174,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    gem(300, 'RED'), gem(700),
    // 红锤 + B 墙：时间与颜色相隔 800px
    pend(1800, 270, 'RED', 0.62, 2.3),
    gem(1100, 'BLUE'), gem(1700),
    spike('BLUE_SPIKE', 2000), spike('RED_SPIKE', 2150),
    pwall(2600, 'BLUE'),
    gem(2200), gem(2800, 'RED'),
    // 镜 + 蓝锤
    mirror(3000),
    spike('RED_SPIKE', 3300), spike('BLUE_SPIKE', 3450),
    gem(3400),
    wall(3600),
    pwall(3700, 'RED'),
    gem(4000),
    pend(4200, 280, 'BLUE', 0.7, 2.5, 1.2),
    spike('RED_SPIKE', 4400), spike('BLUE_SPIKE', 4550),
    gem(4500),
    // 锁 + 锤 + B 墙
    lock(4600),
    pwall(5000, 'BLUE'),
    gem(5100),
    finish(5850),
  ],
  tutorials: [
    { x: 1680, text: '摆锤只看时机，相位墙只看颜色：两者相隔 800px，不要同屏判断' },
    { x: 2920, text: '镜后的颜色决定你能否安全穿过蓝锤的充能圈' },
  ],
};

const L48: LevelDef = {
  id: 48, name: '边境折叠', chapter: 9, parTime: 28, maxCombo: 25, length: 7600, bg: '#141A20', bpm: 178,
  checkpoints: [2600, 5200],
  obstacles: [
    // 颜色段：锁 / 饵 / 镜，空间与动量保持静止
    gem(300, 'RED'), gem(600), gem(1000, 'BLUE'), gem(1450),
    spike('RED_SPIKE', 700), spike('BLUE_SPIKE', 850),
    lock(1200),
    bait(1500),
    gem(2000),
    spike('BLUE_SPIKE', 2100), spike('RED_SPIKE', 2250),
    mirror(2200),
    // 空间段：翻转 / 门 / 浮台
    plat(2400, 344, 180),
    currency(2450, 344),
    pwall(2600, 'BLUE'),
    gem(2700, 'BLUE'),
    mplat(3250, 250, 160),
    launch(3000, 'RED'),
    gravityFlip(3500),
    gemC(3700),
    portalC('PORTAL_A', 3800, 48),
    portalG('PORTAL_A', 4000, 48),
    // 时间段：激光 + 摆锤 + 墙
    hlaser(4100, 180),
    gem(4300),
    pwall(4400, 'RED'),
    spike('RED_SPIKE', 4450), spike('BLUE_SPIKE', 4600),
    vlaser(4720),
    gem(4800, 'RED'),
    pend(5000, 270, 'BLUE', 0.7, 2.5, 1.2),
    // 动量段：减速误导 + 加速解
    lock(5200),
    plat(5400, 300, 180),
    currency(5450, 300),
    mirror(5600),
    gem(5550),
    wall(5800),
    conveyor(5900, -1, 180),
    gem(5950),
    pwall(6000, 'BLUE'),
    spike('RED_SPIKE', 6100),
    portalG('PORTAL_A', 6200, 49),
    portalC('PORTAL_A', 6400, 49),
    gemC(6500),
    ceilSpike('BLUE_SPIKE', 6550),
    gravityFlip(6650),
    boost(6850, 140),
    pit(7000, 300),
    finish(7400),
  ],
  tutorials: [
    { x: 1100, text: '边境折叠：颜色段只考换色权，后面依次是空间、时间、动量' },
    { x: 4000, text: '每个段落只放同类机制：先读段，再读招' },
    { x: 6800, text: '最后一跳：加速带是 300px 断桥的稳定解' },
  ],
};

export const LEVELS: LevelDef[] = [
  L1, L2, L3, L4, L5,
  L6, L7, L8, L9, L10,
  L11, L12, L13, L14, L15,
  L16, L17, L18, L19, L20,
  L21, L22, L23, L24, L25,
  L26, L27, L28, L29, L30,
  L31, L32, L33, L34, L35, L36,
  L37, L38, L39, L40, L41, L42,
  L43, L44, L45, L46, L47, L48,
];

export function getLevel(id: number): LevelDef | undefined {
  return LEVELS[id - 1];
}

// ================= 特殊地图（星门进入） =================

const S1: LevelDef = {
  id: 101, name: '异磁回廊 α', chapter: 0, parTime: 32, maxCombo: 12, length: 4600, bg: '#1B1F25', bpm: 155, special: true,
  obstacles: [
    spike('RED_SPIKE', 600), spike('BLUE_SPIKE', 750),
    pend(1150, 280, 'RED', 0.62),
    pendTrap('RED_SPIKE', 1150),
    pend(1750, 280, 'BLUE', 0.62, 2.2, 2.1),
    pendTrap('BLUE_SPIKE', 1750),
    wall(2250, 56),
    pend(2700, 265, 'RED', 0.72, 2.4),
    pendTrap('RED_SPIKE', 2700),
    star(3100, 'S1', '赤极核心'),
    spike('BLUE_SPIKE', 3450), spike('RED_SPIKE', 3600),
    gem(900), gemJ(1450), gem(2050), gemJ(2700), gem(3300), gem(3900),
    finish(4100),
  ],
  tutorials: [{ x: 450, text: '特殊地图：磁暴回廊，找到彩色星核！' }],
};

const S2: LevelDef = {
  id: 102, name: '异磁回廊 β', chapter: 0, parTime: 34, maxCombo: 13, length: 5000, bg: '#1B1F25', bpm: 160, special: true,
  obstacles: [
    gravityFlip(600),
    ceilSpike('RED_SPIKE', 1100), ceilSpike('BLUE_SPIKE', 1250),
    ceilWall(1750, 56),
    gemC(1500),
    gravityFlip(2150),
    pend(2600, 290, 'BLUE', 0.66),
    pendTrap('BLUE_SPIKE', 2600),
    pend(3200, 275, 'RED', 0.75, 2.5, 1.2),
    pendTrap('RED_SPIKE', 3200),
    star(3600, 'S2', '蓝极核心'),
    spike('BLUE_SPIKE', 3950),
    gemC(850), gem(2350), gemJ(2900), gemJ(3200), gem(4150),
    finish(4400),
  ],
};

const S3: LevelDef = {
  id: 103, name: '异磁回廊 γ', chapter: 0, parTime: 34, maxCombo: 15, length: 5600, bg: '#1B1F25', bpm: 165, special: true,
  obstacles: [
    boost(500),
    spike('RED_SPIKE', 900), spike('BLUE_SPIKE', 1050),
    pend(1450, 295, 'RED', 0.7, 2.5),
    pendTrap('RED_SPIKE', 1450),
    portalG('PORTAL_B', 1950, 30),
    portalC('PORTAL_B', 2350, 30),
    ceilSpike('BLUE_SPIKE', 2550), ceilSpike('RED_SPIKE', 2700),
    gemC(2625),
    portalC('PORTAL_B', 3050, 31),
    portalG('PORTAL_B', 3450, 31),
    pend(3850, 280, 'BLUE', 0.72, 2.5),
    pendTrap('BLUE_SPIKE', 3850),
    star(4250, 'S3', '永动核心'),
    wall(4600, 56),
    gem(700), gemJ(1450), gem(3650), gemJ(3850), gem(4900),
    finish(5200),
  ],
};

// ================= 彩蛋关（三颗星核集齐后解锁） =================

const EASTER_EGG: LevelDef = {
  id: 200, name: '磁极圣殿', chapter: 0, parTime: 45, maxCombo: 20, length: 8000, bg: '#1B1F25', bpm: 174, special: true,
  obstacles: [
    spike('RED_SPIKE', 500), spike('BLUE_SPIKE', 620), spike('RED_SPIKE', 740),
    gravityFlip(1050),
    ceilSpike('RED_SPIKE', 1450), ceilSpike('BLUE_SPIKE', 1570),
    portalC('PORTAL_A', 1850, 40),
    portalG('PORTAL_A', 2450, 40),
    pend(2850, 280, 'RED', 0.66),
    pendTrap('RED_SPIKE', 2850),
    // 短程冲刺，在双柱前结束
    boost(3250, 120, 0.8),
    pend(3750, 280, 'BLUE', 0.72, 2.6, 2.0),
    pendTrap('BLUE_SPIKE', 3750),
    wall(4150, 64), wall(4650, 56),
    gravityFlip(4950),
    ceilSpike('RED_SPIKE', 5350), ceilSpike('BLUE_SPIKE', 5500),
    gravityFlip(5950),
    pend(6350, 270, 'RED', 0.7, 2.6, 1.1),
    pendTrap('RED_SPIKE', 6350),
    spike('RED_SPIKE', 6800), spike('BLUE_SPIKE', 6920),
    gem(800), gemC(1650), gem(2650), gemJ(2850), gemJ(4320), gemC(5650), gemJ(6350), gem(7150),
    finish(7500),
  ],
  tutorials: [{ x: 400, text: '✦ 隐藏圣殿：感谢你集齐全部星核！' }],
};

export const SPECIAL_LEVELS: LevelDef[] = [S1, S2, S3];
export const EASTER_EGG_LEVEL = EASTER_EGG;

export function getSpecialLevel(id: number): LevelDef | undefined {
  if (id === 200) return EASTER_EGG;
  return SPECIAL_LEVELS.find(l => l.id === id);
}

export const SPECIAL_ITEM_NAMES: Record<string, string> = {
  S1: '赤极核心',
  S2: '蓝极核心',
  S3: '永动核心',
};

// 遭遇机制（P0/P1）的数值口径与纯规则函数
// 这些常量被 GameScene / Obstacle / EditorScene / selfcheck 共用，
// 保证「设计稿数值」与「运行时行为」不会分叉。

import type { Polarity } from '../data/config';

export const MECH = {
  /** M02 极性锁：门廊内拒绝换色 */
  LOCK: {
    hold: 2.0,          // 最长锁定（秒）
    comboPenalty: 4,    // 门内强按换色：连击惩罚
    cooldownPenalty: 0.5,
    maxPenalties: 2,    // 每道门最多惩罚 2 次
    exitBonus: 3,       // 成功穿出后补连击
  },
  /** M07 磁芯诱饵 */
  BAIT: {
    cores: 1,
    combo: 2,
    switchLock: 1.2,
    maxPerLevel: 2,
    size: 26,
    floatY: 70,         // 悬高（核心中心到地面）
  },
  /** M09 磁极镜 */
  MIRROR: {
    width: 44,
    height: 90,
    invincible: 0.2,
    combo: 1,
  },
  /** M01 磁芯雨 */
  RAIN: {
    width: 520,
    count: 3,
    gap: 170,
    speed: 300,
    size: 26,
    hitRadius: 14,
    combo: 1,
    cores: 1,
  },
  /** M03 极性弹射板 */
  LAUNCH: {
    width: 96,
    height: 22,
    sameVy: 780,
    otherVy: 420,
    invincible: 0.15,
  },
  /** M05 滑动相位墙 */
  SLIDE: {
    width: 32,
    range: 100,
    period: 3.0,
  },
  /** M06 极性传送带 */
  CONVEYOR: {
    width: 320,
    height: 20,
    speed: 90,
  },
  /** M10 断桥 */
  PIT: {
    widths: [180, 240, 300] as const,
    depth: 60,
  },
  /**
   * M11 磁暴摆锤（重做）：周期性「充能」的磁力球。
   * 冷态只是背景威胁，充能窗口内才具杀伤；同色始终免疫。
   */
  PEND: {
    rope: 260,            // 默认摆长（锚点在天花板，球心最低 360）
    amplitude: 0.62,      // 默认振幅（弧度）
    period: 2.86,         // 默认周期（秒），与旧 swingSpeed 2.2 手感一致
    ballR: 20,            // 视觉半径
    hitR: 18,             // 伤害判定半径（比视觉内缩 2px，避免“看着没碰到”）
    chargeRatio: 0.55,    // 充能窗口：|θ| ≤ 振幅 × 0.55（球最低、最靠近跑道）
    warnLead: 0.45,       // 进入充能窗口前的预警时长（秒）
    dischargeGrace: 0.15, // 充能结束后的“消磁”无敌帧（秒）
    magnetRange: 175,     // 磁力半径
    magnetForce: 2400,    // 峰值磁力加速度（> GRAVITY，异色才会被吸起）
    pushVx: 40,           // 充能窗口内同色被推离 / 异色被拉近的水平速度
    minPeriod: 2.4,       // 关卡/编辑器允许的最短周期（保证存在安全窗）
  },
} as const;

/** 连击源统计：用于 selfcheck 断言「maxCombo 不超过该关可产生的连击源总数」 */
export interface ComboSourceObstacle {
  kind: string;
  meta?: Record<string, unknown>;
}

export function countComboSources(def: { obstacles: readonly ComboSourceObstacle[] }): number {
  let n = 0;
  const portalIds = new Set<number>();
  for (const o of def.obstacles) {
    switch (o.kind) {
      case 'COLLECTIBLE':
        // 分叉上层的 bonus 晶片不计入 ★2，但会产出连击：这里仍然计入上限
        n += 1;
        break;
      case 'RED_SPIKE':
      case 'BLUE_SPIKE':
      case 'WALL':
      case 'POLARITY_ZONE':
      case 'SPECIAL_ITEM':
        n += 1;
        break;
      case 'POLARITY_WALL':
        // 含滑动相位墙
        n += 1;
        break;
      case 'PENDULUM':
        n += 1;
        break;
      case 'PORTAL_A':
      case 'PORTAL_B':
        portalIds.add(Number(o.meta?.portalId ?? 0));
        break;
      case 'CORE_BAIT':
        n += MECH.BAIT.combo;
        break;
      case 'MAGNET_RAIN':
        n += MECH.RAIN.count;
        break;
      case 'MAGNET_MIRROR':
        n += MECH.MIRROR.combo;
        break;
      case 'POLARITY_LOCK':
        n += MECH.LOCK.exitBonus;
        break;
      default:
        break;
    }
  }
  // 每对传送门只会被穿越一次，按 portalId 计 +2
  n += portalIds.size * 2;
  return n;
}

/** M02：门廊内是否拒绝换色 */
export function blocksSwitch(lockTimer: number): boolean {
  return lockTimer > 0;
}

/** M09：反转极性（纯函数，一次调用只反转一次） */
export function mirrorPolarity(p: Polarity): Polarity {
  return p === 'RED' ? 'BLUE' : 'RED';
}

/** M09：磁极镜是否应当触发（同一面镜子只触发一次） */
export function mirrorShouldTrigger(triggered: boolean): boolean {
  return !triggered;
}

/** M01：磁芯雨的颜色判定：只有同色才能收集 */
export function rainCoreMatches(core: Polarity, player: Polarity): boolean {
  return core === player;
}

/** M01：每枚磁芯的确定性下落高度（time 秒 → 逻辑 y） */
export function rainCoreY(time: number, index: number, ceilingY: number, groundY: number, bandH = 24): number {
  const cycle = Math.max(1, groundY - ceilingY - bandH);
  const raw = (time * MECH.RAIN.speed + index * MECH.RAIN.gap) % cycle;
  return ceilingY + raw;
}

/** M07：诱饵奖励入账（纯函数，便于断言“磁芯 + 连击 + 锁换色”三者同时生效） */
export function applyBaitReward(state: { cores: number; combo: number; lock: number }): void {
  state.cores += MECH.BAIT.cores;
  state.combo += MECH.BAIT.combo;
  state.lock = Math.max(state.lock, MECH.BAIT.switchLock);
}

/** M10：断桥命中判定（玩家站在地面/滑铲时才算坠落） */
export function pitKills(playerBottom: number, groundY: number, overlapX: boolean): boolean {
  return overlapX && playerBottom >= groundY - 1;
}

/* ---------------- M11 磁暴摆锤（重做） ---------------- */

/** 摆角：amp × sin(ωt + phase)，ω = swingSpeed（弧度/秒） */
export function pendulumAngle(time: number, amplitude: number, swingSpeed: number, phase = 0): number {
  return amplitude * Math.sin(time * swingSpeed + phase);
}

/** 充能窗口：摆球位于最低、最靠近跑道的中心区间 */
export function pendulumCharged(angle: number, amplitude: number): boolean {
  return Math.abs(angle) <= Math.abs(amplitude) * MECH.PEND.chargeRatio + 1e-9;
}

/** 充能强度 0–1（中心最强），用于表现球体亮度与地影深浅 */
export function pendulumChargeLevel(angle: number, amplitude: number): number {
  const edge = Math.abs(amplitude) * MECH.PEND.chargeRatio;
  if (edge <= 0.0001 || !pendulumCharged(angle, amplitude)) return 0;
  return 1 - Math.abs(angle) / edge;
}

/** 单次充能窗口时长（秒），随摆动速度变化 */
export function pendulumHotDuration(swingSpeed: number): number {
  const w = Math.max(0.2, Math.abs(swingSpeed));
  return (2 * Math.asin(MECH.PEND.chargeRatio)) / w;
}

/**
 * 预警时长上限：必须短于「两次充能之间的安全间隙」，
 * 否则会在安全期误亮预警。极端配置下自动收紧。
 */
export function pendulumMaxWarnLead(swingSpeed: number): number {
  const w = Math.max(0.2, Math.abs(swingSpeed));
  const halfPeriod = Math.PI / w;
  const gap = halfPeriod - pendulumHotDuration(w);
  return Math.max(0.15, gap * 0.9);
}

/** 实际使用的预警时长：默认 0.45s，且不超过安全间隙的 90% */
export function pendulumWarnLead(swingSpeed: number): number {
  return Math.max(0.15, Math.min(MECH.PEND.warnLead, pendulumMaxWarnLead(swingSpeed)));
}

/** 是否处于“即将充能”的预警期（当前未充能，且 warnLead 秒后进入充能） */
export function pendulumWarned(
  time: number,
  amplitude: number,
  swingSpeed: number,
  phase = 0,
  warnLead = pendulumWarnLead(swingSpeed),
): boolean {
  if (pendulumCharged(pendulumAngle(time, amplitude, swingSpeed, phase), amplitude)) return false;
  return pendulumCharged(pendulumAngle(time + warnLead, amplitude, swingSpeed, phase), amplitude);
}

/** 预警进度 0–1（用于球体外的倒计时圆环），仅预警期有值 */
export function pendulumWarnProgress(
  time: number,
  amplitude: number,
  swingSpeed: number,
  phase = 0,
  warnLead = pendulumWarnLead(swingSpeed),
): number {
  if (!pendulumWarned(time, amplitude, swingSpeed, phase, warnLead)) return 0;
  const steps = 18;
  for (let i = 1; i <= steps; i++) {
    const dt = (warnLead * i) / steps;
    if (pendulumCharged(pendulumAngle(time + dt, amplitude, swingSpeed, phase), amplitude)) {
      return 1 - dt / warnLead;
    }
  }
  return 1;
}

/**
 * M11 致死判定：
 * 同色永远免疫；异色必须在充能窗口内、判定圆与玩家重叠、且没有无敌/消磁保护。
 */
export function pendulumLethal(s: {
  samePolarity: boolean;
  charged: boolean;
  overlapping: boolean;
  grace: boolean;
}): boolean {
  return !s.samePolarity && s.charged && s.overlapping && !s.grace;
}

/** 磁力方向：同色排斥（−1，向下/远离）· 异色吸引（+1，向上/靠近）· 冷态无磁力（0） */
export function pendulumMagnetDir(samePolarity: boolean, charged: boolean): -1 | 0 | 1 {
  if (!charged) return 0;
  return samePolarity ? -1 : 1;
}

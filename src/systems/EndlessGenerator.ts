// 无尽模式 2.0：按「距离分区 + 种子」程序化生成
//
// 分区（按世界 x 坐标，50px = 1m）：
//   0–4000      基础区（灰墙 / 尖刺 / 加速带）
//   4000–9000   传送区（成对传送门）
//   9000–13000  重力区（重力翻转段）
//   13000–18000 摆锤区（磁暴摆锤）
//   18000–26000 磁暴区（摆锤 + 脉冲激光）
//   26000+      深渊区（新遭遇机制时间表，按距离折算 ≈ 60s 一档）
// 每次跨越分区留出 600px 安全走廊，避免一出传送门就撞墙。
// 种子固定时生成结果完全一致（每日挑战依赖这一点）。

import { ObstacleConfig } from '../entities/Obstacle';
import { GAME_CONFIG, Polarity } from '../data/config';
import { LevelDef } from '../data/levels';
import { localDate } from './SaveSystem';
import { PALETTE } from '../ui/theme';

const GROUND = GAME_CONFIG.GROUND_Y;
const CEIL = GAME_CONFIG.CEILING_Y;

/** 确定性 PRNG（mulberry32） */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const DAILY_MODIFIERS = [
  { id: 'speed', name: '疾风', desc: '奔跑速度 +10%' },
  { id: 'dense', name: '拥挤', desc: '障碍更密集' },
  { id: 'storm', name: '磁暴', desc: '磁暴每 30 秒一次' },
  { id: 'gems', name: '富矿', desc: '磁芯数量 +50%' },
] as const;
export type DailyModifierId = typeof DAILY_MODIFIERS[number]['id'];

/** 按日期生成固定种子（同一天同一份无尽地图） */
export function dailySeed(date = localDate()): number {
  return hashString(`magnetic-rush-daily-${date}`);
}

/** 当日两个修正（确定性抽取，所有人同一天一致） */
export function dailyModifiers(date = localDate()): DailyModifierId[] {
  const rng = mulberry32(dailySeed(date));
  const pool = DAILY_MODIFIERS.map(m => m.id);
  // Fisher–Yates 后取前 2
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, GAME_CONFIG.DAILY_MODIFIER_COUNT);
  // PRD：疾风 + 磁暴 组合难度过高，命中时用后续备选替换第二个
  if (picked.includes('speed') && picked.includes('storm')) {
    const alt = pool.slice(GAME_CONFIG.DAILY_MODIFIER_COUNT)
      .find(id => id !== 'speed' && id !== 'storm');
    if (alt) picked[picked.indexOf('storm')] = alt;
  }
  return picked as DailyModifierId[];
}

export function dailyModifierLabel(ids: readonly string[]): string {
  const map = new Map(DAILY_MODIFIERS.map(m => [m.id as string, m]));
  return ids.map(id => map.get(id)?.name ?? id).join(' · ');
}

/** 分区边界（世界 x） */
const ZONE_ENDS = [4000, 9000, 13000, 18000, 26000, Number.POSITIVE_INFINITY];
const ZONE_NAMES = ['基础', '传送', '重力', '摆锤', '磁暴', '深渊'];

type Cfg = ObstacleConfig;

export interface EndlessOptions {
  seed?: number;
  modifiers?: readonly string[];
  /** 额外速度倍率（每日修正等），只影响速度，不影响生成 */
  speedMul?: number;
}

export class EndlessGenerator {
  private nextX = 700;
  private portalSeq = 100;
  private rng: () => number;
  private modifiers: Set<string>;
  private cooldown = 0;
  private zone = 0;
  private lastGemAt = 300;
  /** 富矿修正的隔次补发开关（长期 +50%） */
  private gemBonusFlip = false;

  constructor(opts: EndlessOptions | number = {}) {
    const o: EndlessOptions = typeof opts === 'number' ? { seed: opts } : opts;
    this.rng = mulberry32(o.seed ?? Date.now());
    this.modifiers = new Set(o.modifiers ?? []);
  }

  /** 当前难度分区索引 0–5 */
  get zoneIndex(): number {
    return this.zone;
  }

  get zoneName(): string {
    return ZONE_NAMES[this.zone];
  }

  private get dense(): number {
    return this.modifiers.has('dense') ? 0.88 : 1;
  }

  private rand(min: number, max: number) {
    return min + this.rng() * (max - min);
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  private zoneOf(x: number): number {
    for (let i = 0; i < ZONE_ENDS.length; i++) {
      if (x < ZONE_ENDS[i]) return i;
    }
    return ZONE_ENDS.length - 1;
  }

  /** 生成障碍直到覆盖 targetX（世界坐标） */
  produceUntil(targetX: number): Cfg[] {
    const out: Cfg[] = [];
    while (this.nextX < targetX) {
      // 分区切换：插入 600px 安全走廊
      const z = this.zoneOf(this.nextX);
      if (z !== this.zone) {
        this.zone = z;
        this.cooldown = Math.max(this.cooldown, GAME_CONFIG.ENDLESS_ZONE_SAFE_CORRIDOR);
      }

      const gap = Math.max(170, (300 - this.nextX / 150) * this.dense);
      if (this.cooldown > 0) {
        this.cooldown -= gap;
        this.nextX += gap;
        continue;
      }

      const x = Math.round(this.nextX);

      // 磁芯：每 ~800px 一枚（不算入关卡晶片总数）
      // 富矿：每两个磁芯节点额外补一枚（长期均值 +50%，与 PRD 一致；
      // 单纯缩短间距会被障碍步长粒度吃掉，达不到目标密度）
      if (x - this.lastGemAt >= 780) {
        this.lastGemAt = x;
        out.push({
          kind: 'COLLECTIBLE', x, y: GROUND - 96, w: 26, h: 26,
          meta: { currency: 1 },
        });
        if (this.modifiers.has('gems')) {
          this.gemBonusFlip = !this.gemBonusFlip;
          if (this.gemBonusFlip) {
            out.push({
              kind: 'COLLECTIBLE', x: x + 18, y: GROUND - 96, w: 26, h: 26,
              meta: { currency: 1 },
            });
          }
        }
      }

      switch (this.zone) {
        case 0: {
          if (this.buildBase(x, out)) continue;
          break;
        }
        case 1: {
          if (this.rng() < 0.22) {
            this.buildPortal(x, out);
            this.nextX += 1000 * this.dense;
            this.cooldown = 420;
            continue;
          }
          if (this.buildBase(x, out)) continue;
          break;
        }
        case 2: {
          if (this.rng() < 0.18) {
            this.buildGravitySection(x, out);
            this.nextX += 1900 * this.dense;
            this.cooldown = 560;
            continue;
          }
          if (this.buildBase(x, out)) continue;
          break;
        }
        case 3: {
          if (this.rng() < 0.2) {
            this.buildPendulum(x, out);
            this.nextX += this.rand(520, 640) * this.dense;
            this.cooldown = 340;
            continue;
          }
          if (this.buildBase(x, out)) continue;
          break;
        }
        case 4: {
          if (this.rng() < 0.14) {
            this.buildLaser(x, out);
            this.nextX += this.rand(560, 720) * this.dense;
            this.cooldown = 380;
            continue;
          }
          if (this.rng() < 0.16) {
            this.buildPendulum(x, out);
            this.nextX += this.rand(520, 640) * this.dense;
            this.cooldown = 340;
            continue;
          }
          if (this.buildBase(x, out)) continue;
          break;
        }
        default: {
          // 深渊区：新机制按距离解锁（≈60s 一档，保持种子确定性）
          if (this.buildDeep(x, out)) continue;
          if (this.rng() < 0.12) {
            this.buildLaser(x, out);
            this.nextX += this.rand(560, 720) * this.dense;
            this.cooldown = 380;
            continue;
          }
          if (this.rng() < 0.14) {
            this.buildPendulum(x, out);
            this.nextX += this.rand(520, 640) * this.dense;
            this.cooldown = 340;
            continue;
          }
          if (this.buildBase(x, out)) continue;
          break;
        }
      }
    }
    return out;
  }

  /** 基础段落；返回 true 表示已放置并推进游标 */
  private buildBase(x: number, out: Cfg[]): boolean {
    const d = x / 4000;
    const gap = Math.max(170, (300 - x / 150)) * this.dense;
    const roll = this.rng();

    // 加速带
    if (x > 4000 && roll < 0.10) {
      out.push({ kind: 'SPEED_BOOST', x, y: GROUND - 20, w: 120, h: 20, meta: { multiplier: 2.0, duration: 3 } });
      this.nextX += 420 * this.dense;
      return true;
    }

    // 极性反转区
    if (x > 2500 && roll < 0.20) {
      const p: Polarity = this.pick(['RED', 'BLUE']);
      out.push({ kind: 'POLARITY_ZONE', x, y: CEIL, w: 64, h: GROUND - CEIL, meta: { forcedPolarity: p } });
      const danger: Polarity = p === 'RED' ? 'BLUE' : 'RED';
      out.push({ kind: danger === 'RED' ? 'RED_SPIKE' : 'BLUE_SPIKE', x: x + 320, y: GROUND - 32, w: 32, h: 32 });
      this.nextX += 620 * this.dense;
      return true;
    }

    // 相位墙（分区 1 之后逐步出现）
    if (x > 6000 && roll < 0.30) {
      const p: Polarity = this.pick(['RED', 'BLUE']);
      out.push({ kind: 'POLARITY_WALL', x, y: CEIL, w: 24, h: GROUND - CEIL, meta: { polarity: p } });
      this.nextX += 520 * this.dense;
      this.cooldown = 260;
      return true;
    }

    // 灰墙
    if (roll < 0.52) {
      out.push({ kind: 'WALL', x, y: GROUND - 56, w: 40, h: 56 });
      this.nextX += this.rand(520, 640) * this.dense;
      this.cooldown = 320;
      return true;
    }

    // 尖刺：单/双/三连
    const color: Polarity = this.pick(['RED', 'BLUE']);
    const pairCount = d > 1.5 && this.rng() < 0.35 ? 3 : (this.rng() < 0.45 ? 2 : 1);
    const spacing = Math.max(130, 170 - d * 6);
    for (let i = 0; i < pairCount; i++) {
      const c: Polarity = i % 2 === 0 ? color : (color === 'RED' ? 'BLUE' : 'RED');
      out.push({
        kind: c === 'RED' ? 'RED_SPIKE' : 'BLUE_SPIKE',
        x: x + i * spacing, y: GROUND - 32, w: 32, h: 32,
      });
    }
    this.nextX += gap + (pairCount - 1) * spacing;
    return true;
  }

  private buildPortal(x: number, out: Cfg[]) {
    const id = this.portalSeq++;
    const kind = this.rng() < 0.5 ? 'PORTAL_A' : 'PORTAL_B';
    out.push({ kind, x, y: GROUND - 64, w: 48, h: 64, meta: { portalId: id } });
    out.push({ kind, x: x + 650, y: GROUND - 64, w: 48, h: 64, meta: { portalId: id } });
  }

  /** 重力段：翻转 → 天花板尖刺 → 再翻转恢复 */
  private buildGravitySection(x: number, out: Cfg[]) {
    out.push({ kind: 'GRAVITY_FLIP', x, y: CEIL, w: 56, h: GROUND - CEIL });
    const c1: Polarity = this.pick(['RED', 'BLUE']);
    out.push({
      kind: c1 === 'RED' ? 'RED_SPIKE' : 'BLUE_SPIKE',
      x: x + 450, y: CEIL, w: 32, h: 32,
    });
    const c2: Polarity = c1 === 'RED' ? 'BLUE' : 'RED';
    out.push({
      kind: c2 === 'RED' ? 'RED_SPIKE' : 'BLUE_SPIKE',
      x: x + 750, y: CEIL, w: 32, h: 32,
    });
    out.push({ kind: 'GRAVITY_FLIP', x: x + 1250, y: CEIL, w: 56, h: GROUND - CEIL });
  }

  private buildPendulum(x: number, out: Cfg[]) {
    const p: Polarity = this.pick(['RED', 'BLUE']);
    out.push({
      kind: 'PENDULUM', x, y: CEIL, w: 40, h: 40,
      meta: {
        rope: Math.round(this.rand(175, 220)),
        polarity: p,
        amplitude: this.rand(0.6, 0.72),
        swingSpeed: this.rand(2.2, 2.7),
      },
    });
  }

  /**
   * 深渊区新机制时间表（按距离解锁，等价于设计稿秒表）：
   *   26000+ 磁芯雨 / 弹射板 / 传送带 / 断桥
   *   30000+ 极性锁
   *   34000+ 磁芯诱饵
   *   38000+ 磁极镜
   * 返回 true 表示已放置并推进游标。
   */
  private buildDeep(x: number, out: Cfg[]): boolean {
    const roll = this.rng();

    if (roll < 0.10) {
      const p: Polarity = this.pick(['RED', 'BLUE']);
      out.push({
        kind: 'MAGNET_RAIN', x, y: CEIL, w: 520, h: GROUND - CEIL,
        meta: { polarity: p, count: 3 },
      });
      this.nextX += 760 * this.dense;
      this.cooldown = 360;
      return true;
    }
    if (roll < 0.18) {
      const p: Polarity = this.pick(['RED', 'BLUE']);
      out.push({
        kind: 'LAUNCH_PAD', x, y: GROUND - 22, w: 96, h: 22,
        meta: { polarity: p },
      });
      this.nextX += 520 * this.dense;
      this.cooldown = 260;
      return true;
    }
    if (roll < 0.26) {
      out.push({
        kind: 'CONVEYOR', x, y: GROUND - 20, w: 320, h: 20,
        meta: { dir: this.rng() < 0.5 ? 1 : -1, speed: 90 },
      });
      this.nextX += 520 * this.dense;
      this.cooldown = 240;
      return true;
    }
    if (roll < 0.34) {
      const w = this.rng() < 0.5 ? 180 : 240;
      out.push({ kind: 'PIT', x, y: GROUND - 1, w, h: 30 });
      this.nextX += w + 320;
      this.cooldown = 320;
      return true;
    }
    if (x > 30000 && roll < 0.42) {
      out.push({ kind: 'POLARITY_LOCK', x, y: CEIL, w: 64, h: GROUND - CEIL });
      this.nextX += 460 * this.dense;
      this.cooldown = 300;
      return true;
    }
    if (x > 34000 && roll < 0.50) {
      const size = 40;
      out.push({
        kind: 'CORE_BAIT', x, y: GROUND - 70 - size / 2, w: size, h: size,
      });
      this.nextX += 480 * this.dense;
      this.cooldown = 260;
      return true;
    }
    if (x > 38000 && roll < 0.56) {
      out.push({ kind: 'MAGNET_MIRROR', x, y: GROUND - 110, w: 44, h: 90 });
      this.nextX += 500 * this.dense;
      this.cooldown = 300;
      return true;
    }
    return false;
  }

  private buildLaser(x: number, out: Cfg[]) {
    const period = this.rand(2.6, 3.2);
    // 一半顶部光柱（贴地通过），一半贴地光束（跳过）
    if (this.rng() < 0.5) {
      const gap = 90;
      out.push({
        kind: 'PULSE_LASER', x, y: CEIL, w: 18, h: GROUND - CEIL - gap,
        meta: { orientation: 'V', period, warn: GAME_CONFIG.PULSE_LASER_WARN, on: 0.5 },
      });
    } else {
      out.push({
        kind: 'PULSE_LASER', x, y: GROUND - GAME_CONFIG.PULSE_LASER_HEIGHT, w: 200, h: GAME_CONFIG.PULSE_LASER_HEIGHT,
        meta: { orientation: 'H', period, warn: GAME_CONFIG.PULSE_LASER_WARN, on: 0.5 },
      });
    }
  }
}

/** 无尽模式的空 LevelDef（障碍由生成器持续填充） */
export function createEndlessLevelDef(name = '无尽狂奔', bpm = 155): LevelDef {
  return {
    id: 0,
    name,
    chapter: 0,
    parTime: 0,
    maxCombo: 0,
    length: Number.MAX_SAFE_INTEGER,
    bg: PALETTE.board950,
    bpm,
    obstacles: [],
  };
}

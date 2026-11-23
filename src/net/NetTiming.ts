// 联机时延工具（纯逻辑，无 WebSocket 依赖，可被 selfcheck 直接断言）
// 1) RttStats：ping/pong 往返时延的最小/中位/最大值统计
// 2) RemoteInterpolator：远端状态按本地接收时间缓冲插值 + 有限外推

import { GAME_CONFIG } from '../data/config';

/** 插值缓冲：渲染时刻 = 最新包到达时刻 - 该值（30Hz 下约 1.2 个包，压到 66ms 台阶以下） */
export const INTERP_DELAY_MS = 40;
/** 外推上限：超过这个时长就不再向前推测，避免抖动/超前 */
export const MAX_EXTRAPOLATION_MS = 120;
/** 单包最多保留的历史时长 */
export const INTERP_WINDOW_MS = 1_000;
/** 缓冲内最多保留的包数（30Hz 下约 0.4s） */
export const INTERP_MAX_SAMPLES = 12;
/** 相对上一包回退超过该像素，视为死亡复活/传送：直接清空历史，避免倒着插值 */
export const RESPAWN_JUMP_PX = 32;

export interface RemoteSnapshot {
  /** 本地接收时刻（performance.now） */
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  polarity: number;
  sliding: boolean;
  flipped: boolean;
  alive: boolean;
  finished: boolean;
}

export interface RemoteView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  polarity: number;
  sliding: boolean;
  flipped: boolean;
  alive: boolean;
  /** 本次视图中外推的毫秒数（0 = 纯插值） */
  extrapolatedMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function spawnSnapshot(s: RemoteSnapshot, t: number): RemoteSnapshot {
  return {
    t,
    x: s.x,
    y: s.y,
    vx: s.vx,
    vy: s.vy,
    polarity: s.polarity,
    sliding: s.sliding,
    flipped: s.flipped,
    alive: s.alive,
    finished: s.finished,
  };
}

export class RemoteInterpolator {
  private buf: RemoteSnapshot[] = [];

  get size() { return this.buf.length; }
  get newest(): RemoteSnapshot | undefined { return this.buf[this.buf.length - 1]; }

  clear() { this.buf = []; }

  /** 收到一包远端状态；时间戳由调用方传入本地接收时钟 */
  push(s: RemoteSnapshot) {
    const last = this.buf[this.buf.length - 1];
    // 复活/被拉回检查点：位置明显倒退，历史全部作废（只留新包）
    if (last && s.x < last.x - RESPAWN_JUMP_PX) {
      this.buf = [spawnSnapshot(s, s.t)];
      return;
    }
    this.buf.push(spawnSnapshot(s, s.t));
    const cutoff = s.t - INTERP_WINDOW_MS;
    while (this.buf.length > INTERP_MAX_SAMPLES) this.buf.shift();
    while (this.buf.length > 2 && this.buf[0].t < cutoff) this.buf.shift();
  }

  /**
   * 采样渲染状态：
   * - 未到最旧包 → 用最旧包
   * - 命中两包之间 → 线性插值（极性/滑行/翻转取左侧包，避免颜色提前跳变）
   * - 超过最新包 → 按 vx/vy 有限外推，最多 MAX_EXTRAPOLATION_MS，且 y 夹在可站立区间
   */
  sample(now: number, delay = INTERP_DELAY_MS): RemoteView | null {
    if (this.buf.length === 0) return null;
    const oldest = this.buf[0];
    const newest = this.buf[this.buf.length - 1];
    const target = now - delay;

    if (target <= oldest.t) return this.viewOf(oldest, 0);

    if (target >= newest.t) {
      const rawMs = target - newest.t;
      // 已完成/死亡：不再向外推测
      if (newest.finished || !newest.alive) return this.viewOf(newest, 0);
      const dt = Math.min(rawMs, MAX_EXTRAPOLATION_MS) / 1000;
      const vx = newest.vx > 0 ? newest.vx : 0;
      const x = clamp(newest.x + vx * dt, 0, newest.x + GAME_CONFIG.RUN_SPEED * (MAX_EXTRAPOLATION_MS / 1000));
      const y = clamp(
        newest.y + newest.vy * dt,
        GAME_CONFIG.CEILING_Y - GAME_CONFIG.PLAYER_SIZE,
        GAME_CONFIG.GROUND_Y - GAME_CONFIG.PLAYER_SIZE,
      );
      return {
        ...this.viewOf(newest, 0),
        x, y,
        extrapolatedMs: Math.min(rawMs, MAX_EXTRAPOLATION_MS),
      };
    }

    // 目标落在历史区间：找到左右两包
    for (let i = this.buf.length - 1; i >= 1; i--) {
      const b = this.buf[i];
      const a = this.buf[i - 1];
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const k = span > 0 ? (target - a.t) / span : 1;
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          vx: a.vx + (b.vx - a.vx) * k,
          vy: a.vy + (b.vy - a.vy) * k,
          // 离散状态不插值：用左包（渲染时刻的真实状态）
          polarity: a.polarity,
          sliding: a.sliding,
          flipped: a.flipped,
          alive: a.alive && b.alive,
          extrapolatedMs: 0,
        };
      }
    }
    return this.viewOf(newest, 0);
  }

  private viewOf(s: RemoteSnapshot, extrapolatedMs: number): RemoteView {
    return {
      x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      polarity: s.polarity, sliding: s.sliding, flipped: s.flipped,
      alive: s.alive, extrapolatedMs,
    };
  }
}

/** ping/pong 往返时延统计（保留最近 N 个样本） */
export const RTT_MAX_SAMPLES = 30;

export class RttStats {
  private samples: number[] = [];

  get count() { return this.samples.length; }
  get last(): number | null {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  clear() { this.samples = []; }

  add(ms: number) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return;
    this.samples.push(ms);
    while (this.samples.length > RTT_MAX_SAMPLES) this.samples.shift();
  }

  min(): number | null {
    if (!this.samples.length) return null;
    return Math.min(...this.samples);
  }

  max(): number | null {
    if (!this.samples.length) return null;
    return Math.max(...this.samples);
  }

  median(): number | null {
    if (!this.samples.length) return null;
    const a = [...this.samples].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** 形如 "24ms（12–39，中位 22）"；没有样本返回 null */
  summary(): string | null {
    const med = this.median();
    if (med === null) return null;
    return `${Math.round(med)}ms（${Math.round(this.min()!)}–${Math.round(this.max()!)}）`;
  }
}

// 自定义关卡存储 + 关卡码编解码

import { ObstacleKind, ObstacleConfig } from '../entities/Obstacle';
import { LevelDef } from '../data/levels';
import { PALETTE } from '../ui/theme';

const STORE_KEY = 'magnetic_rush_custom_levels_v1';

export interface CustomObstacleDto {
  kind: ObstacleKind;
  x: number; y: number; w: number; h: number;
  meta?: Record<string, unknown>;
}

export interface CustomLevelData {
  id: number;
  name: string;
  obstacles: CustomObstacleDto[];
  createdAt: number;
  /** 上传到服务器后拿到的 8 位分享码（本地保存，便于在「我的地图」再次查看/复制） */
  shareCode?: string;
}

const VALID_KINDS: ObstacleKind[] = [
  'RED_SPIKE', 'BLUE_SPIKE', 'WALL', 'PORTAL_A', 'PORTAL_B',
  'POLARITY_ZONE', 'GRAVITY_FLIP', 'SPEED_BOOST', 'FINISH',
  'PENDULUM', 'COLLECTIBLE', 'SPECIAL_ITEM', 'PLATFORM',
  'MOVING_PLATFORM', 'POLARITY_WALL', 'PULSE_LASER',
  'MAGNET_RAIN', 'POLARITY_LOCK', 'CORE_BAIT', 'MAGNET_MIRROR',
  'LAUNCH_PAD', 'CONVEYOR', 'PIT', 'COMBO_GATE',
];

export class CustomLevelStore {
  private listCache: CustomLevelData[] | null = null;

  list(): CustomLevelData[] {
    if (this.listCache) return this.listCache;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      this.listCache = raw ? JSON.parse(raw) : [];
    } catch {
      this.listCache = [];
    }
    return this.listCache!;
  }

  private commit() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.list()));
    } catch { /* ignore */ }
  }

  save(data: CustomLevelData): CustomLevelData {
    const all = this.list();
    const idx = all.findIndex(l => l.id === data.id);
    if (idx >= 0) all[idx] = data;
    else all.push(data);
    all.sort((a, b) => a.createdAt - b.createdAt);
    this.commit();
    return data;
  }

  delete(id: number) {
    this.listCache = this.list().filter(l => l.id !== id);
    this.commit();
  }

  newId(): number {
    return Date.now();
  }

  // ---- 关卡码 ----

  encode(data: CustomLevelData): string {
    const payload = JSON.stringify({ v: 1, n: data.name, o: data.obstacles });
    return btoa(unescape(encodeURIComponent(payload)));
  }

  decode(code: string): CustomLevelData | null {
    try {
      const json = decodeURIComponent(escape(atob(code.trim())));
      const raw = JSON.parse(json);
      if (!raw || !Array.isArray(raw.o)) return null;
      const obstacles = sanitizeObstacles(raw.o);
      if (obstacles.length === 0) return null;
      return {
        id: this.newId(),
        name: typeof raw.n === 'string' && raw.n.trim() ? raw.n.trim().slice(0, 20) : '导入关卡',
        obstacles,
        createdAt: Date.now(),
      };
    } catch {
      return null;
    }
  }
}

/** 导出供远程下载复用：按白名单清洗障碍，未知字段一律丢弃 */
export function sanitizeObstacles(arr: unknown[]): CustomObstacleDto[] {
  const out: CustomObstacleDto[] = [];
  let baits = 0;
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    if (!o || typeof o !== 'object') continue;
    const kind = o.kind as ObstacleKind;
    if (!VALID_KINDS.includes(kind)) continue;
    // 磁芯诱饵：每关最多 2 枚
    if (kind === 'CORE_BAIT') {
      if (baits >= 2) continue;
      baits++;
    }
    const num = (v: unknown, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const cfg: CustomObstacleDto = {
      kind,
      x: Math.round(num(o.x, 0)),
      y: Math.round(num(o.y, 0)),
      w: Math.round(num(o.w, 32)),
      h: Math.round(num(o.h, 32)),
    };
    if (o.meta && typeof o.meta === 'object') {
      const meta = sanitizeMeta(kind, o.meta as Record<string, unknown>);
      if (meta) cfg.meta = meta;
    }
    if (cfg.x < 0 || cfg.x > 20000 || cfg.w < 8 || cfg.w > 560 || cfg.h < 8 || cfg.h > 600) continue;
    out.push(cfg);
  }
  return out;
}

/** 只保留各类型已知字段并夹取数值，避免导入码注入任意 meta */
function sanitizeMeta(kind: ObstacleKind, raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  switch (kind) {
    case 'PORTAL_A':
    case 'PORTAL_B':
      return { portalId: Math.round(num(raw.portalId, 1)) };
    case 'POLARITY_ZONE':
      return { forcedPolarity: raw.forcedPolarity === 'BLUE' ? 'BLUE' : 'RED' };
    case 'SPEED_BOOST':
      return {
        multiplier: clamp(num(raw.multiplier, 2), 1.2, 3),
        duration: clamp(num(raw.duration, 3), 0.5, 10),
      };
    case 'PENDULUM':
      return {
        rope: clamp(num(raw.rope, 260), 150, 340),
        polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED',
        amplitude: clamp(num(raw.amplitude, 0.62), 0.35, 0.85),
        // 周期 ≥ 2.4s（角速度 ≤ 2.62），保证充能窗口之间始终有安全间隙
        swingSpeed: clamp(num(raw.swingSpeed, 2.2), 1.2, 2.62),
        warnLead: clamp(num(raw.warnLead, 0.45), 0.3, 0.8),
        phase: num(raw.phase, 0),
      };
    case 'SPECIAL_ITEM':
      return {
        itemId: typeof raw.itemId === 'string' ? raw.itemId.slice(0, 24) : 'CUSTOM_STAR',
        itemName: typeof raw.itemName === 'string' ? raw.itemName.slice(0, 16) : '星核',
      };
    case 'COLLECTIBLE': {
      // 颜色白名单夹取：任何非 RED/BLUE 的注入值一律丢弃（= 任意极性可拾取）
      const meta: Record<string, unknown> = {};
      if (raw.color === 'RED' || raw.color === 'BLUE') meta.color = raw.color;
      if (raw.currency === 1 || raw.currency === true) meta.currency = 1;
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    case 'MOVING_PLATFORM':
      return {
        axis: raw.axis === 'x' ? 'x' : 'y',
        range: clamp(num(raw.range, 90), 60, 140),
        period: clamp(num(raw.period, 3), 2.4, 4),
        phase: clamp(num(raw.phase, 0), 0, 1),
      };
    case 'POLARITY_WALL': {
      const meta: Record<string, unknown> = { polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED' };
      const range = clamp(num(raw.range, 0), 0, 140);
      if (range > 0) {
        meta.range = range;
        meta.period = clamp(num(raw.period, 3), 2, 5);
        meta.phase = clamp(num(raw.phase, 0), 0, 1);
      }
      return meta;
    }
    case 'MAGNET_RAIN':
      return {
        polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED',
        count: Math.round(clamp(num(raw.count, 3), 1, 5)),
      };
    case 'LAUNCH_PAD':
      return { polarity: raw.polarity === 'BLUE' ? 'BLUE' : 'RED' };
    case 'CONVEYOR':
      return {
        dir: raw.dir === -1 ? -1 : 1,
        speed: clamp(num(raw.speed, 90), 30, 180),
      };
    case 'POLARITY_LOCK':
    case 'CORE_BAIT':
    case 'MAGNET_MIRROR':
    case 'PIT':
      return undefined;
    case 'PULSE_LASER':
      return {
        orientation: raw.orientation === 'H' ? 'H' : 'V',
        period: clamp(num(raw.period, 2.8), 2.4, 3.2),
        warn: 0.8,
        on: clamp(num(raw.on, 0.5), 0.4, 0.6),
      };
    default:
      return undefined;
  }
}

/** 自定义数据 → 可运行 LevelDef */
export function customToLevelDef(data: CustomLevelData): LevelDef {
  const maxX = data.obstacles.reduce((m, o) => Math.max(m, o.x + o.w), 0);
  const hasFinish = data.obstacles.some(o => o.kind === 'FINISH');
  const obstacles: ObstacleConfig[] = data.obstacles.map(o => ({ ...o }));
  if (!hasFinish) {
    obstacles.push({
      kind: 'FINISH', x: maxX + 500, y: 100, w: 24, h: 340,
    });
  }
  return {
    id: 9000,
    name: data.name,
    chapter: 0,
    parTime: 30,
    maxCombo: 0,
    length: maxX + 700,
    bg: PALETTE.board950,
    bpm: 140,
    obstacles: obstacles as LevelDef['obstacles'],
  };
}

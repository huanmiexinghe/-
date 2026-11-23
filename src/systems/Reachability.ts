// 可拾取物可达性判定（离线，仅 selfcheck 使用）
//
// 用 GAME_CONFIG 的真实物理参数推导跳跃包络，再逐关检查每一枚可拾取物：
//   ① HEIGHT  垂直方向超出跳跃包络（从地面 / 天花板 / 平台起跳都够不到）
//   ② BLOCKED 水平路径不可通行（嵌在实体柱内、落在断桥坑里、被传送门跳过）
//   ③ TIGHT   贴障碍边缘 / 起跳容错过低（低于 MIN_TAKEOFF_WINDOW 或净空不足）
//   ④ MECH    必须借助移动浮台 / 脉冲激光等机制才能拿到（需登记豁免，不得静默放宽）
//
// 物理模型（与 Player.update 一致，单段跳，无二段跳）：
//   h(t) = v0·t − g·t²/2，v0=520、g=1400 → 最大跳高 96.6px、滞空 0.743s
//   基础速度 320px/s → 单跳最大水平位移 237.7px
//   地面起跳（碰撞盒底部 440）或天花板起跳（重力翻转，底部 140，方向朝下）
//   拾取判定：玩家盒与拾取物盒各收缩 s 像素后相交（COLLECTIBLE 5、其余 4）

import { GAME_CONFIG } from '../data/config';
import { LevelDef, LevelObstacle } from '../data/levels';
import { ObstacleKind } from '../entities/Obstacle';
import { MECH } from './Mechanics';

const CFG = GAME_CONFIG;
const P = CFG.PLAYER_SIZE;

export const JUMP_V0 = -CFG.JUMP_FORCE;
export const MAX_JUMP_RISE = (JUMP_V0 * JUMP_V0) / (2 * CFG.GRAVITY);
export const JUMP_AIR_TIME = (2 * JUMP_V0) / CFG.GRAVITY;
export const MAX_JUMP_DISTANCE = CFG.RUN_SPEED * JUMP_AIR_TIME;
/** 起跳容错窗口下限（px）：低于该宽度视为“必须擦边” */
export const MIN_TAKEOFF_WINDOW = 40;
/** 拾取物与致命障碍的最小净空（px） */
export const MIN_EDGE_CLEARANCE = 8;

const GROUND_BOTTOM = CFG.GROUND_Y;
const CEIL_BOTTOM = CFG.CEILING_Y + P;
const STEP = 4;
const SIM_DT = 1 / 240;

const PICKUP_KINDS: ObstacleKind[] = ['COLLECTIBLE', 'SPECIAL_ITEM', 'CORE_BAIT'];
const PICKUP_SHRINK: Partial<Record<ObstacleKind, number>> = {
  COLLECTIBLE: 5,
  SPECIAL_ITEM: 4,
  CORE_BAIT: 4,
};

export type ReachIssueType = 'HEIGHT' | 'BLOCKED' | 'TIGHT' | 'MECH';

export interface ReachIssue {
  levelId: number;
  kind: ObstacleKind;
  x: number;
  y: number;
  w: number;
  h: number;
  type: ReachIssueType;
  detail: string;
}

export function collectibleKey(levelId: number, o: { x: number; kind: string }): string {
  return `${levelId}:${o.x}:${o.kind}`;
}

interface Box { x: number; y: number; w: number; h: number }

function boxOf(o: LevelObstacle): Box {
  return { x: o.x, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 };
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 两盒的欧氏净距（相交返回 0） */
function gap(a: Box, b: Box): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.sqrt(dx * dx + dy * dy);
}

function shrunk(b: Box, n: number): Box {
  return { x: b.x + n, y: b.y + n, w: Math.max(0, b.w - 2 * n), h: Math.max(0, b.h - 2 * n) };
}

/* ---------------------------- 路线状态（重力 / 传送跳过） ---------------------------- */

interface PortalSpan {
  entry: number;
  exit: number;
  /** 入口在左侧时，(entry, exit) 区间不会被玩家经过 */
  skips: boolean;
  flip: boolean;
}

function isPortal(o: LevelObstacle): boolean {
  return o.kind === 'PORTAL_A' || o.kind === 'PORTAL_B';
}

function isCeilingPortal(o: LevelObstacle): boolean {
  return (o.y ?? 0) <= CFG.CEILING_Y + 8;
}

function isGroundPortal(o: LevelObstacle): boolean {
  return (o.y ?? 0) + (o.h ?? 0) >= GROUND_BOTTOM - 2;
}

function portalSpans(def: LevelDef): PortalSpan[] {
  const groups = new Map<number, LevelObstacle[]>();
  for (const o of def.obstacles) {
    if (!isPortal(o) || o.meta?.portalId === undefined) continue;
    const id = o.meta.portalId;
    const arr = groups.get(id) ?? [];
    arr.push(o);
    groups.set(id, arr);
  }
  const spans: PortalSpan[] = [];
  for (const ends of groups.values()) {
    if (ends.length < 2) continue;
    const a = ends[0];
    const b = ends[1];
    const low = a.x <= b.x ? a : b;
    const high = a.x <= b.x ? b : a;
    // 入口判定：唯一“地面/天花板”端是入口；两端同类时取 x 较小者
    const aMain = isGroundPortal(a) || isCeilingPortal(a);
    const bMain = isGroundPortal(b) || isCeilingPortal(b);
    const entryIsLow = aMain === bMain ? true : (aMain ? a.x < b.x : b.x < a.x);
    const entry = entryIsLow ? low : high;
    const exit = entryIsLow ? high : low;
    spans.push({
      entry: entry.x,
      exit: exit.x,
      skips: entry.x < exit.x,
      flip: isCeilingPortal(entry) !== isCeilingPortal(exit),
    });
  }
  return spans;
}

interface RouteState { skipped: boolean; flipped: boolean }

function routeAt(def: LevelDef, x: number): RouteState {
  const spans = portalSpans(def);
  const skipped = spans.some(s => s.skips && x > s.entry && x < s.exit);
  let flipped = false;
  if (!skipped) {
    for (const o of def.obstacles) {
      if (o.kind !== 'GRAVITY_FLIP' || o.x >= x) continue;
      if (spans.some(s => s.skips && o.x > s.entry && o.x < s.exit)) continue;
      flipped = !flipped;
    }
    for (const s of spans) {
      if (!s.flip) continue;
      if (x > Math.max(s.entry, s.exit)) flipped = !flipped;
    }
  }
  return { skipped, flipped };
}

/* ------------------------------- 支撑面与跳跃包络 ------------------------------- */

interface Support {
  /** 站立时碰撞盒底部；移动浮台取基准位 */
  bottom: number;
  /** 移动浮台的摆幅（可达底部区间） */
  lo: number;
  hi: number;
  label: string;
  mechanism: boolean;
}

function supportsAt(def: LevelDef, gem: Box, flipped: boolean): Support[] {
  const list: Support[] = [];
  if (flipped) list.push({ bottom: CEIL_BOTTOM, lo: CEIL_BOTTOM, hi: CEIL_BOTTOM, label: '天花板起跳', mechanism: false });
  else list.push({ bottom: GROUND_BOTTOM, lo: GROUND_BOTTOM, hi: GROUND_BOTTOM, label: '地面起跳', mechanism: false });
  const cx = gem.x + gem.w / 2;
  for (const o of def.obstacles) {
    if (o.kind !== 'PLATFORM' && o.kind !== 'MOVING_PLATFORM') continue;
    const ob = boxOf(o);
    if (cx < ob.x || cx > ob.x + ob.w) continue;
    if (ob.y < gem.y + 4) continue; // 平台必须在拾取物下方
    if (o.kind === 'PLATFORM') {
      list.push({ bottom: ob.y, lo: ob.y, hi: ob.y, label: '静态平台', mechanism: false });
    } else {
      const range = Math.abs(o.meta?.range ?? CFG.MOVING_PLATFORM_RANGE_MIN);
      const lo = Math.max(CEIL_BOTTOM, ob.y - range);
      const hi = Math.min(GROUND_BOTTOM, ob.y + range);
      list.push({ bottom: ob.y, lo, hi, label: '移动浮台', mechanism: true });
    }
  }
  return list;
}

/** 站立跑动即可拾取：站立收缩盒与拾取收缩盒垂直重叠 */
function standingOverlaps(gem: Box, shrink: number, bottom: number): boolean {
  const pyLo = bottom - P + shrink;
  const pyHi = bottom - shrink;
  const gyLo = gem.y + shrink;
  const gyHi = gem.y + gem.h - shrink;
  return gyHi > pyLo && gyLo < pyHi;
}

/** 跳跃包络可达的底部区间（移动浮台取整个摆动范围） */
function reachableBottoms(s: Support): Array<[number, number]> {
  if (s.hi > s.lo) {
    // 竖直移动浮台：任一相位都能站上去 → 底部可达 [lo-H, hi]
    return [[s.lo - MAX_JUMP_RISE, s.hi]];
  }
  return [[s.bottom - MAX_JUMP_RISE, s.bottom]];
}

/** 跳跃 h(t) 的时间区间（t∈[t1,t2] 内高度落在 [hLo,hHi]） */
function hopTimeRanges(hLo: number, hHi: number): Array<[number, number]> {
  const lo = Math.max(0, hLo);
  const hi = Math.min(MAX_JUMP_RISE, hHi);
  if (hi <= lo) return [];
  const tAsc = (h: number) => (JUMP_V0 - Math.sqrt(Math.max(0, JUMP_V0 * JUMP_V0 - 2 * CFG.GRAVITY * h))) / CFG.GRAVITY;
  const tDesc = (h: number) => (JUMP_V0 + Math.sqrt(Math.max(0, JUMP_V0 * JUMP_V0 - 2 * CFG.GRAVITY * h))) / CFG.GRAVITY;
  if (hi >= MAX_JUMP_RISE - 1e-6) return [[tAsc(lo), tDesc(lo)]];
  const out: Array<[number, number]> = [[tAsc(lo), tAsc(hi)], [tDesc(hi), tDesc(lo)]];
  return out.filter(([a, b]) => b > a + 1e-6);
}

interface TakeoffWindow { width: number; lo: number; hi: number }

/**
 * 计算“起跳位置窗口”：玩家在 x0 处起跳，能在此后飞行中吃到该拾取物的全部 x0 区间。
 * dir=-1 地面起跳（向上），dir=+1 天花板起跳（向下）。
 */
function takeoffWindow(
  gem: Box, shrink: number, support: Support, dir: -1 | 1, speed: number,
  walls: Box[], pits: Box[],
): TakeoffWindow | null {
  if (support.hi > support.lo) {
    // 移动浮台：只做区间判定，具体相位由玩家等待
    return { width: MIN_TAKEOFF_WINDOW, lo: 0, hi: 0 };
  }
  const bottom = support.bottom;
  const bLo = gem.y + 2 * shrink;
  const bHi = gem.y + gem.h + P - 2 * shrink;
  const hLo = dir === -1 ? bottom - bHi : bLo - bottom;
  const hHi = dir === -1 ? bottom - bLo : bHi - bottom;
  const ranges = hopTimeRanges(hLo, hHi);
  if (ranges.length === 0) return null;

  const pxLo = gem.x - P + 2 * shrink;
  const pxHi = gem.x + gem.w - 2 * shrink;
  const intervals: Array<[number, number]> = [];
  for (const [t1, t2] of ranges) {
    intervals.push([pxLo - speed * t2, pxHi - speed * t1]);
  }

  // 逐点验证：起跳时不能站在柱子里 / 坑上，整段飞行不能撞实体柱
  let best = 0;
  let bestLo = 0;
  let bestHi = 0;
  for (const [lo, hi] of intervals) {
    let runLo = 0;
    let runLen = 0;
    for (let x0 = lo; x0 <= hi; x0 += STEP) {
      if (flightClear(x0, speed, bottom, dir, walls, pits)) {
        if (runLen === 0) runLo = x0;
        runLen += STEP;
        if (runLen > best) { best = runLen; bestLo = runLo; bestHi = x0 + STEP; }
      } else {
        runLen = 0;
      }
    }
  }
  if (best === 0) return null;
  return { width: best, lo: bestLo, hi: bestHi };
}

/** 模拟一次跳跃飞行，检查是否始终不碰实体柱、起跳点不在坑上 */
function flightClear(x0: number, speed: number, bottom: number, dir: -1 | 1, walls: Box[], pits: Box[]): boolean {
  const startBox: Box = { x: x0 + 3, y: bottom - P + 3, w: P - 6, h: P - 6 };
  if (pits.some(p => overlap(startBox, shrunk(p, 3)))) return false;
  for (let t = 0; t <= JUMP_AIR_TIME + 1e-6; t += SIM_DT) {
    const px = x0 + speed * t;
    const h = Math.max(0, JUMP_V0 * t - 0.5 * CFG.GRAVITY * t * t);
    const b = bottom + dir * h;
    const pb: Box = { x: px + 3, y: b - P + 3, w: P - 6, h: P - 6 };
    for (const w of walls) {
      if (overlap(pb, shrunk(w, 3))) return false;
    }
  }
  return true;
}

/* -------------------------------- 单关扫描 -------------------------------- */

function pickIssue(gem: Box, shrink: number, def: LevelDef, route: RouteState): ReachIssue | null {
  const kind = gemKind(gem, def);
  const base = { levelId: def.id, kind, x: gem.x, y: gem.y, w: gem.w, h: gem.h };

  const spans = portalSpans(def);
  const blockingWall = def.obstacles.find(o => o.kind === 'WALL' && overlap(shrunk(gem, shrink), boxOf(o)));
  if (blockingWall) {
    return { ...base, type: 'BLOCKED', detail: `拾取盒嵌在实体柱内（柱 x=${blockingWall.x}）` };
  }
  if (route.skipped) {
    const s = spans.find(sp => sp.skips && gem.x > sp.entry && gem.x < sp.exit)!;
    return { ...base, type: 'BLOCKED', detail: `落在传送门跳过区间 (${s.entry}, ${s.exit})，玩家被传送越过了该位置` };
  }
  const pit = def.obstacles.find(o => o.kind === 'PIT' && gem.x + gem.w > o.x && gem.x < o.x + (o.w ?? 0));
  if (pit) {
    return { ...base, type: 'BLOCKED', detail: `位于断桥坑上方（坑 x=${pit.x}），坑内无落脚点` };
  }

  // 贴边 / 重叠：尖刺、相位墙（同色可穿，但必须精确同色）、脉冲激光
  const lethal = def.obstacles.filter(o =>
    o.kind === 'RED_SPIKE' || o.kind === 'BLUE_SPIKE' || o.kind === 'POLARITY_WALL');
  for (const o of lethal) {
    const g = gap(shrunk(gem, shrink), shrunk(boxOf(o), 3));
    if (g === 0) {
      return { ...base, type: 'TIGHT', detail: `拾取盒与${o.kind === 'POLARITY_WALL' ? '相位墙' : '尖刺'}重叠（x=${o.x}），必须同色穿过才可能拾取，容错为 0` };
    }
    if (g < MIN_EDGE_CLEARANCE) {
      return { ...base, type: 'TIGHT', detail: `距${o.kind === 'POLARITY_WALL' ? '相位墙' : '尖刺'}（x=${o.x}）净空仅 ${g.toFixed(1)}px < ${MIN_EDGE_CLEARANCE}px` };
    }
  }
  const laser = def.obstacles.find(o => o.kind === 'PULSE_LASER' && overlap(shrunk(boxOf(o), 0), shrunk(gem, shrink)));
  if (laser) {
    return { ...base, type: 'MECH', detail: `落在脉冲激光（x=${laser.x}）体积内，只能趁熄灭窗口拾取` };
  }

  const walls = def.obstacles.filter(o => o.kind === 'WALL').map(boxOf);
  const pits = def.obstacles.filter(o => o.kind === 'PIT').map(boxOf);
  const dir: -1 | 1 = route.flipped ? 1 : -1;
  const supports = supportsAt(def, gem, route.flipped);

  let best: TakeoffWindow | null = null;
  let bestSupport: Support | null = null;
  for (const s of supports) {
    if (s.mechanism) {
      // 移动浮台：只要垂直区间与摆动可达区间相交即算“机制内可达”
      const bands = reachableBottoms(s);
      const bLo = gem.y + 2 * shrink;
      const bHi = gem.y + gem.h + P - 2 * shrink;
      if (bands.some(([lo, hi]) => hi > bLo && lo < bHi)) {
        return { ...base, type: 'MECH', detail: `${s.label}（x 在 ${s.lo}–${s.hi} 之间往复）：需等待浮台到达可拾取相位` };
      }
      continue;
    }
    if (standingOverlaps(gem, shrink, s.bottom)) {
      // 站立 / 贴地奔跑即可拾取：路径上无实体柱阻挡即视为可达
      const runBox: Box = { x: gem.x - P, y: s.bottom - P, w: gem.w + P * 2, h: P };
      if (!walls.some(w => overlap(runBox, w))) return null;
      continue;
    }
    const win = takeoffWindow(gem, shrink, s, dir, CFG.RUN_SPEED, walls, pits);
    if (win && (!best || win.width > best.width)) { best = win; bestSupport = s; }
  }

  if (!best) {
    const reach = supports.map(s => `${s.label}可达底部 ${s.lo.toFixed(0)}–${s.hi.toFixed(0)}`).join('，');
    return { ...base, type: 'HEIGHT', detail: `跳跃包络无法覆盖（拾取盒 y=${gem.y}–${gem.y + gem.h}；${reach}）` };
  }
  if (best.width < MIN_TAKEOFF_WINDOW) {
    return { ...base, type: 'TIGHT', detail: `${bestSupport?.label}起跳窗口仅 ${best.width}px（< ${MIN_TAKEOFF_WINDOW}px），必须擦边起跳` };
  }
  return null;
}

/** 从 def 中反查该拾取物的 kind（pickIssue 只接收 box） */
function gemKind(gem: Box, def: LevelDef): ObstacleKind {
  const found = def.obstacles.find(o =>
    PICKUP_KINDS.includes(o.kind) && o.x === gem.x && (o.y ?? 0) === gem.y);
  return found?.kind ?? 'COLLECTIBLE';
}

export function scanLevel(def: LevelDef): ReachIssue[] {
  const issues: ReachIssue[] = [];
  for (const o of def.obstacles) {
    if (!PICKUP_KINDS.includes(o.kind)) continue;
    const shrink = PICKUP_SHRINK[o.kind] ?? 4;
    const issue = pickIssue(boxOf(o), shrink, def, routeAt(def, o.x));
    if (issue) issues.push(issue);
  }
  return issues;
}

/* ---------------------------- 彩色拾取物极性可达性 ---------------------------- */

export interface ColorIssue {
  levelId: number;
  x: number;
  type: 'COLOR' | 'POLARITY';
  detail: string;
}

interface SwitchLockSpan { lo: number; hi: number; label: string }

/** 换色被禁止的 x 区间：极性锁门廊 + 诱饵吃下后的 1.2s 锁色窗口（按基础跑速折算） */
function switchLockSpans(def: LevelDef): SwitchLockSpan[] {
  const spans: SwitchLockSpan[] = [];
  for (const o of def.obstacles) {
    if (o.kind === 'POLARITY_LOCK') {
      const hi = o.x + (o.w ?? 64);
      spans.push({ lo: o.x, hi, label: `极性锁门廊 ${o.x}–${hi}` });
    } else if (o.kind === 'CORE_BAIT') {
      const lo = o.x + (o.w ?? 40);
      const hi = lo + CFG.RUN_SPEED * MECH.BAIT.switchLock;
      spans.push({ lo, hi, label: `诱饵锁色窗口 ${lo}–${Math.round(hi)}` });
    }
  }
  return spans.sort((a, b) => a.lo - b.lo);
}

/**
 * 彩色晶片（COLLECTIBLE + meta.color）的极性可达性：
 *   ① 颜色必须是合法的 RED / BLUE；
 *   ② 不能落在强制极性区里且颜色与区域相反（区内无法换色，必死）；
 *   ③ 到达前必须存在可换色窗口：从关卡起点到拾取物之间，锁色区间不能把整段完全盖住
 *      （门廊/诱饵锁色只禁止“期间”换色，允许提前换好颜色后保持通过）。
 */
export function scanColorPickups(def: LevelDef): ColorIssue[] {
  const issues: ColorIssue[] = [];
  const locks = switchLockSpans(def);
  for (const o of def.obstacles) {
    if (o.kind !== 'COLLECTIBLE') continue;
    const color = o.meta?.color;
    if (color === undefined) continue;
    if (color !== 'RED' && color !== 'BLUE') {
      issues.push({
        levelId: def.id, x: o.x, type: 'COLOR',
        detail: `颜色 ${JSON.stringify(color)} 非法（只允许 RED / BLUE）`,
      });
      continue;
    }
    const zone = def.obstacles.find(z =>
      z.kind === 'POLARITY_ZONE' &&
      o.x < z.x + (z.w ?? 64) && o.x + (o.w ?? 24) > z.x);
    if (zone && zone.meta?.forcedPolarity !== color) {
      issues.push({
        levelId: def.id, x: o.x, type: 'POLARITY',
        detail: `位于强制${zone.meta?.forcedPolarity === 'BLUE' ? '蓝' : '红'}色区（x=${zone.x}）内却要求${color === 'RED' ? '红' : '蓝'}色，区内无法换色`,
      });
      continue;
    }

    // 起点 → 拾取物之间是否存在可换色的空档
    let cursor = 0;
    let hasWindow = false;
    for (const s of locks) {
      if (s.lo >= o.x) break;
      if (s.lo > cursor) { hasWindow = true; break; }
      cursor = Math.max(cursor, s.hi);
    }
    if (!hasWindow && cursor < o.x) hasWindow = true;
    if (!hasWindow) {
      issues.push({
        levelId: def.id, x: o.x, type: 'POLARITY',
        detail: `到达前没有可换色窗口：${locks.map(s => s.label).join('、')} 覆盖了起点到 x=${o.x} 的整段`,
      });
      continue;
    }

    // 颜色决策窗口：拾取物前 96px（≈0.3s）内不得有异色致命物，
    // 否则玩家被迫先以异色通过，只剩不到 0.3s 换色，★2 会退化成帧级操作。
    const approach = 96;
    const opp = color === 'RED' ? 'BLUE' : 'RED';
    const hazard = def.obstacles.find(h => {
      const p = h.kind === 'RED_SPIKE' ? 'RED'
        : h.kind === 'BLUE_SPIKE' ? 'BLUE'
          : h.kind === 'POLARITY_WALL' ? (h.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED')
            : null;
      if (p !== opp) return false;
      const right = h.x + (h.w ?? (h.kind === 'POLARITY_WALL' ? 24 : 32));
      return h.x < o.x && right > o.x - approach;
    });
    if (hazard) {
      issues.push({
        levelId: def.id, x: o.x, type: 'POLARITY',
        detail: `前 ${approach}px 内有异色${hazard.kind === 'POLARITY_WALL' ? '相位墙' : '尖刺'}（x=${hazard.x}），` +
          `被迫以${opp === 'RED' ? '红' : '蓝'}色通过后只剩不到 0.3s 换色`,
      });
    }
  }
  return issues;
}

export function scanAllLevels(levels: LevelDef[]): ReachIssue[] {
  return levels.flatMap(scanLevel);
}

/* ------------------------- 有意设计（机制内可达）豁免清单 ------------------------- */

export interface ReachExemption { key: string; reason: string }

// 仅登记“必须借助关卡机制 + 有确定可达相位”的位置；新增前必须有数值依据。
export const REACH_EXEMPTIONS: ReachExemption[] = [
  {
    key: '32:730:COLLECTIBLE',
    reason: '垂直移动浮台（x=650..830，y=320 ± 80，周期 2.8s）：' +
      '浮台顶面在 278–322 区间时，站立收缩盒 [顶-35, 顶-5] 与晶片收缩盒 [273,287] 相交；' +
      '玩家随台面经过该相位即可拾取（窗口约 0.25s/次，每周期两次）',
  },
  {
    key: '33:4550:COLLECTIBLE',
    reason: '水平脉冲激光（x=4550..4750，周期 2.8s，亮 0.5s / 灭约 1.5s）：' +
      '贴地奔跑时站立盒 [405,435] 与晶片盒 [393,407] 重叠 2px，趁熄灭窗口直跑即拾取；' +
      '亮起时该体积致死，属于本关“看节拍通过”机制',
  },
];

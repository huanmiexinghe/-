// 编辑器工具清单 / 分类 / 顶部单行工具栏布局
//
// 纯数据 + 纯函数，EditorScene 与 selfcheck 共用：
// 分类覆盖、44px 命中区、拖动滚动范围都在这里可断言，避免场景里硬编码漂移。

import { COLORS } from '../data/config';
import { UI, PALETTE } from '../ui/theme';

export type ToolId =
  | 'RED_SPIKE' | 'BLUE_SPIKE' | 'WALL'
  | 'PORTAL_A' | 'PORTAL_B'
  | 'ZONE_RED' | 'ZONE_BLUE' | 'FLIP' | 'BOOST'
  | 'PEND_R' | 'PEND_B' | 'GEM' | 'STAR'
  | 'PLATFORM' | 'MPLAT' | 'PWALL' | 'LASER'
  | 'LOCK' | 'BAIT' | 'MIRROR' | 'RAIN'
  | 'LAUNCH' | 'SWALL' | 'CONVEY' | 'PIT'
  | 'COMBO_GATE'
  | 'FINISH' | 'ERASE';

export type ToolCategoryId = 'terrain' | 'hazard' | 'machine' | 'mechanic' | 'edit';

export interface ToolCategory {
  id: ToolCategoryId;
  label: string;
}

export interface EditorToolDef {
  id: ToolId;
  label: string;
  color: string;
  category: ToolCategoryId;
}

/** 顶部五个分类标签（顺序即渲染顺序） */
export const EDITOR_CATEGORIES: ToolCategory[] = [
  { id: 'terrain', label: '基础地形' },
  { id: 'hazard', label: '静态危险' },
  { id: 'machine', label: '动态机关' },
  { id: 'mechanic', label: '特殊机制' },
  { id: 'edit', label: '编辑工具' },
];

/** 28 个工具：每个都必须且只能属于一个分类 */
export const EDITOR_TOOLS: EditorToolDef[] = [
  // 基础地形
  { id: 'WALL', label: '灰墙', color: COLORS.GRAY, category: 'terrain' },
  { id: 'PLATFORM', label: '浮台', color: COLORS.PLATFORM, category: 'terrain' },
  { id: 'MPLAT', label: '动台', color: COLORS.MOVING_PLATFORM, category: 'terrain' },
  { id: 'BOOST', label: '加速', color: COLORS.SPEED_BOOST, category: 'terrain' },
  { id: 'FINISH', label: '终点', color: UI.color.rim, category: 'terrain' },

  // 静态危险
  { id: 'RED_SPIKE', label: '红刺', color: COLORS.SPIKE_RED, category: 'hazard' },
  { id: 'BLUE_SPIKE', label: '蓝刺', color: COLORS.SPIKE_BLUE, category: 'hazard' },
  { id: 'PWALL', label: '相墙', color: COLORS.RED, category: 'hazard' },
  { id: 'PIT', label: '断桥', color: COLORS.PIT, category: 'hazard' },

  // 动态机关
  { id: 'PEND_R', label: '红锤', color: COLORS.RED, category: 'machine' },
  { id: 'PEND_B', label: '蓝锤', color: COLORS.BLUE, category: 'machine' },
  { id: 'SWALL', label: '滑墙', color: COLORS.RED, category: 'machine' },
  { id: 'LASER', label: '激光', color: COLORS.LASER, category: 'machine' },
  { id: 'CONVEY', label: '传送', color: COLORS.PLATFORM, category: 'machine' },
  { id: 'LAUNCH', label: '弹板', color: COLORS.RED, category: 'machine' },
  { id: 'COMBO_GATE', label: '连击门', color: COLORS.GRAVITY, category: 'machine' },

  // 特殊机制（含 M01–M11 相关）
  { id: 'PORTAL_A', label: '紫门', color: COLORS.PORTAL_A, category: 'mechanic' },
  { id: 'PORTAL_B', label: '绿门', color: COLORS.PORTAL_B, category: 'mechanic' },
  { id: 'ZONE_RED', label: '红区', color: COLORS.REVERSE_ZONE, category: 'mechanic' },
  { id: 'ZONE_BLUE', label: '蓝区', color: COLORS.REVERSE_ZONE, category: 'mechanic' },
  { id: 'FLIP', label: '重力', color: COLORS.GRAVITY, category: 'mechanic' },
  { id: 'GEM', label: '晶片', color: COLORS.COLLECTIBLE, category: 'mechanic' },
  { id: 'STAR', label: '星核', color: COLORS.SPECIAL_ITEM, category: 'mechanic' },
  { id: 'LOCK', label: '极锁', color: COLORS.GRAY, category: 'mechanic' },
  { id: 'BAIT', label: '诱饵', color: COLORS.COLLECTIBLE, category: 'mechanic' },
  { id: 'MIRROR', label: '磁镜', color: COLORS.PORTAL_A, category: 'mechanic' },
  { id: 'RAIN', label: '芯雨', color: COLORS.COLLECTIBLE, category: 'mechanic' },

  // 编辑工具
  { id: 'ERASE', label: '擦除', color: PALETTE.charge, category: 'edit' },
];

/**
 * 顶部工具栏几何（逻辑画布 960×540）。
 * 小屏横屏 844×390 时画布按高度缩放 390/540≈0.722：
 * 工具格 64 → 46.2px，分类标签 62 → 44.8px，均不低于 44px。
 * toolY + toolH = 136 ≤ topH = 142，工具行不会压住画布顶部刻度区。
 */
export const EDITOR_LAYOUT = {
  pad: 6,
  tabX0: 8,
  tabY: 6,
  tabH: 62,
  tabGap: 8,
  toolX0: 12,
  toolY: 72,
  toolH: 64,
  toolW: 84,
  toolGap: 8,
  topH: 142,
} as const;

export function toolsOf(category: ToolCategoryId): EditorToolDef[] {
  return EDITOR_TOOLS.filter(t => t.category === category);
}

/** 某一分类工具行的内容总宽（最后一个格子不含间距） */
export function toolContentWidth(category: ToolCategoryId): number {
  const n = toolsOf(category).length;
  if (n === 0) return 0;
  return n * EDITOR_LAYOUT.toolW + (n - 1) * EDITOR_LAYOUT.toolGap;
}

/** 工具行可显示宽度 */
export function toolViewWidth(canvasWidth: number): number {
  return canvasWidth - EDITOR_LAYOUT.toolX0 * 2;
}

/** 某分类允许的最大滚动偏移 */
export function maxToolScroll(category: ToolCategoryId, canvasWidth = 960): number {
  return Math.max(0, toolContentWidth(category) - toolViewWidth(canvasWidth));
}

export function clampToolScroll(
  category: ToolCategoryId,
  scroll: number,
  canvasWidth = 960,
): number {
  return Math.max(0, Math.min(maxToolScroll(category, canvasWidth), scroll));
}

/** 分类标签矩形（等宽 + 等间距） */
export function tabRect(index: number, canvasWidth = 960): { x: number; y: number; w: number; h: number } {
  const n = EDITOR_CATEGORIES.length;
  const usable = canvasWidth - EDITOR_LAYOUT.tabX0 * 2 - (n - 1) * EDITOR_LAYOUT.tabGap;
  const w = usable / n;
  return {
    x: EDITOR_LAYOUT.tabX0 + index * (w + EDITOR_LAYOUT.tabGap),
    y: EDITOR_LAYOUT.tabY,
    w,
    h: EDITOR_LAYOUT.tabH,
  };
}

/** 命中哪一个分类标签，未命中返回 -1 */
export function categoryTabAt(x: number, y: number, canvasWidth = 960): number {
  for (let i = 0; i < EDITOR_CATEGORIES.length; i++) {
    const r = tabRect(i, canvasWidth);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

/**
 * 工具行命中（含 12px 拖动阈值由调用方处理）：
 * 滚动偏移参与反算；超出内容或不在工具行纵向范围返回 -1。
 */
export function toolIndexAt(
  category: ToolCategoryId,
  x: number,
  y: number,
  scroll: number,
  canvasWidth = 960,
): number {
  const L = EDITOR_LAYOUT;
  if (y < L.toolY || y > L.toolY + L.toolH) return -1;
  // 只允许点可见区域，避免命中外侧被裁掉的格子
  if (x < L.toolX0 || x > L.toolX0 + toolViewWidth(canvasWidth)) return -1;
  const local = x - L.toolX0 + scroll;
  if (local < 0 || local > toolContentWidth(category)) return -1;
  const idx = Math.floor(local / (L.toolW + L.toolGap));
  if (idx >= toolsOf(category).length) return -1;
  return idx;
}

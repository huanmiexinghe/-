// 关卡选择网格布局（纯几何，供 LevelSelectScene 与 selfcheck 共用）
//
// 顶部标题 / 返回按钮 / 彩蛋横幅是固定层，网格内容必须裁剪到其下边界以内的内容区：
// 滚动时列表只会被「裁掉」，不会画到固定栏上（不是再盖一层固定栏）。
// 底部留出操作提示的空间，最后一行滚到底时刚好停在内容区底边。

import { GAME_CONFIG } from '../data/config';
import type { UIRect } from './theme';

export const LEVEL_GRID_COLS = 5;
export const LEVEL_CELL_H = 90;
export const LEVEL_GAP_X = 28;
export const LEVEL_GAP_Y = 20;
export const LEVEL_GRID_TOP = 112;
export const LEVEL_GRID_LEFT = 40;
export const LEVEL_CELL_W = (
  GAME_CONFIG.CANVAS_WIDTH - LEVEL_GRID_LEFT * 2 - (LEVEL_GRID_COLS - 1) * LEVEL_GAP_X
) / LEVEL_GRID_COLS;

/** 内容区上边界 = 彩蛋横幅底边（110）之后，网格从 112 开始 */
export const LEVEL_CONTENT_TOP = LEVEL_GRID_TOP;
/** 内容区下边界：底部操作提示（H-18）之上留 24px */
export const LEVEL_CONTENT_BOTTOM = GAME_CONFIG.CANVAS_HEIGHT - 42;

/** 网格内容本身的像素高度（从 y=0 起算，scrollY=0 时首行顶部为 LEVEL_GRID_TOP） */
export function levelGridContentHeight(levelCount: number): number {
  const rows = Math.ceil(levelCount / LEVEL_GRID_COLS);
  return LEVEL_GRID_TOP + rows * (LEVEL_CELL_H + LEVEL_GAP_Y) - LEVEL_GAP_Y;
}

/** 最大滚动量：滚到底时最后一行底边正好等于内容区下边界 */
export function levelMaxScroll(levelCount: number): number {
  return Math.max(0, levelGridContentHeight(levelCount) - LEVEL_CONTENT_BOTTOM);
}

/** 列表绘制/命中的裁剪矩形：固定标题栏之下、底部提示之上 */
export function levelContentRect(): UIRect {
  return {
    x: 0,
    y: LEVEL_CONTENT_TOP,
    w: GAME_CONFIG.CANVAS_WIDTH,
    h: LEVEL_CONTENT_BOTTOM - LEVEL_CONTENT_TOP,
  };
}

/** 第 index 个关卡格子的矩形（含滚动偏移） */
export function levelCellRect(index: number, scrollY: number): UIRect {
  const col = index % LEVEL_GRID_COLS;
  const row = Math.floor(index / LEVEL_GRID_COLS);
  return {
    x: LEVEL_GRID_LEFT + col * (LEVEL_CELL_W + LEVEL_GAP_X),
    y: LEVEL_GRID_TOP + row * (LEVEL_CELL_H + LEVEL_GAP_Y) - scrollY,
    w: LEVEL_CELL_W,
    h: LEVEL_CELL_H,
  };
}

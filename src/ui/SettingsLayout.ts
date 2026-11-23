// 设置弹层布局（纯几何，供 MenuScene 与 selfcheck 共用）
//
// 尺寸依据：逻辑画布 960×540，手机横屏按高度等比缩放。
// 最差基准取 844×390 横屏（画布缩放 390/540 ≈ 0.722），
// 每行 64 逻辑像素 → 64 × 390/540 ≈ 46.2 CSS px，满足 ≥44 CSS px 的最小命中要求。
// 与编辑器工具栏（EDITOR_LAYOUT）使用同一换算口径，避免两套标准。

import type { UIRect } from './theme';

/** 小屏横屏验证基准：画布按高度缩放 390/540 */
export const LANDSCAPE_SCALE_BASE = 390 / 540;

/** 设置弹层行高（逻辑像素），换算后 ≥44 CSS px */
export const SETTINGS_ROW_H = 64;

/** 分组顺序即视觉顺序，避免设置项堆在一列 */
export const SETTINGS_GROUPS = [
  { id: 'audio', title: '音频', labelY: 88, rows: ['mute', 'volume'] },
  { id: 'display', title: '显示', labelY: 236, rows: ['shake', 'speedFx'] },
  { id: 'account', title: '账号与信息', labelY: 382, rows: ['privacy'] },
  { id: 'danger', title: '危险操作', labelY: 462, rows: ['reset'] },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];

export interface SettingsLayout {
  panel: UIRect;
  title: { x: number; y: number };
  subtitle: { x: number; y: number };
  dividerY: number;
  /** 主行（整行可点） */
  rows: {
    mute: UIRect;
    volume: UIRect;
    shake: UIRect;
    /** 速度感（速度线 + 前倾 + 加速震屏） */
    speedFx: UIRect;
    privacy: UIRect;
    reset: UIRect;
  };
  /** 音量行内的减/加按钮与滑槽 */
  volDown: UIRect;
  volUp: UIRect;
  volBar: UIRect;
  close: UIRect;
}

/** 设置弹层几何：面板 620×530，右上角独立关闭按钮，四组自上而下排列 */
export function settingsLayout(): SettingsLayout {
  const panel: UIRect = { x: 170, y: 8, w: 620, h: 530 };
  const rowX = panel.x + 24;      // 194
  const rowW = panel.w - 48;      // 572

  return {
    panel,
    title: { x: 480, y: 44 },
    subtitle: { x: 480, y: 64 },
    dividerY: 76,
    rows: {
      mute: { x: rowX, y: 98, w: rowW, h: SETTINGS_ROW_H },
      volume: { x: rowX, y: 162, w: rowW, h: SETTINGS_ROW_H },
      shake: { x: rowX, y: 244, w: rowW, h: SETTINGS_ROW_H },
      speedFx: { x: rowX, y: 308, w: rowW, h: SETTINGS_ROW_H },
      privacy: { x: rowX, y: 390, w: rowW, h: SETTINGS_ROW_H },
      reset: { x: rowX, y: 470, w: rowW, h: SETTINGS_ROW_H },
    },
    volDown: { x: rowX + 2, y: 162, w: SETTINGS_ROW_H, h: SETTINGS_ROW_H },
    volUp: { x: rowX + rowW - 2 - SETTINGS_ROW_H, y: 162, w: SETTINGS_ROW_H, h: SETTINGS_ROW_H },
    volBar: { x: rowX + 100, y: 188, w: rowW - 200, h: 24 },
    close: { x: panel.x + panel.w - 14 - SETTINGS_ROW_H, y: 22, w: SETTINGS_ROW_H, h: SETTINGS_ROW_H },
  };
}

export interface ResetConfirmLayout {
  panel: UIRect;
  title: { x: number; y: number };
  desc: { x: number; y: number };
  cancel: UIRect;
  confirm: UIRect;
}

/** 重置存档二次确认（危险操作，默认落在「取消」上） */
export function resetConfirmLayout(): ResetConfirmLayout {
  const panel: UIRect = { x: 200, y: 150, w: 560, h: 250 };
  return {
    panel,
    title: { x: 480, y: 200 },
    desc: { x: 480, y: 236 },
    cancel: { x: 260, y: 286, w: 200, h: SETTINGS_ROW_H },
    confirm: { x: 500, y: 286, w: 200, h: SETTINGS_ROW_H },
  };
}

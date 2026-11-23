// UI 设计令牌 —— 卡通主题
//
// 视觉语言：明亮的糖果色 + 深靛描边 + 硬投影（无模糊），整体像贴纸/绘本。
// 所有面板、按钮、卡片一律「厚描边圆角矩形 + 底部硬投影」，不使用霓虹发光与暗色渐变。
// 文字默认走深靛色（UI.color.text），需要压在深色蒙层上时请显式改用白色。
//
// 说明：token 结构保留（沿用 T1 收敛后的引用方式），数值已回到 T0 之前的卡通配色。

/** 调色板：保留 T0 引入的语义槽位，值映射回原卡通配色 */
export const PALETTE = {
  /** 最暗层：坑、遮罩 */
  board950: '#0a0a0f',
  /** 背景基准 */
  board900: '#12121c',
  /** 结构块 */
  board800: '#2a2a3a',
  /** 结构亮边 / 凹槽 */
  board700: '#3a3a4a',
  /** 次级文字、网格 */
  board500: '#888899',
  /** 主文字、刻线 */
  dust200: '#c9c9d8',
  /** 高光、白字 */
  dust050: '#ffffff',
  /** 红极 */
  red: '#ff2d5e',
  /** 蓝极 */
  blue: '#00d4ff',
  /** 蓄能 / 金色 */
  charge: '#ffd700',
} as const;

/** 描边分级（沿用 T1 的档位；结构档回到原来的 3px 厚描边） */
export const STROKE = {
  /** 角色 */
  hero: 3,
  /** 带电体轮廓 */
  charged: 2,
  /** 结构轮廓 */
  structure: 3,
  /** 刻线 / 纹样 */
  detail: 1,
  /** 游戏内实体统一白描边（角色/尖刺/平台/石柱/门/摆锤/终点） */
  sticker: 3,
} as const;

export const UI = {
  font: {
    ui: '"Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'Consolas, "Segoe UI", monospace',
  },
  size: {
    hero: 56, title: 32, h2: 21, body: 15, small: 13, tiny: 11,
  },
  /** 卡通风格整体更圆润 */
  radius: { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },

  /** 描边色（深靛）与投影 */
  ink: '#2b2350',
  inkSoft: 'rgba(43,35,80,0.32)',
  inkFaint: 'rgba(43,35,80,0.14)',
  shadow: 'rgba(43,35,80,0.22)',
  /** 亮面（卡片、贴纸底色） */
  paper: '#ffffff',
  paperWarm: '#fff6e2',

  color: {
    /** 主强调色：卡通红（极性红系） */
    accent: '#ff4d6d',
    accentSoft: 'rgba(255,77,109,0.16)',
    /** 极性蓝 */
    accent2: '#35b6ff',

    text: '#2b2350',
    sub: '#6f6796',
    dim: '#a49cc4',

    panel: 'rgba(255,255,255,0.94)',
    panelSoft: 'rgba(255,255,255,0.74)',
    panelEdge: 'rgba(43,35,80,0.18)',
    edgeStrong: 'rgba(43,35,80,0.40)',
    field: '#ffffff',
    overlay: 'rgba(38,28,72,0.55)',
    /** 模态遮罩：DOM 弹层与画布内对话框共用 */
    scrim: 'rgba(38,28,72,0.55)',
    scrimStrong: 'rgba(38,28,72,0.88)',

    /** 语义色 */
    gold: '#ffb703',
    success: '#3fc76a',
    danger: '#ff6b6b',
    /** 蓄能琥珀 */
    charge: '#ffb703',

    /** 浅色表面上的深色语义字：同色相压暗，保证在 paper 上 ≥4.5:1 */
    dangerInk: '#8E2F22',
    warnInk: '#8A5B00',
    successInk: '#2F6B4F',

    /** 卡通辅助色（卡片可选配色） */
    mint: '#3fd0c9',
    grape: '#a97cff',
    lemon: '#ffcf4d',
    sky: '#35b6ff',

    /** 带电体轮廓（亮边）/ 结构暗边 */
    rim: '#ffffff',
    structureEdge: '#2b2350',
    /** 极性刻印色 */
    mark: '#ffffff',
  },
} as const;

export type UIButtonVariant = 'primary' | 'ghost' | 'danger';
export type UIButtonState = 'normal' | 'hover' | 'active' | 'disabled';
export interface UIRect { x: number; y: number; w: number; h: number; }

export function inRect(r: UIRect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 卡通天空主色（菜单与游戏内共用；按参考图重定：上深下浅的干净浅蓝） */
export const TOON_SKY = {
  top: '#7fcdf0',
  mid: '#a9dff6',
  low: '#cfeffc',
  hillFar: '#8fd98a',
  hillNear: '#5fc46a',
  /** 游戏内地面草带：参考图的亮草绿 */
  ground: '#8cc63f',
  /** 地面顶边与草簇的深一档绿 */
  groundEdge: '#74b32f',
  /** 天花板参考线（参考图里那条细蓝线） */
  ceilingLine: '#6bb9de',
  /** 太阳 */
  sun: '#ffce45',
  sunRay: '#ffc02e',
} as const;

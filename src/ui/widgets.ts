// 共享 UI 组件库 —— 卡通主题
//
// 约定：所有面板/按钮/卡片一律「厚描边圆角矩形 + 底部硬投影」，
// 文字用 drawStickerText 做贴纸描边。不使用霓虹发光、模糊阴影与暗色渐变。
// 场景请优先复用这里的原语，避免各自硬编码样式导致风格漂移。

import { GAME_CONFIG } from '../data/config';
import { withAlpha } from '../utils/Color';
import { Easing } from '../utils/Easing';
import { UI, UIButtonVariant, UIRect, TOON_SKY, PALETTE, STROKE } from './theme';

type Ctx = CanvasRenderingContext2D;

// ---------------------------------------------------------------- 基础原语

/** 卡通圆角矩形：可选底部硬投影 + 深色厚描边 */
export function toonShape(
  ctx: Ctx,
  r: UIRect,
  opts: {
    fill?: string;
    stroke?: string;
    lineWidth?: number;
    radius?: number;
    /** > 0 时在下方绘制同形硬投影，数值为偏移量 */
    shadow?: number;
    shadowColor?: string;
  } = {},
) {
  const radius = opts.radius ?? UI.radius.md;
  const lw = opts.lineWidth ?? 3;
  const shadow = opts.shadow ?? 0;

  if (shadow > 0) {
    ctx.beginPath();
    ctx.roundRect(r.x, r.y + shadow, r.w, r.h, radius);
    ctx.fillStyle = opts.shadowColor ?? UI.shadow;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  if (opts.fill) {
    ctx.fillStyle = opts.fill;
    ctx.fill();
  }
  if (lw > 0) {
    ctx.strokeStyle = opts.stroke ?? UI.ink;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** 贴纸文字：先描白边再填色，卡通感的关键 */
export function drawStickerText(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  opts: {
    font: string;
    fill?: string;
    stroke?: string;
    lineWidth?: number;
    align?: CanvasTextAlign;
    baseline?: CanvasTextBaseline;
  } = { font: `bold 16px ${UI.font.ui}` },
) {
  const prevAlign = ctx.textAlign;
  const prevBaseline = ctx.textBaseline;
  ctx.textAlign = opts.align ?? prevAlign;
  ctx.textBaseline = opts.baseline ?? prevBaseline;
  ctx.font = opts.font;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if (opts.stroke) {
    ctx.lineWidth = opts.lineWidth ?? 6;
    ctx.strokeStyle = opts.stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = opts.fill ?? UI.color.text;
  ctx.fillText(text, x, y);
  ctx.textAlign = prevAlign;
  ctx.textBaseline = prevBaseline;
}

// ---------------------------------------------------------------- 背景

function drawCloud(ctx: Ctx, x: number, y: number, s: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(s, s);
  // 参考图：纯白、扁平、底边平直的朵状云，不带蓝灰阴影
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-26, 4, 15, 0, Math.PI * 2);
  ctx.arc(-2, -6, 22, 0, Math.PI * 2);
  ctx.arc(24, 2, 17, 0, Math.PI * 2);
  ctx.roundRect(-40, 4, 80, 16, 8);
  ctx.fill();
  ctx.restore();
}

/**
 * 卡通天空背景：糖果色渐变 + 转动的太阳 + 漂移云朵 + 起伏草地。
 * 与 time 绑定、无内部状态，逐帧可复现。
 */
export function drawToonSky(
  ctx: Ctx,
  time: number,
  opts: { hills?: boolean; hillsBottom?: number; groundY?: number; ceilingY?: number } = {},
) {
  const W = GAME_CONFIG.CANVAS_WIDTH;
  const H = GAME_CONFIG.CANVAS_HEIGHT;
  const hillsBottom = opts.hillsBottom ?? H;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, TOON_SKY.top);
  g.addColorStop(0.52, TOON_SKY.mid);
  g.addColorStop(1, TOON_SKY.low);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 天花板刻线：参考图里是一条可见的蓝色细线，画在渐变之后、太阳/云朵之前
  if (opts.ceilingY !== undefined) {
    ctx.strokeStyle = TOON_SKY.ceilingLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, opts.ceilingY);
    ctx.lineTo(W, opts.ceilingY);
    ctx.stroke();
  }

  // 太阳：实心亮黄圆 + 一圈短光芒（参考图没有描边，靠色块本身）
  const sun = { x: W - 150, y: 84, r: 46 };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = TOON_SKY.sunRay;
  ctx.lineWidth = 5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + time * 0.12;
    const r1 = sun.r + 10;
    const r2 = sun.r + 22;
    ctx.beginPath();
    ctx.moveTo(sun.x + Math.cos(a) * r1, sun.y + Math.sin(a) * r1);
    ctx.lineTo(sun.x + Math.cos(a) * r2, sun.y + Math.sin(a) * r2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(sun.x, sun.y, sun.r, 0, Math.PI * 2);
  ctx.fillStyle = TOON_SKY.sun;
  ctx.fill();
  ctx.restore();

  // 压着太阳的一朵云（参考图固定构图，不随漂移云走）
  ctx.save();
  ctx.translate(sun.x - 54, sun.y + 12);
  ctx.scale(0.62, 0.62);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-24, 4, 16, 0, Math.PI * 2);
  ctx.arc(2, -8, 24, 0, Math.PI * 2);
  ctx.arc(30, 4, 17, 0, Math.PI * 2);
  ctx.roundRect(-40, 4, 82, 16, 8);
  ctx.fill();
  ctx.restore();

  // 云
  const clouds = [
    { y: 78, s: 1.0, speed: 9, phase: 0.00, a: 1 },
    { y: 148, s: 0.74, speed: 13, phase: 0.38, a: 0.95 },
    { y: 54, s: 0.58, speed: 6, phase: 0.72, a: 0.85 },
    { y: 196, s: 0.5, speed: 16, phase: 0.16, a: 0.7 },
  ];
  const span = W + 340;
  for (const c of clouds) {
    const x = ((time * c.speed + c.phase * span) % span) - 170;
    drawCloud(ctx, x, c.y, c.s, c.a);
  }

  if (opts.hills !== false) {
    // 远山
    ctx.fillStyle = TOON_SKY.hillFar;
    ctx.beginPath();
    ctx.moveTo(-60, hillsBottom);
    for (let x = -60; x <= W + 60; x += 16) {
      const y = hillsBottom - 54
        - Math.sin(x * 0.0055 + 0.7) * 26
        - Math.sin(x * 0.014 + time * 0.15) * 10;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 60, hillsBottom);
    ctx.closePath();
    ctx.fill();

    // 近山
    ctx.fillStyle = TOON_SKY.hillNear;
    ctx.beginPath();
    ctx.moveTo(-60, hillsBottom);
    for (let x = -60; x <= W + 60; x += 16) {
      const y = hillsBottom - 26
        - Math.sin(x * 0.008 + 2.2) * 20
        - Math.sin(x * 0.02 + time * 0.2) * 6;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 60, hillsBottom);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 极性刻印：真实磁铁两端刻着 N / S，这里用 + / − 对应红 / 蓝。
 * 这是颜色之外的第二条通道——色盲玩家、灰度截图、小尺寸下都能读出极性。
 * 深色底衬 + 铁屑亮边，保证在红底和蓝底上都能看清。
 */
export function drawPolarityMark(
  ctx: Ctx,
  x: number,
  y: number,
  size: number,
  polarity: 'RED' | 'BLUE',
  alpha = 0.95,
) {
  const h = size / 2;
  const bar = (lw: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - h, y);
    ctx.lineTo(x + h, y);
    if (polarity === 'RED') {
      ctx.moveTo(x, y - h);
      ctx.lineTo(x, y + h);
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.globalAlpha = alpha;
  bar(Math.max(2.5, size * 0.28), 'rgba(18,21,26,0.55)');
  bar(Math.max(1.2, size * 0.13), PALETTE.dust050);
  ctx.restore();
}

/** 菜单/大厅背景 */
export function drawMenuBackground(ctx: Ctx, time: number) {
  drawToonSky(ctx, time, { hillsBottom: GAME_CONFIG.CANVAS_HEIGHT + 10 });
}

/** 进场动画：淡入 + 轻微上浮 */
export function enterAnim(t: number, dur = 0.3): { alpha: number; scale: number } {
  const k = Math.min(1, t / dur);
  return { alpha: Easing.easeOutQuad(k), scale: 0.99 + Easing.easeOutQuad(k) * 0.01 };
}

// ---------------------------------------------------------------- 组件

export function drawPanel(ctx: Ctx, r: UIRect, opts: { soft?: boolean } = {}) {
  toonShape(ctx, r, {
    fill: opts.soft ? UI.color.panelSoft : UI.color.panel,
    stroke: UI.inkSoft,
    lineWidth: STROKE.structure,
    radius: UI.radius.lg,
    shadow: 6,
  });
}

/** 卡通卡片：白底 + 深靛描边 + 彩色图标槽 */
export function drawToonCard(
  ctx: Ctx,
  r: UIRect,
  opts: {
    accent?: string;
    selected?: boolean;
    radius?: number;
    shadow?: number;
    fill?: string;
  } = {},
) {
  const selected = opts.selected ?? false;
  const accent = opts.accent ?? UI.color.accent;
  toonShape(ctx, r, {
    fill: opts.fill ?? (selected ? withAlpha(accent, 0.16) : UI.paper),
    stroke: selected ? accent : UI.ink,
    lineWidth: selected ? STROKE.hero : STROKE.structure,
    radius: opts.radius ?? UI.radius.md,
    shadow: opts.shadow ?? (selected ? 7 : 5),
  });
}

export function drawHeader(ctx: Ctx, title: string, subtitle?: string) {
  const W = GAME_CONFIG.CANVAS_WIDTH;
  const cx = W / 2;
  drawStickerText(ctx, title, cx, 50, {
    font: `bold ${UI.size.title}px ${UI.font.ui}`,
    fill: UI.color.text,
    stroke: UI.color.rim,
    lineWidth: 7,
    align: 'center',
  });

  if (subtitle) {
    drawStickerText(ctx, subtitle, cx, 84, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`,
      fill: UI.color.sub,
      stroke: UI.color.rim,
      lineWidth: 5,
      align: 'center',
    });
  }
}

export function drawFooterHint(ctx: Ctx, text: string) {
  const W = GAME_CONFIG.CANVAS_WIDTH;
  const H = GAME_CONFIG.CANVAS_HEIGHT;
  drawStickerText(ctx, text, W / 2, H - 18, {
    font: `bold ${UI.size.small}px ${UI.font.ui}`,
    fill: UI.color.sub,
    stroke: UI.color.rim,
    lineWidth: 5,
    align: 'center',
  });
}

export const BACK_RECT: UIRect = { x: 16, y: 14, w: 104, h: 44 };

export function drawBackButton(ctx: Ctx, hover = false, label = '‹ 返回') {
  drawButton(ctx, BACK_RECT, label, { variant: 'ghost', state: hover ? 'hover' : 'normal', fontSize: UI.size.body });
}

export interface ButtonOpts {
  variant?: UIButtonVariant;
  state?: 'normal' | 'hover' | 'active' | 'disabled';
  fontSize?: number;
  align?: CanvasTextAlign;
  icon?: string;
}

export function drawButton(ctx: Ctx, r: UIRect, label: string, opts: ButtonOpts = {}) {
  const variant = opts.variant ?? 'ghost';
  const state = opts.state ?? 'normal';
  const fs = opts.fontSize ?? UI.size.body;
  const disabled = state === 'disabled';
  const engaged = state === 'hover' || state === 'active';
  const press = state === 'active' ? 3 : 0;

  let fill: string;
  let textColor: string;
  if (variant === 'primary') {
    fill = disabled ? UI.color.panelSoft : UI.color.accent;
    textColor = disabled ? UI.color.dim : UI.color.text;
  } else if (variant === 'danger') {
    fill = disabled ? UI.color.panelSoft : UI.color.danger;
    textColor = disabled ? UI.color.dim : UI.color.text;
  } else {
    fill = disabled ? UI.color.panelSoft : UI.paper;
    textColor = disabled ? UI.color.dim : UI.color.text;
  }

  // 底部硬投影
  toonShape(ctx, { x: r.x, y: r.y + 4, w: r.w, h: r.h }, {
    fill: UI.shadow, lineWidth: 0, radius: UI.radius.pill,
  });
  const body = { x: r.x, y: r.y + press, w: r.w, h: r.h - press };
  toonShape(ctx, body, {
    fill, stroke: UI.ink, lineWidth: STROKE.structure, radius: UI.radius.pill,
  });

  // hover / active：在内侧压一道刻线，不再靠换色（换色会打破调色板收敛）
  if (engaged && !disabled) {
    ctx.beginPath();
    ctx.roundRect(body.x + 3, body.y + 3, body.w - 6, body.h - 6, UI.radius.pill);
    ctx.strokeStyle = withAlpha(UI.color.rim, 0.45);
    ctx.lineWidth = STROKE.detail;
    ctx.stroke();
  }

  drawStickerText(ctx, opts.icon ? `${opts.icon} ${label}` : label,
    (opts.align ?? 'center') === 'center' ? r.x + r.w / 2 : r.x + 16,
    body.y + body.h / 2 + 1, {
      font: `bold ${fs}px ${UI.font.ui}`,
      fill: textColor,
      align: opts.align ?? 'center',
      baseline: 'middle',
    });
}

export function drawField(ctx: Ctx, r: UIRect, text: string, placeholder: string, focused = false) {
  toonShape(ctx, r, {
    fill: UI.color.field,
    stroke: focused ? UI.color.accent : UI.ink,
    lineWidth: focused ? 4 : 3,
    radius: UI.radius.md,
    shadow: 4,
  });
  const show = text ? text : placeholder;
  const disp = show.length > 34 ? '…' + show.slice(-33) : show;
  drawStickerText(ctx, disp, r.x + r.w / 2, r.y + r.h / 2 + 1, {
    font: `${UI.size.body}px ${UI.font.mono}`,
    fill: text ? UI.color.text : UI.color.dim,
    align: 'center',
    baseline: 'middle',
  });
}

export function drawFieldLabel(ctx: Ctx, label: string, x: number, y: number) {
  drawStickerText(ctx, label, x, y, {
    font: `bold ${UI.size.small}px ${UI.font.ui}`,
    fill: UI.color.sub,
    stroke: UI.color.rim,
    lineWidth: 4,
    align: 'left',
  });
}

export function drawStatusToast(ctx: Ctx, text: string, kind: 'info' | 'error' = 'info') {
  const W = GAME_CONFIG.CANVAS_WIDTH;
  const H = GAME_CONFIG.CANVAS_HEIGHT;
  ctx.font = `bold ${UI.size.body}px ${UI.font.ui}`;
  const tw = ctx.measureText(text).width;
  const w = tw + 56;
  const r: UIRect = { x: W / 2 - w / 2, y: H - 74, w, h: 40 };
  const isErr = kind === 'error';
  toonShape(ctx, r, {
    fill: isErr ? UI.color.text : UI.paper,
    stroke: isErr ? PALETTE.charge : UI.ink,
    lineWidth: STROKE.structure,
    radius: UI.radius.pill,
    shadow: 5,
  });
  drawStickerText(ctx, text, W / 2, r.y + r.h / 2 + 1, {
    font: `bold ${UI.size.body}px ${UI.font.ui}`,
    fill: isErr ? PALETTE.charge : UI.color.text,
    align: 'center',
    baseline: 'middle',
  });
}

/** 小统计胶囊：标签 + 数值，用于 HUD 与战绩条 */
export function drawStatChip(ctx: Ctx, r: UIRect, label: string, value: string, accent: string = UI.color.accent) {
  toonShape(ctx, r, { fill: UI.paper, stroke: UI.ink, lineWidth: STROKE.structure, radius: UI.radius.md, shadow: 4 });
  ctx.beginPath();
  ctx.roundRect(r.x + 5, r.y + 5, 8, r.h - 10, 4);
  ctx.fillStyle = accent;
  ctx.fill();
  drawStickerText(ctx, label, r.x + 22, r.y + 19, {
    font: `bold 11px ${UI.font.ui}`, fill: UI.color.sub, align: 'left',
  });
  drawStickerText(ctx, value, r.x + 22, r.y + r.h - 9, {
    font: `bold 17px ${UI.font.mono}`, fill: UI.color.text, align: 'left',
  });
}
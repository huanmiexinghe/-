// 成就界面 —— 卡通主题
//
// 视觉语言：卡通天空背景 + 贴纸标题 + 两列白底厚描边成就卡；
// 已解锁用金色描边 + 彩色单字图标槽，未解锁整体灰化。底部为实心返回按钮。
// 交互逻辑（点击命中 / 键盘返回）与旧版保持一致。

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { GAME_CONFIG } from '../data/config';
import { AchievementDef } from '../data/achievements';
import { withAlpha } from '../utils/Color';
import { UI } from '../ui/theme';
import {
  drawMenuBackground, drawHeader, drawButton, toonShape, drawStickerText,
} from '../ui/widgets';
import { MenuScene } from './MenuScene';

/** 图标槽配色（按卡片顺序循环取用，让卡片更有卡通活力） */
const ACH_COLORS = [
  UI.color.grape, UI.color.sky, UI.color.mint,
  UI.color.lemon, UI.color.accent, UI.color.gold,
];

export class AchievementsScene extends Scene {
  private time = 0;

  constructor(private game: Game) { super(); }

  onEnter() {
    this.time = 0;
    this.game.input.setTouchLayout('menu');
    this.game.input.onTap = (x, y) => {
      // 底部「返回主菜单」按钮
      const bx = GAME_CONFIG.CANVAS_WIDTH / 2 - 110;
      const by = GAME_CONFIG.CANVAS_HEIGHT - 60;
      if (x >= bx && x <= bx + 220 && y >= by && y <= by + 42) {
        this.game.audio.playUIClick();
        this.game.switchScene(new MenuScene(this.game));
      }
    };
  }

  onExit() {
    this.game.input.onTap = null;
  }

  update(dt: number) {
    this.time += dt;
    if (this.game.input.isKeyPressed('Escape') || this.game.input.isKeyPressed('Enter')) {
      this.game.audio.playUIClick();
      this.game.switchScene(new MenuScene(this.game));
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;

    // 卡通天空背景
    drawMenuBackground(ctx, this.time);

    const list = this.game.achievements.list();
    const unlocked = list.filter(l => l.unlocked).length;

    // 标题 + 进度副标题
    drawHeader(ctx, '成就', `已解锁 ${unlocked} / ${list.length}`);

    // 两列卡通白卡网格
    const cols = 2;
    const cardW = 430;
    const cardH = 66;
    const gapX = 20;
    const gapY = 10;
    const startX = (W - (cardW * cols + gapX)) / 2;
    const startY = 98;

    list.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * (cardW + gapX);
      const y = startY + row * (cardH + gapY);
      this.drawAchievementCard(ctx, x, y, cardW, cardH, i, item);
    });

    // 返回主菜单按钮（触屏可点，键盘 Esc/回车 同效）
    drawButton(ctx, { x: W / 2 - 110, y: H - 60, w: 220, h: 42 }, '返回主菜单', {
      variant: 'ghost',
      fontSize: UI.size.body,
      icon: '←',
    });
  }

  /** 成就卡片：白底卡通卡；已解锁金色描边 + 彩色单字图标槽，未解锁整体灰化 */
  private drawAchievementCard(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    i: number, item: { def: AchievementDef; unlocked: boolean },
  ) {
    const on = item.unlocked;
    const accent = ACH_COLORS[i % ACH_COLORS.length];

    toonShape(ctx, { x, y, w, h }, {
      fill: on ? UI.paper : UI.color.panelSoft,
      stroke: on ? UI.color.gold : UI.inkSoft,
      lineWidth: 3,
      radius: UI.radius.md,
      shadow: 5,
    });

    // 单字图标槽
    const bs = 46;
    const bx = x + 12;
    const by = y + (h - bs) / 2;
    toonShape(ctx, { x: bx, y: by, w: bs, h: bs }, {
      fill: on ? withAlpha(accent, 0.22) : UI.color.panelSoft,
      stroke: on ? accent : UI.color.dim,
      lineWidth: 3,
      radius: UI.radius.sm,
    });
    drawStickerText(ctx, item.def.icon, bx + bs / 2, by + bs / 2 + 1, {
      font: `bold 24px ${UI.font.ui}`,
      fill: on ? accent : UI.color.dim,
      stroke: UI.color.rim,
      lineWidth: 4,
      align: 'center',
      baseline: 'middle',
    });

    // 名称
    const tx = bx + bs + 14;
    drawStickerText(ctx, item.def.name, tx, y + 26, {
      font: `bold 17px ${UI.font.ui}`,
      fill: on ? UI.color.text : UI.color.dim,
      stroke: UI.color.rim,
      lineWidth: 4,
      align: 'left',
    });

    // 描述（按字符断行）
    this.wrapText(ctx, item.def.desc, tx, y + 48, w - (tx - x) - 96, 16,
      `${UI.size.small}px ${UI.font.ui}`, on ? UI.color.sub : UI.color.dim);

    // 状态
    drawStickerText(ctx, on ? '✓ 已达成' : '未解锁', x + w - 12, y + 26, {
      font: `bold 13px ${UI.font.ui}`,
      fill: on ? UI.color.success : UI.color.dim,
      stroke: UI.color.rim,
      lineWidth: 4,
      align: 'right',
    });
  }

  private wrapText(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    maxW: number, lh: number, font: string, fill: string,
  ) {
    // 简单按字符断行（中文），逐行用贴纸文字绘制
    ctx.font = font;
    let line = '';
    let curY = y;
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        drawStickerText(ctx, line, x, curY, { font, fill, stroke: UI.color.rim, lineWidth: 4, align: 'left' });
        line = ch;
        curY += lh;
      } else {
        line = test;
      }
    }
    if (line) drawStickerText(ctx, line, x, curY, { font, fill, stroke: UI.color.rim, lineWidth: 4, align: 'left' });
  }
}
// 健康游戏忠告 —— 冷启动进入主菜单之前的提示页
//
// 只在应用冷启动时展示一次：main.ts 在创建游戏后先切到本场景，
// 玩家点击或按键后进入主菜单；之后所有场景切换都不会再回到这里。
//
// 美术风格与主菜单一致：卡通天空底（drawToonSky）+ 糖果色贴纸文字，
// 不再是独立深色页，过渡到主菜单时没有明显「换了一套 UI」的感觉。

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { GAME_CONFIG } from '../data/config';
import {
  HEALTH_ADVISORY_TITLE, HEALTH_ADVISORY_LINES, HEALTH_ADVISORY_LAYOUT, HEALTH_ADVISORY_HINT,
} from '../data/healthAdvisory';
import { UI, PALETTE } from '../ui/theme';
import { withAlpha } from '../utils/Color';
import { MenuScene } from './MenuScene';
import { drawStickerText, drawToonSky } from '../ui/widgets';

export class HealthAdvisoryScene extends Scene {
  private advanced = false;
  private time = 0;

  constructor(private game: Game) {
    super();
  }

  onEnter() {
    this.advanced = false;
    this.time = 0;
    this.game.input.setTouchLayout('menu');
    this.game.input.onTap = () => this.advance();
    this.game.input.onKeyDown = () => this.advance();
  }

  onExit() {
    this.game.input.onTap = null;
    this.game.input.onKeyDown = null;
  }

  update(dt: number) {
    this.time += dt;
  }

  private advance() {
    if (this.advanced) return;
    this.advanced = true;
    this.game.audio.playUIClick();
    this.game.switchScene(new MenuScene(this.game));
  }

  render(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const cx = W / 2;
    const L = HEALTH_ADVISORY_LAYOUT;

    // 与主菜单相同的卡通天空底（无山、无地面绿带，纯天空渐变 + 太阳 + 云）
    drawToonSky(ctx, this.time, { hills: false });

    // 半透明柔光面板：让文字区域与天空拉开一层对比，不遮住云和太阳
    ctx.fillStyle = withAlpha(UI.paper, 0.78);
    const panelH = L.dividerBottom - L.titleY + 60;
    const panelW = L.columnX[1] - L.columnX[0] + 340;
    ctx.beginPath();
    ctx.roundRect(cx - panelW / 2, L.titleY - 20, panelW, panelH, UI.radius.xl);
    ctx.fill();

    // 标题：卡通红 + 厚白描边，与主菜单标题同款风格
    drawStickerText(ctx, HEALTH_ADVISORY_TITLE, cx, L.titleY, {
      font: `bold 46px ${UI.font.ui}`,
      fill: UI.color.accent,
      stroke: UI.paper,
      lineWidth: 10,
      align: 'center',
      baseline: 'middle',
    });

    // 标题下方短线
    ctx.beginPath();
    ctx.moveTo(cx - 160, L.ruleY);
    ctx.lineTo(cx + 160, L.ruleY);
    ctx.strokeStyle = withAlpha(UI.color.accent, 0.45);
    ctx.lineWidth = 3;
    ctx.stroke();

    // 两栏各 4 行：左栏前两句，右栏后两句
    for (let i = 0; i < HEALTH_ADVISORY_LINES.length; i++) {
      const col = i < 4 ? 0 : 1;
      const row = i % 4;
      drawStickerText(ctx, HEALTH_ADVISORY_LINES[i], L.columnX[col], L.firstLineY + row * L.lineGap, {
        font: `bold ${L.bodyFontPx}px ${UI.font.ui}`,
        fill: UI.color.text,
        stroke: UI.paper,
        lineWidth: 9,
        align: 'center',
        baseline: 'middle',
      });
    }

    // 两栏间竖线分隔
    ctx.beginPath();
    ctx.moveTo(L.dividerX, L.dividerTop);
    ctx.lineTo(L.dividerX, L.dividerBottom);
    ctx.strokeStyle = withAlpha(UI.color.accent, 0.25);
    ctx.lineWidth = 2;
    ctx.stroke();

    // 底部操作提示
    drawStickerText(ctx, HEALTH_ADVISORY_HINT, cx, L.hintY, {
      font: `bold 16px ${UI.font.ui}`,
      fill: UI.color.mint,
      stroke: UI.paper,
      lineWidth: 5,
      align: 'center',
      baseline: 'middle',
    });
  }
}
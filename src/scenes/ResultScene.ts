// 结算场景（普通关卡 / 无尽模式 / 自定义关卡）—— 卡通主题
//
// 视觉语言：卡通天空背景 + 中央白色卡通结果卡（厚描边 + 硬投影，radius.xl）。
// 卡内为贴纸标题、关卡名、用时/目标与最高连击（数值走等宽字体），新纪录时右上角挂金色徽章。
// 动作按钮统一走 drawButton；交互（tap 命中 / 键盘导航 / pop 弹入动画）与旧版保持一致。

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { GAME_CONFIG } from '../data/config';
import { LevelDef } from '../data/levels';
import { StarResult } from '../systems/Progress';
import { UI, UIRect } from '../ui/theme';
import {
  drawMenuBackground, toonShape, drawStickerText, drawButton, drawFooterHint,
} from '../ui/widgets';

export interface ResultAction {
  label: string;
  factory: () => Scene;
}

export interface ResultSceneOptions {
  mode: 'NORMAL' | 'ENDLESS' | 'DAILY' | 'CUSTOM' | 'SPECIAL';
  level: LevelDef;
  clearTime: number;
  combo: number;
  isNewRecord: boolean;
  distance?: number;
  bestTime?: number;
  bestDistance?: number;
  /** 特殊关结算附言（星核回收 / 彩蛋完成） */
  info?: string;
  /** 普通关星级（0–3）与判定明细 */
  stars?: number;
  starDetail?: StarResult;
  /** 每日挑战结算 */
  daily?: {
    firstCompletion: boolean;
    streak: number;
    coresAwarded: number;
    modifiers: readonly string[];
  };
  primary: ResultAction;
  secondary: ResultAction;
  tertiary?: ResultAction;
}

export class ResultScene extends Scene {
  private timeAccum = 0;
  private selection = 0;

  constructor(private game: Game, private opts: ResultSceneOptions) { super(); }

  onEnter() {
    this.timeAccum = 0;
    this.selection = 0;
    this.game.input.setTouchLayout('menu');
    this.game.input.onTap = (x, y) => this.handleTap(x, y);
  }

  onExit() {
    this.game.input.onTap = null;
  }

  private get actions(): ResultAction[] {
    const list = [this.opts.primary, this.opts.secondary];
    if (this.opts.tertiary) list.push(this.opts.tertiary);
    return list;
  }

  private handleTap(x: number, y: number) {
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const W = GAME_CONFIG.CANVAS_WIDTH;
    for (let i = 0; i < this.actions.length; i++) {
      const cy = H / 2 + 110 + i * 50;
      if (Math.abs(x - W / 2) < 200 && Math.abs(y - cy) < 30) {
        this.game.audio.playUIClick();
        this.game.switchScene(this.actions[i].factory());
        return;
      }
    }
  }

  update(dt: number) {
    this.timeAccum += dt;
    const input = this.game.input;
    if (input.isKeyPressed('ArrowUp') || input.isKeyPressed('KeyW')) {
      // 向上：反向取模，否则 ↑ 会变成和 ↓ 一样往下走
      this.selection = (this.selection + this.actions.length - 1) % this.actions.length;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('ArrowDown') || input.isKeyPressed('KeyS')) {
      this.selection = (this.selection + 1) % this.actions.length;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('Enter') || input.isKeyPressed('Space')) {
      this.game.audio.playUIClick();
      this.game.switchScene(this.actions[this.selection].factory());
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const cx = W / 2;

    // 卡通天空背景（不再使用深色蒙层）
    drawMenuBackground(ctx, this.timeAccum);

    // pop 弹入动画：整卡以自身中心缩放
    const t = Math.min(this.timeAccum * 2, 1);
    const pop = 1 + (1 - t) * 0.3;

    const card: UIRect = { x: cx - 290, y: 78, w: 580, h: 292 };
    const cardCy = card.y + card.h / 2;
    ctx.save();
    ctx.translate(cx, cardCy);
    ctx.scale(pop, pop);
    ctx.translate(-cx, -cardCy);
    this.drawResultCard(ctx, card);
    ctx.restore();

    // 动作按钮：矩形与 handleTap 命中区域一致（cy = H/2+110+i*50，半宽 200）
    const items = this.actions;
    items.forEach((action, i) => {
      const cy = H / 2 + 110 + i * 50;
      const r: UIRect = { x: cx - 200, y: cy - 22, w: 400, h: 44 };
      drawButton(ctx, r, action.label, {
        variant: i === 0 ? 'primary' : 'ghost',
        state: i === this.selection ? 'hover' : 'normal',
        fontSize: UI.size.h2,
      });
    });

    drawFooterHint(ctx, '点击选择 · ↑↓ 切换 · 回车确认');
  }

  /** 中央白色卡通结果卡：厚描边 + 硬投影，卡内按模式铺陈文案 */
  private drawResultCard(ctx: CanvasRenderingContext2D, card: UIRect) {
    const cx = card.x + card.w / 2;
    const o = this.opts;

    toonShape(ctx, card, {
      fill: UI.paper,
      stroke: UI.ink,
      lineWidth: 4,
      radius: UI.radius.xl,
      shadow: 7,
    });

    // 新纪录：右上角挂一枚金色小徽章
    if (o.isNewRecord) this.drawRecordBadge(ctx, card);

    if (o.mode === 'ENDLESS') {
      drawStickerText(ctx, '游戏结束', cx, card.y + 46, {
        font: `bold 42px ${UI.font.ui}`,
        fill: UI.color.dangerInk, stroke: UI.color.rim, lineWidth: 8, align: 'center',
      });
      drawStickerText(ctx, `${o.distance} m`, cx, card.y + 96, {
        font: `bold 34px ${UI.font.mono}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
      drawStickerText(ctx, `存活 ${o.clearTime.toFixed(2)}s`, cx, card.y + 130, {
        font: `19px ${UI.font.mono}`,
        fill: UI.color.sub, align: 'center',
      });
      drawStickerText(ctx, `最高纪录：${o.bestDistance}m / ${(o.bestTime ?? 0).toFixed(1)}s`, cx, card.y + 158, {
        font: `bold 13px ${UI.font.ui}`,
        fill: UI.color.dim, align: 'center',
      });
      this.drawCombo(ctx, cx, card.y + 190, o.combo);
    } else if (o.mode === 'DAILY') {
      drawStickerText(ctx, o.info ?? '每日挑战结束', cx, card.y + 44, {
        font: `bold 34px ${UI.font.ui}`,
        fill: UI.color.warnInk, stroke: UI.color.rim, lineWidth: 8, align: 'center',
      });
      drawStickerText(ctx, `${o.distance} m`, cx, card.y + 92, {
        font: `bold 32px ${UI.font.mono}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
      drawStickerText(ctx, `用时 ${o.clearTime.toFixed(1)}s  ·  今日最好 ${o.bestDistance ?? 0}m`, cx, card.y + 128, {
        font: `18px ${UI.font.mono}`, fill: UI.color.sub, align: 'center',
      });
      drawStickerText(ctx, `连续完成 ${o.daily?.streak ?? 0} 天`, cx, card.y + 156, {
        font: `bold 15px ${UI.font.ui}`, fill: UI.color.text, align: 'center',
      });
      if (o.daily?.firstCompletion && (o.daily?.coresAwarded ?? 0) > 0) {
        drawStickerText(ctx, `首次完成 +${o.daily.coresAwarded} ◆ 磁芯`, cx, card.y + 184, {
          font: `bold 15px ${UI.font.ui}`, fill: UI.color.warnInk, stroke: UI.color.rim, lineWidth: 4, align: 'center',
        });
      } else {
        drawStickerText(ctx, '今日已领奖，继续刷新纪录', cx, card.y + 184, {
          font: `14px ${UI.font.ui}`, fill: UI.color.dim, align: 'center',
        });
      }
      this.drawCombo(ctx, cx, card.y + 212, o.combo);
    } else if (o.mode === 'SPECIAL') {
      drawStickerText(ctx, '特殊关卡通过', cx, card.y + 52, {
        font: `bold 40px ${UI.font.ui}`,
        fill: UI.color.warnInk, stroke: UI.color.rim, lineWidth: 8, align: 'center',
      });
      drawStickerText(ctx, o.level.name, cx, card.y + 96, {
        font: `bold 22px ${UI.font.ui}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 5, align: 'center',
      });
      drawStickerText(ctx, `用时 ${o.clearTime.toFixed(2)}s  /  目标 ${o.level.parTime}s`, cx, card.y + 134, {
        font: `19px ${UI.font.mono}`,
        fill: UI.color.sub, align: 'center',
      });
      if (o.info) {
        drawStickerText(ctx, o.info, cx, card.y + 168, {
          font: `bold 16px ${UI.font.ui}`,
          fill: UI.color.warnInk, stroke: UI.color.rim, lineWidth: 5, align: 'center',
        });
      }
      this.drawCombo(ctx, cx, card.y + 200, o.combo);
    } else {
      // NORMAL / CUSTOM
      drawStickerText(ctx, '关卡通过', cx, card.y + 52, {
        font: `bold 42px ${UI.font.ui}`,
        fill: UI.color.successInk, stroke: UI.color.rim, lineWidth: 8, align: 'center',
      });
      drawStickerText(ctx, o.level.name, cx, card.y + 96, {
        font: `bold 22px ${UI.font.ui}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 5, align: 'center',
      });
      const timeLine = o.mode === 'NORMAL'
        ? `用时 ${o.clearTime.toFixed(2)}s  /  目标 ${o.level.parTime}s`
        : `用时 ${o.clearTime.toFixed(2)}s${o.level.id === 0 ? '' : '（自定义关卡）'}`;
      drawStickerText(ctx, timeLine, cx, card.y + 134, {
        font: `19px ${UI.font.mono}`,
        fill: UI.color.sub, align: 'center',
      });
      // 星级（仅普通关卡）：★1 通关，★2 全晶片，★3 连击目标
      if (o.mode === 'NORMAL' && o.stars !== undefined) {
        this.drawStars(ctx, cx, card.y + 168, o.stars);
        const detail = o.starDetail;
        let hint = '';
        if (detail) {
          const parts: string[] = [];
          if (!detail.allGems) parts.push(`★2 缺 ${detail.missingGems} 枚晶片`);
          if (!detail.comboGoal) parts.push(`★3 还差 ${detail.missingCombo} 连击`);
          hint = parts.join('  ·  ');
        }
        if (hint) {
          drawStickerText(ctx, hint, cx, card.y + 198, {
            font: `13px ${UI.font.ui}`, fill: UI.color.sub, align: 'center',
          });
        }
      }
      if (!o.isNewRecord && o.info) {
        drawStickerText(ctx, o.info, cx, card.y + 168, {
          font: `bold 16px ${UI.font.ui}`,
          fill: UI.color.warnInk, stroke: UI.color.rim, lineWidth: 5, align: 'center',
        });
      }
      this.drawCombo(ctx, cx, card.y + (o.mode === 'NORMAL' && o.stars !== undefined ? 226 : 200), o.combo);
    }
  }

  /** 最高连击：小标签 + 等宽数值 */
  private drawCombo(ctx: CanvasRenderingContext2D, cx: number, y: number, combo: number) {
    drawStickerText(ctx, '最高连击', cx, y, {
      font: `bold 13px ${UI.font.ui}`,
      fill: UI.color.sub, align: 'center',
    });
    drawStickerText(ctx, `${combo}`, cx, y + 30, {
      font: `bold 30px ${UI.font.mono}`,
      fill: UI.color.dangerInk, stroke: UI.color.rim, lineWidth: 4, align: 'center',
    });
  }

  /** 三星评分：亮星 = 已达成，灰星 = 未达成 */
  private drawStars(ctx: CanvasRenderingContext2D, cx: number, y: number, stars: number) {
    for (let i = 0; i < 3; i++) {
      const x = cx + (i - 1) * 48;
      drawStar(ctx, x, y, 17, 7.5, i < stars ? UI.color.charge : UI.color.dim);
    }
  }

  /** 新纪录徽章：右上角金色圆形贴纸 + 五角星 */
  private drawRecordBadge(ctx: CanvasRenderingContext2D, card: UIRect) {
    const bx = card.x + card.w - 46;
    const by = card.y + 46;
    ctx.beginPath();
    ctx.arc(bx, by, 30, 0, Math.PI * 2);
    ctx.fillStyle = UI.color.gold;
    ctx.fill();
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
    drawStar(ctx, bx, by, 15, 6.5, UI.ink);
    drawStickerText(ctx, '新纪录', bx, by + 50, {
      font: `bold 12px ${UI.font.ui}`,
      fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'center',
    });
  }
}

/** 五角星（徽章内部装饰 / 星级图标） */
function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, r: number, fill: string = UI.color.rim) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = UI.ink;
  ctx.lineWidth = 2;
  ctx.stroke();
}
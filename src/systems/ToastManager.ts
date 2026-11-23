// 全局 Toast 通知（成就解锁等），由 Game 主循环统一渲染 —— 卡通主题

import { UI } from '../ui/theme';
import { toonShape, drawStickerText } from '../ui/widgets';

interface Toast {
  title: string;
  sub: string;
  icon: string;
  age: number;
  life: number;
}

const TOAST_LIFE = 3.2;

export class ToastManager {
  private items: Toast[] = [];

  push(title: string, sub: string, icon = '成') {
    // 同名去重
    if (this.items.some(t => t.title === title)) return;
    this.items.push({ title, sub, icon, age: 0, life: TOAST_LIFE });
    if (this.items.length > 4) this.items.shift();
  }

  update(dt: number) {
    for (const t of this.items) t.age += dt;
    this.items = this.items.filter(t => t.age < t.life);
  }

  render(ctx: CanvasRenderingContext2D, W: number) {
    let y = 90;
    for (const t of this.items) {
      const enter = Math.min(1, t.age / 0.3);
      const exit = Math.min(1, (t.life - t.age) / 0.4);
      const alpha = Math.min(enter, exit);

      const r = { x: W - 20 - 310 + (1 - enter) * 340, y, w: 310, h: 66 };

      ctx.save();
      ctx.globalAlpha = alpha;
      toonShape(ctx, r, {
        fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: UI.radius.md, shadow: 5,
      });

      // 图标槽：蓄能琥珀（浅卡片上唯一的高饱和暖色）
      const slot = { x: r.x + 12, y: r.y + 13, w: 40, h: 40 };
      toonShape(ctx, slot, {
        fill: UI.color.charge, stroke: UI.ink, lineWidth: 3, radius: UI.radius.sm,
      });
      drawStickerText(ctx, t.icon, slot.x + slot.w / 2, slot.y + slot.h / 2 + 1, {
        font: `bold 20px ${UI.font.ui}`, fill: UI.ink, align: 'center', baseline: 'middle',
      });

      drawStickerText(ctx, '成就解锁', r.x + 64, r.y + 27, {
        font: `bold 16px ${UI.font.ui}`, fill: UI.color.text, align: 'left',
      });
      drawStickerText(ctx, `${t.title} · ${t.sub}`, r.x + 64, r.y + 49, {
        font: `bold 13px ${UI.font.ui}`, fill: UI.color.text, align: 'left',
      });
      ctx.restore();

      y += 76;
    }
  }
}
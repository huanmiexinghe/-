// 关卡选择场景 —— 卡通主题
//
// 视觉语言：卡通天空背景 + 贴纸标题 + 白底厚描边关卡格；
// 完成=绿描边、可玩=深靛描边、锁定=灰化 + 锁图标；彩蛋关为醒目金色横幅。
// 交互逻辑（点击命中 / 键盘导航 / 滚动）与旧版保持一致。

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { GAME_CONFIG } from '../data/config';
import { SaveSystem } from '../systems/SaveSystem';
import { LEVELS, EASTER_EGG_LEVEL } from '../data/levels';
import { withAlpha } from '../utils/Color';
import { isCoarsePointer } from '../utils/Device';
import { UI, UIRect, inRect } from '../ui/theme';
import { levelCellRect, levelContentRect, levelMaxScroll } from '../ui/LevelSelectLayout';
import {
  drawMenuBackground, drawHeader, drawFooterHint, drawBackButton, BACK_RECT,
  toonShape, drawStickerText,
} from '../ui/widgets';
import { GameScene } from './GameScene';
import { MenuScene } from './MenuScene';

export class LevelSelectScene extends Scene {
  private save = SaveSystem.get();
  private selected = 0;
  private scrollY = 0;
  private targetScrollY = 0;
  private time = 0;
  /** 触屏拖动滚动 */
  private dragging = false;
  private dragStartY = 0;
  private dragStartScroll = 0;
  private dragLastY = 0;
  private dragLastAt = 0;
  private dragVelocity = 0;
  /** 彩蛋关「磁极圣殿」入口横幅 */
  private eggRect: UIRect = { x: (GAME_CONFIG.CANVAS_WIDTH - 520) / 2, y: 64, w: 520, h: 46 };

  constructor(private game: Game) { super(); }

  onEnter() {
    this.game.input.setTouchLayout('menu');
    this.time = 0;
    this.selected = 0;
    for (let i = 0; i < LEVELS.length; i++) {
      if (this.save.isUnlocked(LEVELS[i].id)) this.selected = i;
    }
    this.scrollY = 0;
    this.targetScrollY = 0;
    this.game.input.onTap = (x, y) => this.handleTap(x, y);
    // 触屏拖动滚动：关卡数按 LEVELS.length 动态增长（当前 48 关共 11 行），超出可视区域后必须能拖动浏览
    this.game.input.onPointerDown = (x, y) => this.handleDragStart(x, y);
    this.game.input.onPointerUp = () => this.handleDragEnd();
    this.game.input.onMove = (x, y) => this.handleDragMove(x, y);
    this.dragging = false;
    this.game.audio.startMusic(100);
  }

  onExit() {
    this.game.input.onTap = null;
    this.game.input.onPointerDown = null;
    this.game.input.onPointerUp = null;
    this.game.input.onMove = null;
    this.game.audio.stopMusic();
  }

  private maxScroll(): number {
    return levelMaxScroll(LEVELS.length);
  }

  private handleDragStart(x: number, y: number) {
    // 只在被裁剪后的内容区内起拖，避免在固定标题栏/返回按钮上下拖影响点击
    if (!inRect(levelContentRect(), x, y)) return;
    this.dragging = true;
    this.dragStartY = y;
    this.dragStartScroll = this.scrollY;
    this.dragLastY = y;
    this.dragLastAt = performance.now();
    this.dragVelocity = 0;
  }

  private handleDragMove(_x: number, y: number) {
    if (!this.dragging) return;
    const dy = y - this.dragStartY;
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.dragStartScroll - dy));
    this.targetScrollY = this.scrollY;
    const now = performance.now();
    const dt = now - this.dragLastAt;
    if (dt > 0) {
      const v = (y - this.dragLastY) / (dt / 1000);
      this.dragVelocity = Math.max(-1800, Math.min(1800, v));
    }
    this.dragLastY = y;
    this.dragLastAt = now;
  }

  private handleDragEnd() {
    if (!this.dragging) return;
    this.dragging = false;
    // 惯性：按最后速度再滑一段，随后由 update 缓动收敛
    this.targetScrollY = Math.max(0, Math.min(
      this.maxScroll(), this.scrollY - this.dragVelocity * 0.18,
    ));
    this.dragVelocity = 0;
  }

  private handleTap(x: number, y: number) {
    // 左上角返回主菜单（触屏，命中矩形与 drawBackButton 的 BACK_RECT 保持一致）
    if (inRect(BACK_RECT, x, y)) {
      this.game.audio.playUIClick();
      this.game.switchScene(new MenuScene(this.game));
      return;
    }
    // 彩蛋关「磁极圣殿」入口
    const e = this.eggRect;
    if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) {
      if (this.save.easterEggUnlocked) {
        this.game.audio.playUIClick();
        this.game.switchScene(new GameScene(this.game, { def: EASTER_EGG_LEVEL }));
      }
      return;
    }
    // 命中只在裁剪后的内容区内有效，避免点中固定栏下方被裁掉的格子
    if (!inRect(levelContentRect(), x, y)) return;
    for (let i = 0; i < LEVELS.length; i++) {
      const cell = levelCellRect(i, this.scrollY);
      const cx = cell.x;
      const cy = cell.y;
      const cellW = cell.w;
      const cellH = cell.h;
      if (x >= cx && x <= cx + cellW && y >= cy && y <= cy + cellH) {
        if (this.save.isUnlocked(LEVELS[i].id)) {
          this.selected = i;
          this.game.audio.playUIClick();
          this.startLevel(LEVELS[i].id);
        }
        return;
      }
    }
  }

  private startLevel(id: number) {
    this.game.switchScene(new GameScene(this.game, { levelId: id }));
  }

  update(dt: number) {
    this.time += dt;
    const input = this.game.input;
    const cols = 5;
    // 键盘导航时才把选中格重新拉回视野，否则会覆盖触屏拖动/惯性结果
    const navPressed = ['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD',
      'ArrowUp', 'KeyW', 'ArrowDown', 'KeyS'].some(k => input.isKeyPressed(k));

    if (input.isKeyPressed('ArrowLeft') || input.isKeyPressed('KeyA')) {
      if (this.selected % cols > 0) this.selected--;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('ArrowRight') || input.isKeyPressed('KeyD')) {
      if (this.selected % cols < cols - 1 && this.selected < LEVELS.length - 1) this.selected++;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('ArrowUp') || input.isKeyPressed('KeyW')) {
      if (this.selected >= cols) this.selected -= cols;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('ArrowDown') || input.isKeyPressed('KeyS')) {
      if (this.selected + cols < LEVELS.length) this.selected += cols;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('Enter') || input.isKeyPressed('Space')) {
      if (this.save.isUnlocked(LEVELS[this.selected].id)) {
        this.game.audio.playUIClick();
        this.startLevel(LEVELS[this.selected].id);
      }
    } else if (input.isKeyPressed('KeyE')) {
      if (this.save.easterEggUnlocked) {
        this.game.audio.playUIClick();
        this.game.switchScene(new GameScene(this.game, { def: EASTER_EGG_LEVEL }));
      }
    } else if (input.isKeyPressed('Escape')) {
      this.game.switchScene(new MenuScene(this.game));
    }

    // 拖动期间由指针直接驱动 scrollY；键盘导航后才接管目标位置
    if (!this.dragging) {
      if (navPressed) {
        const cellH = 90 + 20;
        const row = Math.floor(this.selected / cols);
        this.targetScrollY = Math.max(0, Math.min(this.maxScroll(), row * cellH - 200));
      }
      this.targetScrollY = Math.max(0, Math.min(this.maxScroll(), this.targetScrollY));
      this.scrollY += (this.targetScrollY - this.scrollY) * 6 * dt;
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    // 卡通天空背景
    drawMenuBackground(ctx, this.time);

    // 顶部标题 + 返回主菜单按钮
    drawHeader(ctx, '关卡选择');
    drawBackButton(ctx, false);

    // 彩蛋关「磁极圣殿」入口横幅
    this.drawEggBanner(ctx);

    // 关键：网格绘制裁剪到固定栏之下的内容区。
    // 滚动内容因此不可能覆盖标题/返回栏，裁剪区外也不会出现「半张卡」。
    const clip = levelContentRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    for (let i = 0; i < LEVELS.length; i++) {
      const cell = levelCellRect(i, this.scrollY);
      if (cell.y + cell.h <= clip.y || cell.y >= clip.y + clip.h) continue;
      this.drawLevelCell(ctx, cell.x, cell.y, cell.w, cell.h, i);
    }
    ctx.restore();

    // 底部操作提示
    drawFooterHint(ctx, isCoarsePointer()
      ? '点击关卡开始 · 左上角返回主菜单'
      : '←→↑↓ 选择 · 回车 开始 · E 圣殿 · Esc 返回主菜单');
  }

  /** 彩蛋关入口横幅：解锁后为金色醒目卡，未解锁为淡白卡 */
  private drawEggBanner(ctx: CanvasRenderingContext2D) {
    const e = this.eggRect;
    const unlockedEgg = this.save.easterEggUnlocked;
    const starCount = this.save.data.specialItems.length;

    toonShape(ctx, e, {
      fill: unlockedEgg ? UI.color.gold : UI.color.panelSoft,
      stroke: unlockedEgg ? UI.ink : UI.inkSoft,
      lineWidth: unlockedEgg ? 4 : 3,
      radius: UI.radius.md,
      shadow: unlockedEgg ? 7 : 5,
    });

    drawStickerText(ctx,
      unlockedEgg
        ? '✦ 磁极圣殿 · 隐藏关卡已解锁'
        : `✦ 磁极圣殿 · 集齐星核解锁（${starCount}/3）`,
      e.x + e.w / 2, e.y + e.h / 2 + 1, {
        font: `bold 16px ${UI.font.ui}`,
        fill: unlockedEgg ? UI.ink : UI.color.sub,
        stroke: UI.color.rim,
        lineWidth: 5,
        align: 'center',
        baseline: 'middle',
      });
  }

  /** 单个关卡格子：卡通白卡 + 彩色描边（完成=绿 / 可玩=深靛 / 锁定=灰化 + 锁） */
  private drawLevelCell(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, i: number) {
    const level = LEVELS[i];
    const unlocked = this.save.isUnlocked(level.id);
    const rec = this.save.getLevel(level.id);
    const selected = i === this.selected;
    const cx = x + w / 2;

    // 描边：锁定=柔靛、完成=绿、可玩=深靛；选中态统一用强调色加粗
    let stroke: string = UI.ink;
    let lineWidth = 3;
    if (!unlocked) stroke = UI.inkSoft;
    else if (rec.completed) stroke = UI.color.success;
    if (selected) { stroke = UI.color.accent; lineWidth = 5; }

    toonShape(ctx, { x, y, w, h }, {
      fill: !unlocked ? UI.color.panelSoft : (selected ? withAlpha(UI.color.accent, 0.16) : UI.paper),
      stroke,
      lineWidth,
      radius: UI.radius.md,
      shadow: selected ? 7 : 5,
    });

    if (!unlocked) {
      // 灰化 + 锁图标
      this.drawLock(ctx, cx, y + h / 2 - 6, 20, UI.color.dim);
      drawStickerText(ctx, '未解锁', cx, y + h - 16, {
        font: `bold 12px ${UI.font.ui}`,
        fill: UI.color.dim,
        stroke: UI.color.rim,
        lineWidth: 4,
        align: 'center',
      });
      return;
    }

    // 关卡号
    drawStickerText(ctx, `${level.id}`, cx, y + 26, {
      font: `bold 22px ${UI.font.ui}`,
      fill: rec.completed ? UI.color.successInk : (selected ? UI.color.dangerInk : UI.color.text),
      stroke: UI.color.rim,
      lineWidth: 6,
      align: 'center',
    });

    // 关卡名
    drawStickerText(ctx, level.name, cx, y + 46, {
      font: `bold 12px ${UI.font.ui}`,
      fill: UI.color.sub,
      stroke: UI.color.rim,
      lineWidth: 4,
      align: 'center',
    });

    // 星级：通关后显示 ★/☆（★1 通关、★2 全晶片、★3 连击目标）
    if (rec.completed) {
      for (let s = 0; s < 3; s++) {
        drawStickerText(ctx, s < rec.stars ? '★' : '☆', cx + (s - 1) * 15, y + 66, {
          font: `bold 12px ${UI.font.ui}`,
          fill: s < rec.stars ? UI.color.gold : UI.color.dim,
          stroke: UI.color.rim,
          lineWidth: 3,
          align: 'center',
        });
      }
    } else if (rec.skipped) {
      drawStickerText(ctx, '跳过', cx, y + 66, {
        font: `bold 11px ${UI.font.ui}`, fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
    }

    // 最佳时间（等宽字体）
    if (rec.bestTime > 0) {
      drawStickerText(ctx, `${rec.bestTime.toFixed(1)}s`, cx, y + 84, {
        font: `bold 10px ${UI.font.mono}`, fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
    }
  }

  /** 简易矢量锁图标：圆角锁体 + 上方锁钩 */
  private drawLock(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string) {
    const bw = size;
    const bh = size * 0.72;
    const by = cy - bh / 2 + size * 0.16;
    // 锁钩
    ctx.beginPath();
    ctx.arc(cx, by, size * 0.26, Math.PI, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, size * 0.16);
    ctx.lineCap = 'round';
    ctx.stroke();
    // 锁体
    toonShape(ctx, { x: cx - bw / 2, y: by, w: bw, h: bh }, {
      fill: color,
      stroke: UI.color.rim,
      lineWidth: 2,
      radius: size * 0.28,
    });
  }
}
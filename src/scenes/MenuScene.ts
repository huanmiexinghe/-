// 主菜单场景 —— 卡通主题（信息层级版）
//
// 结构（由上到下）：
//   1. 品牌栏：磁铁徽记 + 标题 + 磁芯数量 + 设置齿轮（设置/重置折叠进齿轮）
//   2. 首要动作：继续/开始（大号实心红卡）+ 每日挑战特写（倒计时/连续天数/修正）
//   3. 模式行：关卡选择 / 无尽模式（两张等宽白卡）
//   4. 次级入口：联机竞速 / 自定义关卡 / 成就（小卡，弱化权重）
//   5. 战绩条 + 底部操作提示
//
// 交互：键盘 ↑↓←→ 选择、回车确认；触屏「抬起且未拖动」才触发点击；
// 设置弹层内可开关声音、调音量，重置存档仍需二次确认。

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { COLORS, GAME_CONFIG } from '../data/config';
import { SaveSystem, localDate } from '../systems/SaveSystem';
import { LEVELS, TUTORIAL_LEVEL } from '../data/levels';
import { ACHIEVEMENTS } from '../data/achievements';
import { dailyModifiers, dailyModifierLabel } from '../systems/EndlessGenerator';
import { withAlpha } from '../utils/Color';
import { Easing } from '../utils/Easing';
import { isCoarsePointer } from '../utils/Device';
import { privacyPolicyUrl } from '../net/ServerUrl';
import { GameScene } from './GameScene';
import { LevelSelectScene } from './LevelSelectScene';
import { AchievementsScene } from './AchievementsScene';
import { CustomLevelsScene } from './CustomLevelsScene';
import { OnlineLobbyScene } from './OnlineLobbyScene';
import { UI, UIRect } from '../ui/theme';
import { SETTINGS_GROUPS, settingsLayout, resetConfirmLayout } from '../ui/SettingsLayout';
import {
  drawMenuBackground, toonShape, drawStickerText, drawStatChip, drawButton,
} from '../ui/widgets';

type IconKind = 'endless' | 'online' | 'levels' | 'create' | 'trophy' | 'daily' | 'settings';

/** 卡片层级：决定尺寸、描边与信息密度 */
type ItemKind = 'hero' | 'daily' | 'mode' | 'secondary' | 'gear';

interface MenuItem {
  kind: ItemKind;
  label: string;
  desc: string;
  rect: UIRect;
  action: () => void;
  icon?: IconKind;
  /** 卡片配色（图标槽底色 / 选中描边） */
  accent?: string;
}

export class MenuScene extends Scene {
  private save = SaveSystem.get();
  private selection = 0;
  private items: MenuItem[] = [];
  /** 键盘导航行分组（按视觉行组织，导航按最近中心点跨行） */
  private navRows: number[][] = [];
  private time = 0;
  private enterTime = 0;
  private hover = -1;
  private pressed = -1;
  private mx = -1;
  private my = -1;

  /** 主 CTA 右上角的进度徽标文案 */
  private heroBadge = '';
  private heroProgress = 0;

  /** 每日挑战状态 */
  private dailyDone = false;
  private dailyStreak = 0;
  private dailyModNames: string[] = [];
  private dailyRemain = '00:00:00';
  private countdownAcc = 0;

  /** 设置 / 重置二次确认弹层 */
  private settingsOpen = false;
  private confirmReset = false;
  private coresChip: UIRect = { x: 0, y: 0, w: 0, h: 0 };
  private settingsRects = {
    mute: { x: 0, y: 0, w: 0, h: 0 },
    volume: { x: 0, y: 0, w: 0, h: 0 },
    volDown: { x: 0, y: 0, w: 0, h: 0 },
    volUp: { x: 0, y: 0, w: 0, h: 0 },
    volBar: { x: 0, y: 0, w: 0, h: 0 },
    shake: { x: 0, y: 0, w: 0, h: 0 },
    speedFx: { x: 0, y: 0, w: 0, h: 0 },
    privacy: { x: 0, y: 0, w: 0, h: 0 },
    reset: { x: 0, y: 0, w: 0, h: 0 },
    close: { x: 0, y: 0, w: 0, h: 0 },
  };
  private resetRects = {
    cancel: { x: 0, y: 0, w: 0, h: 0 },
    confirm: { x: 0, y: 0, w: 0, h: 0 },
  };

  constructor(private game: Game) {
    super();
  }

  onEnter() {
    this.game.input.setTouchLayout('menu');
    this.time = 0;
    this.enterTime = 0;
    this.selection = 0;
    this.hover = -1;
    this.pressed = -1;
    this.mx = -1; this.my = -1;
    this.settingsOpen = false;
    this.confirmReset = false;
    this.countdownAcc = 0;

    const W = GAME_CONFIG.CANVAS_WIDTH;
    const M = 56;
    const contentW = W - M * 2;          // 848

    const cleared = LEVELS.filter(l => this.save.getLevel(l.id).completed).length;
    const firstUnfinished = LEVELS.find(l => {
      const r = this.save.getLevel(l.id);
      return !r.completed && !r.skipped && this.save.isUnlocked(l.id);
    }) ?? LEVELS[0];
    const allDone = cleared >= LEVELS.length;
    const tutorialDone = this.save.data.tutorialDone;

    // 主 CTA 文案与徽标：继续 / 开始 / 再次挑战三态
    let heroLabel = '开始游戏';
    let heroDesc = '新手教程 · 从零掌握四个基础操作';
    this.heroBadge = '新手教程';
    if (tutorialDone && allDone) {
      heroLabel = '再次挑战';
      heroDesc = '全部关卡已通关 · 从第 1 关重新出发';
      this.heroBadge = '全部通关';
    } else if (tutorialDone) {
      heroLabel = '继续游戏';
      heroDesc = `第 ${firstUnfinished.id} 关 · ${firstUnfinished.name}`;
      this.heroBadge = `${cleared} / ${LEVELS.length} 关`;
    }
    this.heroProgress = LEVELS.length > 0 ? cleared / LEVELS.length : 0;

    const daily = this.save.data.daily;
    const today = localDate();
    this.dailyDone = daily.date === today && daily.completed;
    this.dailyStreak = daily.streak;
    this.dailyModNames = dailyModifierLabel(dailyModifiers()).split(' · ').filter(s => s.length > 0);
    this.updateCountdown();

    // ------------------------------------------------------------ 布局
    const heroRect: UIRect = { x: M, y: 90, w: 560, h: 118 };
    const dailyRect: UIRect = { x: M + 580, y: 90, w: contentW - 580, h: 118 };

    const modeY = 224, modeH = 88, modeGap = 20;
    const modeW = (contentW - modeGap) / 2;
    const levelsRect: UIRect = { x: M, y: modeY, w: modeW, h: modeH };
    const endlessRect: UIRect = { x: M + modeW + modeGap, y: modeY, w: modeW, h: modeH };

    const secY = 326, secH = 64, secGap = 16;
    const secW = (contentW - secGap * 2) / 3;
    const secRect = (i: number): UIRect => ({ x: M + i * (secW + secGap), y: secY, w: secW, h: secH });

    // 右上角齿轮：设置与重置的唯一入口（64×64 逻辑像素，横屏下≥44 CSS px）
    const gearRect: UIRect = { x: W - M - 64, y: 14, w: 64, h: 64 };
    this.coresChip = { x: gearRect.x - 12 - 132, y: 24, w: 132, h: 44 };

    const endlessMeters = Math.round(this.save.data.endlessBestDistance / 50);
    const achCount = this.game.achievements?.count() ?? 0;

    this.items = [
      {
        kind: 'hero', label: heroLabel, desc: heroDesc, rect: heroRect,
        action: () => this.game.switchScene(new GameScene(this.game,
          tutorialDone ? { levelId: firstUnfinished.id } : { def: TUTORIAL_LEVEL })),
      },
      {
        kind: 'daily', label: '每日挑战', desc: '', icon: 'daily',
        accent: UI.color.gold, rect: dailyRect,
        action: () => this.game.switchScene(new GameScene(this.game, { daily: true })),
      },
      {
        kind: 'mode', label: '关卡选择', desc: `${LEVELS.length} 关 · ${cleared} 关已通关`,
        icon: 'levels', accent: UI.color.mint, rect: levelsRect,
        action: () => this.game.switchScene(new LevelSelectScene(this.game)),
      },
      {
        kind: 'mode', label: '无尽模式', desc: endlessMeters > 0 ? `最远 ${endlessMeters} m · 冲击新纪录` : '无限冲刺 · 挑战最远距离',
        icon: 'endless', accent: UI.color.lemon, rect: endlessRect,
        action: () => this.game.switchScene(new GameScene(this.game, { endless: true })),
      },
      {
        kind: 'secondary', label: '联机竞速', desc: '最多 4 人 · 实时排名',
        icon: 'online', accent: UI.color.sky, rect: secRect(0),
        action: () => this.game.switchScene(new OnlineLobbyScene(this.game)),
      },
      {
        kind: 'secondary', label: '自定义关卡', desc: '创作并分享你的关卡',
        icon: 'create', accent: UI.color.grape, rect: secRect(1),
        action: () => this.game.switchScene(new CustomLevelsScene(this.game)),
      },
      {
        kind: 'secondary', label: '成就', desc: `${achCount} / ${ACHIEVEMENTS.length} 已解锁`,
        icon: 'trophy', accent: UI.color.gold, rect: secRect(2),
        action: () => this.game.switchScene(new AchievementsScene(this.game)),
      },
      {
        kind: 'gear', label: '设置', desc: '', icon: 'settings',
        accent: UI.color.sub, rect: gearRect,
        action: () => { this.settingsOpen = true; },
      },
    ];

    // 视觉行分组：顶部（主 CTA / 每日 / 齿轮）、模式行、次级行
    this.navRows = [[0, 1, 7], [2, 3], [4, 5, 6]];

    // 设置弹层：音频 / 显示 / 账号与信息 / 危险操作 四组；行高来自 SettingsLayout
    const sl = settingsLayout();
    this.settingsRects = {
      mute: sl.rows.mute,
      volume: sl.rows.volume,
      volDown: sl.volDown,
      volUp: sl.volUp,
      volBar: sl.volBar,
      shake: sl.rows.shake,
      speedFx: sl.rows.speedFx,
      privacy: sl.rows.privacy,
      reset: sl.rows.reset,
      close: sl.close,
    };
    const rl = resetConfirmLayout();
    this.resetRects = { cancel: rl.cancel, confirm: rl.confirm };

    // 画面震动开关与存档保持一致（重置存档后 onEnter 会重新同步）
    this.game.renderer.shake.enabled = this.save.data.shake;

    this.game.input.onTap = (x, y) => this.handleTap(x, y);
    this.game.input.onPointerDown = (x, y) => { this.pressed = this.hitIndex(x, y); };
    this.game.input.onPointerUp = () => { this.pressed = -1; };
    this.game.input.onMove = (x, y) => { this.mx = x; this.my = y; };
    this.game.audio.startMusic(100);
  }

  onExit() {
    this.game.input.onTap = null;
    this.game.input.onPointerDown = null;
    this.game.input.onPointerUp = null;
    this.game.input.onMove = null;
    this.game.audio.stopMusic();
  }

  private applyAudio() {
    this.save.data.volume = Math.max(0, Math.min(1, this.save.data.volume));
    this.game.audio.applySettings(this.save.data.muted, this.save.data.volume);
    this.save.save();
  }

  /**
   * 打开隐私政策页。地址由 ServerUrl.ts 的当前服务器地址派生（与联机/关卡接口同源），
   * 不在界面层重复硬编码域名。
   * Android 端没有 @capacitor/browser 插件：Capacitor 的 BridgeWebViewClient 会把外部
   * http(s) 主框架导航交给系统浏览器（ACTION_VIEW），所以这里用 location.href 最简可靠；
   * 桌面浏览器调试时则新开标签页。
   */
  private openPrivacyPolicy() {
    const url = privacyPolicyUrl();
    if (!url) return;
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (cap?.isNativePlatform?.()) {
      window.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  /** 每日挑战倒计时：距本地零点的时间，按秒刷新 */
  private updateCountdown() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const total = Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
    const pad = (n: number) => String(n).padStart(2, '0');
    this.dailyRemain = `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  }

  private hitIndex(x: number, y: number): number {
    for (let i = 0; i < this.items.length; i++) {
      const r = this.items[i].rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
    }
    return -1;
  }

  private handleTap(x: number, y: number) {
    const hit = (r: UIRect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

    if (this.confirmReset) {
      if (hit(this.resetRects.cancel)) {
        this.confirmReset = false;
        this.game.audio.playUIClick();
        return;
      }
      if (hit(this.resetRects.confirm)) {
        this.save.reset();
        this.confirmReset = false;
        this.game.audio.playUIClick();
        this.applyAudio();
        this.onEnter();
      }
      return;
    }

    if (this.settingsOpen) {
      if (hit(this.settingsRects.mute)) {
        this.save.data.muted = !this.save.data.muted;
        this.game.audio.playUIClick();
        this.applyAudio();
        return;
      }
      if (hit(this.settingsRects.volDown)) {
        this.save.data.volume = Math.max(0, this.save.data.volume - 0.1);
        this.game.audio.playUIClick();
        this.applyAudio();
        return;
      }
      if (hit(this.settingsRects.volUp)) {
        this.save.data.volume = Math.min(1, this.save.data.volume + 0.1);
        this.game.audio.playUIClick();
        this.applyAudio();
        return;
      }
      if (hit(this.settingsRects.volBar)) {
        const bar = this.settingsRects.volBar;
        this.save.data.volume = Math.max(0, Math.min(1, (x - bar.x) / bar.w));
        this.game.audio.playUIClick();
        this.applyAudio();
        return;
      }
      if (hit(this.settingsRects.shake)) {
        this.save.data.shake = !this.save.data.shake;
        this.game.renderer.shake.enabled = this.save.data.shake;
        this.game.audio.playUIClick();
        this.save.save();
        return;
      }
      if (hit(this.settingsRects.speedFx)) {
        this.save.data.fxSpeed = !this.save.data.fxSpeed;
        this.game.audio.playUIClick();
        this.save.save();
        return;
      }
      if (hit(this.settingsRects.privacy)) {
        this.game.audio.playUIClick();
        this.openPrivacyPolicy();
        return;
      }
      if (hit(this.settingsRects.reset)) {
        this.game.audio.playUIClick();
        this.confirmReset = true;
        return;
      }
      if (hit(this.settingsRects.close)) {
        this.settingsOpen = false;
        this.game.audio.playUIClick();
      }
      return;
    }

    const idx = this.hitIndex(x, y);
    if (idx >= 0) {
      this.selection = idx;
      this.game.audio.playUIClick();
      this.items[idx].action();
    }
  }

  /** 键盘导航：同一行左右移动；上下按最近中心点跨行 */
  private moveSelection(dx: number, dy: number) {
    const rows = this.navRows;
    let row = rows.findIndex(r => r.includes(this.selection));
    if (row < 0) row = 0;

    let next = this.selection;
    if (dx !== 0) {
      const col = rows[row].indexOf(this.selection);
      const t = col + dx;
      if (t >= 0 && t < rows[row].length) next = rows[row][t];
    } else if (dy !== 0) {
      const nr = row + dy;
      if (nr >= 0 && nr < rows.length) {
        const cur = this.items[this.selection].rect;
        const curX = cur.x + cur.w / 2;
        let best = rows[nr][0];
        let bestDist = Infinity;
        for (const idx of rows[nr]) {
          const c = this.items[idx].rect;
          const d = Math.abs(c.x + c.w / 2 - curX);
          if (d < bestDist) { bestDist = d; best = idx; }
        }
        next = best;
      }
    }

    if (next !== this.selection) {
      this.selection = next;
      this.game.audio.playUIClick();
    }
  }

  update(dt: number) {
    this.time += dt;
    this.enterTime += dt;

    // 每秒刷新一次每日倒计时（不每帧建 Date）
    this.countdownAcc += dt;
    if (this.countdownAcc >= 1) {
      this.countdownAcc = 0;
      this.updateCountdown();
    }

    const input = this.game.input;
    if (this.settingsOpen || this.confirmReset) {
      if (input.isKeyPressed('Escape')) {
        if (this.confirmReset) this.confirmReset = false;
        else this.settingsOpen = false;
        this.game.audio.playUIClick();
      } else if (this.settingsOpen && !this.confirmReset && input.isKeyPressed('Enter')) {
        this.settingsOpen = false;
        this.game.audio.playUIClick();
      }
      return;
    }

    if (input.isKeyPressed('ArrowUp') || input.isKeyPressed('KeyW')) this.moveSelection(0, -1);
    else if (input.isKeyPressed('ArrowDown') || input.isKeyPressed('KeyS')) this.moveSelection(0, 1);
    else if (input.isKeyPressed('ArrowLeft') || input.isKeyPressed('KeyA')) this.moveSelection(-1, 0);
    else if (input.isKeyPressed('ArrowRight') || input.isKeyPressed('KeyD')) this.moveSelection(1, 0);
    else if (input.isKeyPressed('Enter') || input.isKeyPressed('Space')) {
      this.game.audio.playUIClick();
      this.items[this.selection].action();
    }

    if (this.mx >= 0) this.hover = this.hitIndex(this.mx, this.my);
  }

  render(ctx: CanvasRenderingContext2D) {
    drawMenuBackground(ctx, this.time);
    this.drawHeader(ctx);

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const active = i === this.selection || i === this.hover;
      const pressed = i === this.pressed;

      // 进场：淡入 + 自下而上 14px，逐项错开
      const k = Math.min(1, Math.max(0, this.enterTime - i * 0.05) / 0.32);
      const ease = Easing.easeOutCubic(k);
      ctx.save();
      ctx.globalAlpha = ease;
      ctx.translate(0, (1 - ease) * 14);

      switch (item.kind) {
        case 'hero': this.drawHeroCard(ctx, item, active, pressed); break;
        case 'daily': this.drawDailyCard(ctx, item, active, pressed); break;
        case 'mode': this.drawModeCard(ctx, item, active, pressed); break;
        case 'secondary': this.drawSecondaryCard(ctx, item, active, pressed); break;
        case 'gear': this.drawGearButton(ctx, item, active, pressed); break;
      }
      ctx.restore();
    }

    this.drawStatusBar(ctx, GAME_CONFIG.CANVAS_WIDTH / 2);

    if (this.settingsOpen) this.drawSettingsModal(ctx);
    if (this.confirmReset) this.drawResetConfirm(ctx);
  }

  // ------------------------------------------------------------ 品牌栏

  /** 顶部：徽记 + 标题 + 磁芯 + 齿轮（内容区从 y=90 开始，给主 CTA 更大呼吸） */
  private drawHeader(ctx: CanvasRenderingContext2D) {
    drawMagnet(ctx, 60, 42, 1.0);
    drawStickerText(ctx, 'MAGNETIC RUSH', 92, 38, {
      font: `bold 30px ${UI.font.ui}`,
      fill: UI.color.rim,
      stroke: UI.ink,
      lineWidth: 7,
      align: 'left',
    });
    drawStickerText(ctx, '磁极冲刺', 94, 62, {
      font: `bold 12px ${UI.font.ui}`,
      fill: UI.color.accent,
      stroke: UI.color.rim,
      lineWidth: 5,
      align: 'left',
    });

    drawStatChip(ctx, this.coresChip, '磁芯', `${this.save.data.cores}`, UI.color.gold);
  }

  // ------------------------------------------------------------ 首要动作

  /** 主 CTA：实心强调色大卡 + 播放徽章 + 进度条 */
  private drawHeroCard(ctx: CanvasRenderingContext2D, item: MenuItem, active: boolean, pressed: boolean) {
    const r = item.rect;
    const cy = r.y + r.h / 2;
    ctx.save();
    if (pressed) ctx.translate(0, 2);

    toonShape(ctx, r, {
      fill: active ? UI.color.accent : UI.color.accent,
      stroke: UI.ink,
      lineWidth: 4,
      radius: UI.radius.lg,
      shadow: active ? 8 : 6,
    });

    // 播放徽章
    const bx = r.x + 46;
    ctx.beginPath();
    ctx.arc(bx, cy - 6, 24, 0, Math.PI * 2);
    ctx.fillStyle = UI.paper;
    ctx.fill();
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx - 7, cy - 18);
    ctx.lineTo(bx + 12, cy - 6);
    ctx.lineTo(bx - 7, cy + 6);
    ctx.closePath();
    ctx.fillStyle = UI.color.accent;
    ctx.fill();

    drawStickerText(ctx, item.label, r.x + 86, r.y + 46, {
      font: `bold 27px ${UI.font.ui}`, fill: UI.color.rim, align: 'left',
    });
    drawStickerText(ctx, item.desc, r.x + 86, r.y + 70, {
      font: `bold 13px ${UI.font.ui}`, fill: UI.paper, align: 'left',
    });

    // 进度徽标（右上角）
    if (this.heroBadge) {
      ctx.font = `bold 12px ${UI.font.ui}`;
      const bw = ctx.measureText(this.heroBadge).width + 26;
      const badge: UIRect = { x: r.x + r.w - bw - 18, y: r.y + 14, w: bw, h: 28 };
      toonShape(ctx, badge, {
        fill: UI.paper, stroke: UI.ink, lineWidth: 2.5, radius: UI.radius.pill,
      });
      drawStickerText(ctx, this.heroBadge, badge.x + bw / 2, badge.y + 15, {
        font: `bold 12px ${UI.font.ui}`, fill: UI.color.accent, align: 'center', baseline: 'middle',
      });
    }

    // 关卡进度条
    const barX = r.x + 86;
    const barW = r.w - 86 - 24;
    const barY = r.y + 86;
    ctx.beginPath(); ctx.roundRect(barX, barY, barW, 10, 5);
    ctx.fillStyle = withAlpha(UI.paper, 0.34);
    ctx.fill();
    if (this.heroProgress > 0) {
      ctx.beginPath(); ctx.roundRect(barX, barY, barW * Math.min(1, this.heroProgress), 10, 5);
      ctx.fillStyle = UI.paper;
      ctx.fill();
    }
    drawStickerText(ctx, `${Math.round(this.heroProgress * 100)}%`, r.x + r.w - 24, barY + 5, {
      font: `bold 11px ${UI.font.mono}`, fill: UI.paper, align: 'right', baseline: 'middle',
    });

    ctx.restore();
  }

  /** 每日挑战特写：金色标签 + 状态 + 修正胶囊 + 倒计时/连续天数 */
  private drawDailyCard(ctx: CanvasRenderingContext2D, item: MenuItem, active: boolean, pressed: boolean) {
    const r = item.rect;
    ctx.save();
    if (pressed) ctx.translate(0, 2);

    toonShape(ctx, r, {
      fill: active ? withAlpha(UI.color.gold, 0.16) : UI.paper,
      stroke: active ? UI.color.gold : UI.ink,
      lineWidth: active ? 4 : 3,
      radius: UI.radius.md,
      shadow: active ? 7 : 5,
    });

    // 左上金色标签
    const ribbon: UIRect = { x: r.x + 14, y: r.y + 14, w: 96, h: 26 };
    toonShape(ctx, ribbon, {
      fill: UI.color.gold, stroke: UI.ink, lineWidth: 2.5, radius: UI.radius.pill,
    });
    drawIcon(ctx, 'daily', ribbon.x + 16, ribbon.y + 13, 15, UI.ink);
    drawStickerText(ctx, '每日挑战', ribbon.x + 58, ribbon.y + 14, {
      font: `bold 12px ${UI.font.ui}`, fill: UI.ink, align: 'center', baseline: 'middle',
    });

    // 状态（右上）：今日已完成 / 首通磁芯
    const statusText = this.dailyDone
      ? '今日已完成'
      : `首通 +${GAME_CONFIG.DAILY_FIRST_CLEAR_CORES} 磁芯`;
    drawStickerText(ctx, statusText, r.x + r.w - 14, r.y + 27, {
      font: `bold 12px ${UI.font.ui}`,
      fill: this.dailyDone ? UI.color.successInk : UI.color.warnInk,
      align: 'right',
      baseline: 'middle',
    });

    // 当日两条修正（纯展示）
    ctx.font = `bold 11px ${UI.font.ui}`;
    let chipX = r.x + 14;
    for (const name of this.dailyModNames.slice(0, 2)) {
      const tw = ctx.measureText(name).width + 20;
      if (chipX + tw > r.x + r.w - 14) break;
      const chip: UIRect = { x: chipX, y: r.y + 50, w: tw, h: 24 };
      toonShape(ctx, chip, {
        fill: withAlpha(UI.color.gold, 0.16), stroke: UI.inkSoft, lineWidth: 2, radius: UI.radius.pill,
      });
      drawStickerText(ctx, name, chipX + tw / 2, chip.y + 13, {
        font: `bold 11px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
      });
      chipX += tw + 8;
    }

    // 倒计时（等宽字体，避免跳字）+ 连续天数
    drawStickerText(ctx, `剩余 ${this.dailyRemain}`, r.x + 14, r.y + 96, {
      font: `bold 15px ${UI.font.mono}`, fill: UI.color.text, align: 'left', baseline: 'middle',
    });
    const streakText = this.dailyStreak > 0 ? `连续 ${this.dailyStreak} 天` : '尚未开始';
    drawStickerText(ctx, streakText, r.x + r.w - 14, r.y + 96, {
      font: `bold 11px ${UI.font.ui}`, fill: UI.color.sub, align: 'right', baseline: 'middle',
    });

    ctx.restore();
  }

  // ------------------------------------------------------------ 模式 / 次级

  /** 模式行卡片：白底厚描边 + 图标槽 + 右侧箭头 */
  private drawModeCard(ctx: CanvasRenderingContext2D, item: MenuItem, active: boolean, pressed: boolean) {
    const r = item.rect;
    const accent = item.accent ?? UI.color.accent;
    ctx.save();
    if (pressed) ctx.translate(0, 2);

    toonShape(ctx, r, {
      fill: active ? withAlpha(accent, 0.14) : UI.paper,
      stroke: active ? accent : UI.ink,
      lineWidth: active ? 4 : 3,
      radius: UI.radius.md,
      shadow: active ? 7 : 5,
    });

    const bs = 44;
    const bx = r.x + 18;
    const by = r.y + (r.h - bs) / 2;
    toonShape(ctx, { x: bx, y: by, w: bs, h: bs }, {
      fill: withAlpha(accent, 0.22), stroke: UI.ink, lineWidth: 2.5, radius: UI.radius.sm,
    });
    drawIcon(ctx, item.icon ?? 'levels', bx + bs / 2, by + bs / 2, 23, accent);

    drawStickerText(ctx, item.label, bx + bs + 16, r.y + 34, {
      font: `bold 21px ${UI.font.ui}`, fill: UI.color.text, align: 'left',
    });
    drawStickerText(ctx, item.desc, bx + bs + 16, r.y + 58, {
      font: `bold 12px ${UI.font.ui}`, fill: UI.color.sub, align: 'left',
    });

    drawStickerText(ctx, '›', r.x + r.w - 24, r.y + r.h / 2 + 1, {
      font: `bold 28px ${UI.font.ui}`, fill: withAlpha(accent, 0.8), align: 'center', baseline: 'middle',
    });

    ctx.restore();
  }

  /** 次级入口：小卡，图标 + 单行标题 + 一行弱化说明 */
  private drawSecondaryCard(ctx: CanvasRenderingContext2D, item: MenuItem, active: boolean, pressed: boolean) {
    const r = item.rect;
    const accent = item.accent ?? UI.color.sub;
    ctx.save();
    if (pressed) ctx.translate(0, 2);

    toonShape(ctx, r, {
      fill: active ? withAlpha(accent, 0.14) : UI.paper,
      stroke: active ? accent : UI.inkSoft,
      lineWidth: active ? 3.5 : 2.5,
      radius: UI.radius.md,
      shadow: active ? 6 : 4,
    });

    const bs = 28;
    const bx = r.x + 14;
    const by = r.y + (r.h - bs) / 2;
    toonShape(ctx, { x: bx, y: by, w: bs, h: bs }, {
      fill: withAlpha(accent, 0.2), stroke: UI.inkSoft, lineWidth: 2, radius: UI.radius.sm,
    });
    drawIcon(ctx, item.icon ?? 'levels', bx + bs / 2, by + bs / 2, 16, accent);

    drawStickerText(ctx, item.label, bx + bs + 12, r.y + 23, {
      font: `bold 16px ${UI.font.ui}`, fill: UI.color.text, align: 'left',
    });
    drawStickerText(ctx, item.desc, bx + bs + 12, r.y + 41, {
      font: `bold 11px ${UI.font.ui}`, fill: UI.color.sub, align: 'left',
    });

    ctx.restore();
  }

  /** 齿轮按钮：设置/重置的唯一入口 */
  private drawGearButton(ctx: CanvasRenderingContext2D, item: MenuItem, active: boolean, pressed: boolean) {
    const r = item.rect;
    ctx.save();
    if (pressed) ctx.translate(0, 2);
    toonShape(ctx, r, {
      fill: active ? withAlpha(UI.color.sub, 0.16) : UI.paper,
      stroke: active ? UI.color.sub : UI.ink,
      lineWidth: active ? 4 : 3,
      radius: UI.radius.md,
      shadow: active ? 6 : 4,
    });
    drawIcon(ctx, 'settings', r.x + r.w / 2, r.y + r.h / 2, 24, UI.color.text);
    ctx.restore();
  }

  // ------------------------------------------------------------ 弹层

  /** 设置弹层：音频 / 显示 / 账号与信息 / 危险操作 四组，行距拉开，命中区 ≥44 CSS px */
  private drawSettingsModal(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const sl = settingsLayout();
    const rows = sl.rows;
    const cx = sl.title.x;

    ctx.fillStyle = withAlpha(UI.ink, 0.28);
    ctx.fillRect(0, 0, W, GAME_CONFIG.CANVAS_HEIGHT);

    toonShape(ctx, sl.panel, {
      fill: UI.paper, stroke: UI.ink, lineWidth: 4, radius: UI.radius.xl, shadow: 8,
    });

    drawStickerText(ctx, '设置', cx, sl.title.y, {
      font: `bold 26px ${UI.font.ui}`, fill: UI.color.accent, stroke: UI.color.rim,
      lineWidth: 7, align: 'center', baseline: 'middle',
    });
    drawStickerText(ctx, '音频、显示、账号与危险操作分组管理', cx, sl.subtitle.y, {
      font: `bold 12px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
    });

    ctx.beginPath();
    ctx.moveTo(sl.panel.x + 24, sl.dividerY);
    ctx.lineTo(sl.panel.x + sl.panel.w - 104, sl.dividerY);
    ctx.strokeStyle = UI.inkFaint;
    ctx.lineWidth = 2;
    ctx.stroke();

    const groupAccent: Record<string, string> = {
      audio: UI.color.accent2,
      display: UI.color.mint,
      account: UI.color.grape,
      danger: UI.color.danger,
    };
    for (const g of SETTINGS_GROUPS) {
      this.drawGroupLabel(ctx, sl.panel.x + 24, g.labelY, g.title, groupAccent[g.id] ?? UI.color.sub);
    }

    // 音频：声音开关（整行）+ 主音量（减 / 滑杆 / 加）
    drawButton(ctx, rows.mute, this.save.data.muted ? '声音：已静音' : '声音：开启', {
      variant: this.save.data.muted ? 'ghost' : 'primary', fontSize: 19,
    });

    toonShape(ctx, rows.volume, {
      fill: UI.paper, stroke: UI.inkFaint, lineWidth: 2, radius: UI.radius.lg,
    });
    drawStickerText(ctx, `主音量 ${Math.round(this.save.data.volume * 100)}%`, cx, this.settingsRects.volBar.y - 8, {
      font: `bold 12px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
    });
    drawButton(ctx, this.settingsRects.volDown, '−', { variant: 'ghost', fontSize: 23 });
    drawButton(ctx, this.settingsRects.volUp, '＋', { variant: 'ghost', fontSize: 23 });
    const bar = this.settingsRects.volBar;
    const grooveY = bar.y + (bar.h - 12) / 2;
    ctx.beginPath(); ctx.roundRect(bar.x, grooveY, bar.w, 12, 6);
    ctx.fillStyle = withAlpha(UI.ink, 0.12);
    ctx.fill();
    ctx.beginPath(); ctx.roundRect(bar.x, grooveY, bar.w * this.save.data.volume, 12, 6);
    ctx.fillStyle = UI.color.accent;
    ctx.fill();

    // 显示：画面震动 / 速度感
    drawButton(ctx, rows.shake, this.save.data.shake ? '画面震动：开启' : '画面震动：关闭', {
      variant: this.save.data.shake ? 'primary' : 'ghost', fontSize: 18,
    });
    drawButton(ctx, rows.speedFx, this.save.data.fxSpeed ? '速度感：开' : '速度感：关', {
      variant: this.save.data.fxSpeed ? 'primary' : 'ghost', fontSize: 15,
    });

    // 账号与信息：隐私政策（与服务器同源，点击交给系统浏览器打开）
    drawButton(ctx, rows.privacy, '隐私政策 · 查看完整说明', {
      variant: 'ghost', fontSize: 16,
    });

    // 危险操作：重置存档仍需二次确认
    toonShape(ctx, rows.reset, {
      fill: withAlpha(UI.color.danger, 0.12), stroke: withAlpha(UI.color.danger, 0.55),
      lineWidth: 2.5, radius: UI.radius.pill, shadow: 3,
    });
    drawStickerText(ctx, '重置存档 · 清空全部进度', rows.reset.x + rows.reset.w / 2,
      rows.reset.y + rows.reset.h / 2 + 1, {
        font: `bold 15px ${UI.font.ui}`, fill: UI.color.dangerInk, align: 'center', baseline: 'middle',
      });

    drawButton(ctx, this.settingsRects.close, '×', { variant: 'ghost', fontSize: 26 });
  }

  /** 分组小标题：左侧色条 + 组名，组与组之间留白 */
  private drawGroupLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, accent: string) {
    ctx.beginPath();
    ctx.roundRect(x, y - 11, 4, 14, 2);
    ctx.fillStyle = accent;
    ctx.fill();
    drawStickerText(ctx, text, x + 10, y, {
      font: `bold 12px ${UI.font.ui}`, fill: UI.color.sub, stroke: UI.color.rim,
      lineWidth: 4, align: 'left', baseline: 'middle',
    });
  }

  /** 重置存档二次确认：默认取消，明确写出会清空的内容 */
  private drawResetConfirm(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const rl = resetConfirmLayout();
    ctx.fillStyle = withAlpha(UI.ink, 0.32);
    ctx.fillRect(0, 0, W, GAME_CONFIG.CANVAS_HEIGHT);

    toonShape(ctx, rl.panel, {
      fill: UI.paper, stroke: UI.ink, lineWidth: 4, radius: UI.radius.xl, shadow: 8,
    });
    drawStickerText(ctx, '清空全部进度？', rl.title.x, rl.title.y, {
      font: `bold 26px ${UI.font.ui}`, fill: UI.color.accent, stroke: UI.color.rim,
      lineWidth: 7, align: 'center', baseline: 'middle',
    });
    drawStickerText(ctx, '关卡星级、跳关次数、无尽纪录都会被删除', rl.desc.x, rl.desc.y, {
      font: `14px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
    });
    drawButton(ctx, this.resetRects.cancel, '取消', { variant: 'primary', fontSize: 19 });
    drawButton(ctx, this.resetRects.confirm, '确认清空', { variant: 'danger', fontSize: 19 });
  }

  // ------------------------------------------------------------ 战绩条

  private drawStatusBar(ctx: CanvasRenderingContext2D, cx: number) {
    const saved = this.save.data;
    const cleared = LEVELS.filter(l => this.save.getLevel(l.id).completed).length;
    const stars = this.save.totalStars();
    const achCount = this.game.achievements?.count() ?? 0;

    const stats: [string, string, string][] = [
      ['关卡进度', `${cleared} / ${LEVELS.length}`, UI.color.accent],
      ['星星', `${stars} / ${LEVELS.length * 3}`, UI.color.gold],
      ['最高连击', `${saved.maxComboEver}`, UI.color.lemon],
      ['无尽纪录', `${Math.round(saved.endlessBestDistance / 50)} m`, UI.color.sky],
      ['成就', `${achCount} / ${ACHIEVEMENTS.length}`, UI.color.grape],
    ];

    const cw = 112, cgap = 12, cy = 412, ch = 44;
    let x = cx - (cw * stats.length + cgap * (stats.length - 1)) / 2;
    for (const [label, value, accent] of stats) {
      drawStatChip(ctx, { x, y: cy, w: cw, h: ch }, label, value, accent);
      x += cw + cgap;
    }

    drawStickerText(ctx, isCoarsePointer() ? '点击卡片开始 · 右上角齿轮可设置' : '↑↓←→ 选择 · 回车确认 · 右上角齿轮设置',
      cx, 514, {
        font: `bold 12px ${UI.font.ui}`,
        fill: UI.color.text,
        stroke: UI.color.rim,
        lineWidth: 5,
        align: 'center',
      });

    // 构建标识：右下角常驻，方便确认安装的是哪一版
    drawStickerText(ctx, `build ${__BUILD_STAMP__}`, GAME_CONFIG.CANVAS_WIDTH - 14, 524, {
      font: `11px ${UI.font.mono}`,
      fill: UI.color.sub,
      stroke: UI.color.rim,
      lineWidth: 4,
      align: 'right',
    });
  }
}

/** 马蹄磁铁徽记：左红右蓝，深靛描边 */
function drawMagnet(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  const R = 17, t = 10, legH = 16;
  const shape = () => {
    ctx.beginPath();
    ctx.arc(0, 0, R, Math.PI, 0);
    ctx.arc(0, 0, R - t, 0, Math.PI, true);
    ctx.closePath();
    ctx.rect(-R, 0, t, legH);
    ctx.rect(R - t, 0, t, legH);
  };

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.save();
  shape();
  ctx.clip();
  ctx.fillStyle = COLORS.RED;
  ctx.fillRect(-R - 4, -R - 4, R + 4, R * 2 + legH + 8);
  ctx.fillStyle = COLORS.BLUE;
  ctx.fillRect(0, -R - 4, R + 4, R * 2 + legH + 8);
  ctx.restore();

  ctx.save();
  shape();
  ctx.strokeStyle = UI.ink;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = UI.paper;
  ctx.strokeStyle = UI.ink;
  ctx.lineWidth = 2.5;
  for (const lx of [-R, R - t]) {
    ctx.beginPath();
    ctx.roundRect(lx, legH - 6, t, 8, 3);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** 卡通矢量图标（以中心定位，s 为图标外接尺寸） */
function drawIcon(ctx: CanvasRenderingContext2D, kind: IconKind, cx: number, cy: number, s: number, color: string) {
  const h = s / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  switch (kind) {
    case 'endless': {
      ctx.beginPath(); ctx.arc(-h * 0.46, 0, h * 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(h * 0.46, 0, h * 0.5, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'online': {
      ctx.beginPath(); ctx.arc(0, h * 0.55, h * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, h * 0.55, h * 0.55, Math.PI * 1.22, Math.PI * 1.78); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, h * 0.55, h * 0.92, Math.PI * 1.26, Math.PI * 1.74); ctx.stroke();
      break;
    }
    case 'levels': {
      const q = h * 0.36, off = h * 0.58;
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
        ctx.beginPath();
        ctx.roundRect(dx * off - q, dy * off - q, q * 2, q * 2, 2.5);
        ctx.fill();
      }
      break;
    }
    case 'create': {
      const w = h * 0.36;
      ctx.save();
      ctx.rotate(-Math.PI / 4);
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h * 0.74, w, h * 1.1, 2.5);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-w / 2, h * 0.36);
      ctx.lineTo(0, h * 0.94);
      ctx.lineTo(w / 2, h * 0.36);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'trophy': {
      const outer = h * 0.98, inner = h * 0.44;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? outer : inner;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'daily': {
      const w = h * 1.2, hh = h * 1.0;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -hh * 0.32, w, hh * 0.92, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-w * 0.24, hh * 0.86);
      ctx.lineTo(0, hh * 0.24);
      ctx.lineTo(w * 0.24, hh * 0.86);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'settings': {
      const rr = h * 0.55;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, h * 0.2, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        ctx.lineTo(Math.cos(a) * (rr + h * 0.26), Math.sin(a) * (rr + h * 0.26));
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

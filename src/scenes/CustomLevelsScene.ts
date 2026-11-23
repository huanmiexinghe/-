// 自定义关卡列表：新建 / 试玩 / 编辑 / 删除 / 导入码 —— 卡通主题
//
// 视觉语言：卡通天空背景 + drawHeader 标题 + 卡通白底关卡卡（左侧彩色图标槽，
// 行内三个小按钮走 drawButton，删除为危险色）。
// 命中判定与动作列表沿用旧版：顶部按钮取 headerButtons()，关卡行按钮取 rowButtons(i)，
// 二者与渲染共用同一组 x/w 数值，务必保持一致。

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { GAME_CONFIG } from '../data/config';
import { CustomLevelStore, customToLevelDef } from '../systems/CustomLevels';
import { UI, UIButtonVariant, UIRect } from '../ui/theme';
import {
  drawMenuBackground, drawHeader, drawButton, drawStickerText,
  drawStatusToast, toonShape,
} from '../ui/widgets';
import { EditorScene } from './EditorScene';
import { GameScene } from './GameScene';
import { MenuScene } from './MenuScene';
import { classifyShareCode, downloadLevel } from '../net/LevelShare';
import { openTextInput } from '../ui/TextInput';
import { openSharePanel } from '../ui/SharePanel';

interface RowBtn { x: number; w: number; label: string; action: () => void; variant?: UIButtonVariant; }

/** 关卡行左侧图标槽的循环配色 */
const ROW_ACCENTS = [UI.color.grape, UI.color.mint, UI.color.sky, UI.color.lemon, UI.color.accent];

export class CustomLevelsScene extends Scene {
  private store = new CustomLevelStore();
  private time = 0;
  private status = '';
  private statusTimer = 0;
  private statusKind: 'info' | 'error' = 'info';

  constructor(private game: Game) { super(); }

  onEnter() {
    this.game.input.setTouchLayout('menu');
    this.game.input.onTap = (x, y) => this.handleClick(x, y);
  }

  onExit() {
    this.game.input.onTap = null;
  }

  private setStatus(s: string, kind: 'info' | 'error' = 'info') {
    this.status = s;
    this.statusTimer = 2.5;
    this.statusKind = kind;
  }

  private headerButtons(): RowBtn[] {
    return [
      { x: 12, w: 120, label: '＋ 新建关卡', variant: 'primary', action: () => this.game.switchScene(new EditorScene(this.game)) },
      // 统一入口：服务器 8 位分享码与旧版本地关卡码都可在这里输入（只在“下载别人的地图”这一侧保留输入框）
      { x: 142, w: 132, label: '输入分享码', variant: 'ghost', action: () => this.importShare() },
      { x: 828, w: 120, label: '返回菜单', variant: 'ghost', action: () => this.game.switchScene(new MenuScene(this.game)) },
    ];
  }

  private rowButtons(index: number): RowBtn[] {
    const data = this.store.list()[index];
    const btns: RowBtn[] = [
      { x: 584, w: 80, label: '试玩', variant: 'ghost', action: () => this.play(data.id) },
      { x: 668, w: 80, label: '编辑', variant: 'ghost', action: () => this.edit(data.id) },
    ];
    if (data.shareCode) {
      btns.push({ x: 752, w: 80, label: '取码', variant: 'ghost', action: () => this.copyShareCode(data) });
    }
    btns.push({ x: 836, w: 80, label: '删除', variant: 'danger', action: () => this.remove(data.id) });
    return btns;
  }

  private play(id: number) {
    const data = this.store.list().find(l => l.id === id);
    if (!data) return;
    const def = customToLevelDef(structuredClone(data));
    this.game.switchScene(new GameScene(this.game, {
      def,
      customData: structuredClone(data),
      returnScene: () => new CustomLevelsScene(this.game),
    }));
  }

  private edit(id: number) {
    const data = this.store.list().find(l => l.id === id);
    if (!data) return;
    this.game.switchScene(new EditorScene(this.game, structuredClone(data)));
  }

  private remove(id: number) {
    const data = this.store.list().find(l => l.id === id);
    if (!data) return;
    if (!window.confirm(`删除关卡「${data.name}」？`)) return;
    this.store.delete(id);
    this.setStatus('已删除');
    this.game.audio.playUIClick();
  }

  /**
   * 统一导入入口（应用内输入框，不用系统 prompt）：
   * - 8 位服务端分享码 → 从服务器下载（跨设备以服务端为准）
   * - 旧版 base64 长串 → 本机解码（兼容老版本导出的码）
   * - 其他内容 → 明确报错，不猜也不静默
   */
  private importShare() {
    openTextInput({
      title: '输入好友的分享码',
      placeholder: '8 位分享码，或旧版长串关卡码',
      hint: '8 位码从服务器下载；旧版长串在本机解码',
      okLabel: '导入',
      onSubmit: (raw) => { void this.handleImport(raw); },
    });
  }

  private async handleImport(input: string) {
    const raw = input.trim();
    const kind = classifyShareCode(raw);
    if (kind === 'server') {
      await this.downloadByCode(raw.toUpperCase());
      return;
    }
    if (kind === 'legacy') {
      const decoded = this.store.decode(raw);
      if (!decoded) {
        this.setStatus('旧版关卡码已损坏或不完整，请让好友重新导出', 'error');
        return;
      }
      this.store.save(decoded);
      this.setStatus(`已导入：${decoded.name}`);
      this.game.audio.playUIClick();
      return;
    }
    this.setStatus('分享码无效：应为 8 位分享码（字母数字），或旧版长串关卡码', 'error');
  }

  /** 按分享码从服务器拉取他人地图，保存到「我的地图」并直接载入编辑器 */
  private async downloadByCode(code: string) {
    this.setStatus('正在从服务器下载…');
    try {
      const data = await downloadLevel(code);
      if (!data) { this.setStatus('分享码不存在或已过期', 'error'); return; }
      this.store.save(data);
      this.setStatus(`已下载：${data.name}（分享码 ${data.shareCode}）`);
      this.game.audio.playUIClick();
      this.game.switchScene(new EditorScene(this.game, structuredClone(data)));
    } catch (err) {
      this.setStatus(`下载失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** 「我的地图」里再次取码：与应用内分享码面板同一套 UI（大字 + 复制 + 反馈 + 关闭） */
  private copyShareCode(data: { shareCode?: string }) {
    if (!data.shareCode) return;
    openSharePanel(data.shareCode);
  }

  private handleClick(x: number, y: number) {
    // 顶部按钮
    if (y < 60) {
      for (const b of this.headerButtons()) {
        if (x >= b.x && x <= b.x + b.w) { this.game.audio.playUIClick(); b.action(); return; }
      }
      return;
    }
    // 关卡行
    const list = this.store.list();
    const rowH = 64;
    const startY = 80;
    const idx = Math.floor((y - startY) / rowH);
    if (idx >= 0 && idx < list.length) {
      for (const b of this.rowButtons(idx)) {
        if (x >= b.x && x <= b.x + b.w) { this.game.audio.playUIClick(); b.action(); return; }
      }
    }
  }

  update(dt: number) {
    this.time += dt;
    if (this.statusTimer > 0) this.statusTimer -= dt;
    if (this.game.input.isKeyPressed('Escape')) {
      this.game.switchScene(new MenuScene(this.game));
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;

    // 卡通天空背景
    drawMenuBackground(ctx, this.time);
    drawHeader(ctx, '自定义关卡');

    // 顶部按钮（新建 / 导入 / 返回）
    for (const b of this.headerButtons()) {
      const r: UIRect = { x: b.x, y: 16, w: b.w, h: 34 };
      drawButton(ctx, r, b.label, { variant: b.variant ?? 'ghost', fontSize: UI.size.body });
    }

    // 关卡行
    const list = this.store.list();
    const startY = 80;
    const rowH = 64;
    if (list.length === 0) {
      drawStickerText(ctx, '还没有自定义关卡，点击左上角「新建关卡」开始创作！', W / 2, H / 2 - 20, {
        font: `bold 17px ${UI.font.ui}`,
        fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 5, align: 'center',
      });
      drawStickerText(ctx, '在编辑器中放置障碍 → 上传拿到分享码 → 好友输入分享码即可下载', W / 2, H / 2 + 14, {
        font: `14px ${UI.font.ui}`,
        fill: UI.color.dim, stroke: UI.color.rim, lineWidth: 5, align: 'center',
      });
    }

    list.forEach((data, i) => {
      const y = startY + i * rowH;
      const accent = ROW_ACCENTS[i % ROW_ACCENTS.length];

      // 卡通白底关卡卡
      toonShape(ctx, { x: 20, y, w: W - 40, h: rowH - 10 }, {
        fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: UI.radius.md, shadow: 5,
      });

      // 左侧彩色圆角图标槽
      const slot: UIRect = { x: 34, y: y + 5, w: 44, h: 44 };
      toonShape(ctx, slot, {
        fill: accent, stroke: UI.ink, lineWidth: 2.5, radius: UI.radius.sm,
      });
      drawRowIcon(ctx, slot);

      // 文案
      const tx = slot.x + slot.w + 16;
      drawStickerText(ctx, data.name, tx, y + 26, {
        font: `bold 18px ${UI.font.ui}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'left',
      });
      const length = data.obstacles.reduce((m, o) => Math.max(m, o.x + o.w), 0);
      const sub = data.shareCode
        ? `${data.obstacles.length} 个物件 · 长度约 ${Math.round(length / 50)}m · 分享码 ${data.shareCode}`
        : `${data.obstacles.length} 个物件 · 长度约 ${Math.round(length / 50)}m`;
      drawStickerText(ctx, sub, tx, y + 46, {
        font: `13px ${UI.font.ui}`,
        fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'left',
      });

      // 行内小按钮（试玩 / 编辑 / 删除）
      for (const b of this.rowButtons(i)) {
        const r: UIRect = { x: b.x, y: y + 11, w: b.w, h: 34 };
        drawButton(ctx, r, b.label, { variant: b.variant ?? 'ghost', fontSize: UI.size.small });
      }
    });

    // 状态提示
    if (this.statusTimer > 0) drawStatusToast(ctx, this.status, this.statusKind);
  }
}

/** 关卡行图标槽内的简易「关卡块」图标 */
function drawRowIcon(ctx: CanvasRenderingContext2D, slot: UIRect) {
  const s = slot.w;
  ctx.fillStyle = UI.paper;
  ctx.beginPath();
  ctx.roundRect(slot.x + s * 0.24, slot.y + s * 0.24, s * 0.52, s * 0.2, 3);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(slot.x + s * 0.24, slot.y + s * 0.52, s * 0.52, s * 0.2, 3);
  ctx.fill();
}
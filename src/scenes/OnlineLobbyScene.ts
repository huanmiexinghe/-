// 联机大厅：连接服务器 → 建房/加入 → 准备/选关 → 进入比赛

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { GAME_CONFIG } from '../data/config';
import { online, LevelPick, DEFAULT_SERVER_URL, roomCodeCopyUi } from '../net/OnlineManager';
import { copyText } from '../net/LevelShare';
import {
  clearStoredServerUrl, getStoredServerUrl, normalizeServerUrl, setStoredServerUrl,
} from '../net/ServerUrl';
import { LEVELS, getLevel } from '../data/levels';
import { CustomLevelStore } from '../systems/CustomLevels';
import { GameScene } from './GameScene';
import { MenuScene } from './MenuScene';
import { UI, UIRect } from '../ui/theme';
import {
  drawMenuBackground, drawHeader, drawBackButton, drawFooterHint,
  drawToonCard, drawStickerText, drawButton, drawField, drawFieldLabel, drawStatusToast,
  BACK_RECT, enterAnim,
} from '../ui/widgets';

const LS_NAME = 'mr_player_name';

const ERROR_TEXT: Record<string, string> = {
  ROOM_NOT_FOUND: '房间不存在，请核对6位房间码',
  ROOM_FULL: '房间已满（最多4人）',
  ROOM_IN_RACE: '比赛已经开始，请等这局结束',
};

class FieldOverlay {
  private el: HTMLInputElement;
  private rect: UIRect = { x: 0, y: 0, w: 0, h: 0 };
  private onChange: ((v: string) => void) | null = null;
  private onEnter: ((v: string) => void) | null = null;
  private openFlag = false;

  constructor() {
    const el = document.createElement('input');
    el.type = 'text';
    el.style.cssText = [
      'position:fixed', 'z-index:50', 'display:none',
      `background:${UI.ink}`, `border:1.5px solid ${UI.color.accent}`,
      'border-radius:8px', `color:${UI.paper}`, 'outline:none',
      'text-align:center', 'box-sizing:border-box', 'padding:0 10px',
      'font-family:Consolas,monospace',
    ].join(';');
    el.addEventListener('input', () => this.onChange?.(el.value));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.onEnter?.(el.value); this.close(); }
    });
    el.addEventListener('blur', () => this.close());
    document.getElementById('app')?.appendChild(el);
    this.el = el;
  }

  get isOpen() { return this.openFlag; }

  open(rect: UIRect, value: string, opts: {
    numeric?: boolean; maxLen?: number;
    onChange: (v: string) => void; onEnter?: (v: string) => void;
  }) {
    this.rect = rect;
    this.onChange = opts.onChange;
    this.onEnter = opts.onEnter ?? null;
    this.el.value = value;
    this.el.inputMode = opts.numeric ? 'numeric' : 'text';
    this.el.maxLength = opts.maxLen ?? 40;
    this.reposition();
    this.el.style.display = 'block';
    this.openFlag = true;
    setTimeout(() => { this.el.focus(); this.el.select(); }, 30);
  }

  close() {
    this.openFlag = false;
    this.el.style.display = 'none';
    this.el.blur();
  }

  reposition(canvas?: HTMLCanvasElement) {
    if (!this.openFlag) return;
    const c = canvas ?? document.querySelector('canvas');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const sx = r.width / GAME_CONFIG.CANVAS_WIDTH;
    const sy = r.height / GAME_CONFIG.CANVAS_HEIGHT;
    this.el.style.left = `${r.left + this.rect.x * sx}px`;
    this.el.style.top = `${r.top + this.rect.y * sy}px`;
    this.el.style.width = `${this.rect.w * sx}px`;
    this.el.style.height = `${this.rect.h * sy}px`;
    this.el.style.fontSize = `${Math.max(13, this.rect.h * sy * 0.5)}px`;
  }
}

export class OnlineLobbyScene extends Scene {
  private view: 'connect' | 'room' = 'connect';
  private url = getStoredServerUrl();
  private name = localStorage.getItem(LS_NAME) ?? '';
  private code = '';
  private joinMode = false;
  // 配置了默认服务器且没有保存的自定义地址时走简化模式（只输昵称+房间码）；
  // 保存过自定义地址（含上次启动）则直接进入完整模式并预填该地址
  private useCustomServer = DEFAULT_SERVER_URL === '' || getStoredServerUrl() !== '';
  private busy = false;
  private status = '';
  private builtinIds = LEVELS.map(l => l.id);
  private overlay = new FieldOverlay();
  private unsubs: (() => void)[] = [];
  private time = 0;
  private enterTime = 0;
  private mx = -1; private my = -1;
  /** 复制房间号成功后的「已复制」反馈剩余时间（秒） */
  private copyFlash = 0;

  constructor(private game: Game) { super(); }

  onEnter() {
    this.time = 0;
    this.enterTime = 0;
    this.game.input.setTouchLayout('menu');
    this.game.input.onTap = (x, y) => this.handleTap(x, y);
    this.game.input.onMove = (x, y) => { this.mx = x; this.my = y; };
    this.view = online.inRoom ? 'room' : 'connect';
    this.status = online.lastError ? (ERROR_TEXT[online.lastError] ?? online.lastError) : '';

    this.unsubs = [
      online.on('room', () => { this.status = ''; this.view = 'room'; }),
      online.on('start', () => {
        this.game.switchScene(new GameScene(this.game, {
          online: { pick: online.pick, startAt: online.startAt },
        }));
      }),
      online.on('lobby', () => { this.view = 'room'; }),
      online.on('closed', () => {
        this.view = 'connect';
        // 连接尝试进行中由 doConnectAnd 给出具体错误，不覆盖
        if (!this.busy) this.status = '与服务器的连接已断开';
      }),
      online.on('error', (code: string) => {
        this.busy = false;
        this.status = ERROR_TEXT[code] ?? code;
      }),
    ];
  }

  onExit() {
    this.game.input.onTap = null;
    this.game.input.onMove = null;
    this.overlay.close();
    this.unsubs.forEach(fn => fn());
    this.unsubs = [];
  }

  update(dt: number) {
    this.time += dt;
    this.enterTime += dt;
    if (this.copyFlash > 0) this.copyFlash = Math.max(0, this.copyFlash - dt);
    this.overlay.reposition(this.game.canvas);
  }

  /** 房主复制房间号：失败时保留房间号在屏上并提示手抄 */
  private async copyRoomCode() {
    const code = online.room;
    if (!code) return;
    if (await copyText(code)) {
      this.copyFlash = 1.8;
      this.status = '';
    } else {
      this.status = '复制失败 · 请手动抄写上方房间号';
    }
  }

  private roomCopyRect(cx: number): UIRect {
    return { x: cx + 120, y: 76, w: 168, h: 56 };
  }

  private async doConnectAnd(action: () => void) {
    if (this.busy) return;
    const parsed = normalizeServerUrl(this.useCustomServer ? this.url : DEFAULT_SERVER_URL);
    if (!parsed.ok) { this.status = parsed.error; return; }
    const u = parsed.wsUrl;
    const nm = this.name.trim();
    if (!nm) { this.status = '请填写昵称'; return; }
    if (this.useCustomServer) setStoredServerUrl(u);
    localStorage.setItem(LS_NAME, nm);
    this.busy = true;
    this.status = '正在连接服务器…';
    try {
      if (!online.connected) await online.connect(u);
      action();
      this.status = '';
    } catch (e) {
      this.status = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private levelName(): string {
    const p = online.pick;
    if (p.kind === 'builtin') {
      const lv = getLevel(p.id);
      return lv ? `内置 · 第${p.id}关 ${lv.name}` : `内置 · 第${p.id}关`;
    }
    return `自定义 · ${p.name}`;
  }

  private cycleLevel(delta: number) {
    if (online.pick.kind === 'custom') {
      online.selectLevel({ kind: 'builtin', id: this.builtinIds[0] });
      return;
    }
    const ids = this.builtinIds;
    const idx = ids.indexOf(online.pick.id);
    const next = ids[(idx + delta + ids.length) % ids.length] ?? 1;
    online.selectLevel({ kind: 'builtin', id: next });
  }

  private inRect(r: UIRect, x: number, y: number) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  private handleTap(x: number, y: number) {
    if (this.view === 'connect') this.tapConnect(x, y);
    else this.tapRoom(x, y);
  }

  private tapConnect(x: number, y: number) {
    const cx = GAME_CONFIG.CANVAS_WIDTH / 2;
    if (this.inRect(BACK_RECT, x, y)) {
      this.game.audio.playUIClick();
      this.game.switchScene(new MenuScene(this.game));
      return;
    }
    if (!this.useCustomServer) { this.tapConnectSimple(x, y); return; }
    // 完整模式：右下角小字可切回默认服务器
    if (DEFAULT_SERVER_URL && this.inRect({ x: cx + 90, y: 488, w: 200, h: 30 }, x, y)) {
      this.game.audio.playUIClick();
      // 恢复默认 = 清掉已保存的覆盖地址，下次启动也回到默认服务器
      clearStoredServerUrl();
      this.useCustomServer = false;
      this.status = '';
      return;
    }
    const urlRect: UIRect = { x: cx - 210, y: 178, w: 420, h: 46 };
    const nameRect: UIRect = { x: cx - 210, y: 258, w: 420, h: 46 };
    const createRect: UIRect = { x: cx - 210, y: 336, w: 200, h: 56 };
    const joinRect: UIRect = { x: cx + 10, y: 336, w: 200, h: 56 };
    const codeRect: UIRect = { x: cx - 100, y: 428, w: 200, h: 46 };

    if (this.inRect(urlRect, x, y)) {
      this.overlay.open(urlRect, this.url, { maxLen: 120, onChange: v => { this.url = v; } });
      return;
    }
    if (this.inRect(nameRect, x, y)) {
      this.overlay.open(nameRect, this.name, { maxLen: 12, onChange: v => { this.name = v; } });
      return;
    }
    if (this.inRect(createRect, x, y)) {
      this.game.audio.playUIClick();
      this.doConnectAnd(() => online.createRoom(this.name.trim()));
      return;
    }
    if (this.inRect(joinRect, x, y)) {
      this.game.audio.playUIClick();
      if (!this.joinMode) { this.joinMode = true; return; }
      if (this.code.length !== 6) { this.status = '请输入6位房间码'; return; }
      this.doConnectAnd(() => online.joinRoom(this.code, this.name.trim()));
      return;
    }
    if (this.joinMode && this.inRect(codeRect, x, y)) {
      this.overlay.open(codeRect, this.code, {
        maxLen: 6,
        onChange: v => { this.code = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); },
        onEnter: () => {
          if (this.code.length === 6) this.doConnectAnd(() => online.joinRoom(this.code, this.name.trim()));
        },
      });
    }
  }

  /** 简化模式（已配置默认服务器）：昵称 + 房间码，一键加入/创建 */
  private tapConnectSimple(x: number, y: number) {
    const cx = GAME_CONFIG.CANVAS_WIDTH / 2;
    const nameRect: UIRect = { x: cx - 210, y: 200, w: 420, h: 46 };
    const codeRect: UIRect = { x: cx - 210, y: 280, w: 420, h: 52 };
    const joinRect: UIRect = { x: cx - 210, y: 356, w: 420, h: 60 };
    const createRect: UIRect = { x: cx - 210, y: 428, w: 420, h: 46 };
    const switchRect: UIRect = { x: cx + 90, y: 488, w: 200, h: 30 };

    if (this.inRect(nameRect, x, y)) {
      this.overlay.open(nameRect, this.name, { maxLen: 12, onChange: v => { this.name = v; } });
      return;
    }
    if (this.inRect(codeRect, x, y)) {
      this.overlay.open(codeRect, this.code, {
        maxLen: 6,
        onChange: v => { this.code = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); },
        onEnter: () => this.tryJoin(),
      });
      return;
    }
    if (this.inRect(joinRect, x, y)) {
      this.game.audio.playUIClick();
      this.tryJoin();
      return;
    }
    if (this.inRect(createRect, x, y)) {
      this.game.audio.playUIClick();
      this.doConnectAnd(() => online.createRoom(this.name.trim()));
      return;
    }
    if (this.inRect(switchRect, x, y)) {
      this.game.audio.playUIClick();
      this.useCustomServer = true;
      this.status = '';
    }
  }

  private tryJoin() {
    if (this.code.length !== 6) { this.status = '请输入6位房间码'; return; }
    this.doConnectAnd(() => online.joinRoom(this.code, this.name.trim()));
  }

  private tapRoom(x: number, y: number) {
    const cx = GAME_CONFIG.CANVAS_WIDTH / 2;
    if (this.inRect(BACK_RECT, x, y)) {
      this.game.audio.playUIClick();
      online.leaveRoom();
      online.disconnect();
      this.view = 'connect';
      this.joinMode = false;
      return;
    }
    // 房主专属：复制房间号（非房主不绘制也不命中）
    if (online.isHost && online.phase !== 'race' && this.inRect(this.roomCopyRect(cx), x, y)) {
      this.game.audio.playUIClick();
      void this.copyRoomCode();
      return;
    }
    if (online.phase === 'race') {
      if (online.isHost && this.inRect({ x: cx - 170, y: 400, w: 340, h: 60 }, x, y)) {
        this.game.audio.playUIClick();
        online.backToLobby();
      }
      return;
    }
    if (online.isHost) {
      if (this.inRect({ x: cx - 236, y: 300, w: 48, h: 46 }, x, y)) { this.game.audio.playUIClick(); this.cycleLevel(-1); return; }
      if (this.inRect({ x: cx + 188, y: 300, w: 48, h: 46 }, x, y)) { this.game.audio.playUIClick(); this.cycleLevel(1); return; }
      if (this.inRect({ x: cx - 120, y: 356, w: 240, h: 38 }, x, y)) {
        const rect: UIRect = { x: cx - 260, y: 240, w: 520, h: 42 };
        this.overlay.open(rect, online.pick.kind === 'custom' ? online.pick.code : '', {
          maxLen: 200000,
          onChange: () => { },
          onEnter: (v) => {
            const data = new CustomLevelStore().decode(v);
            if (!data) { this.status = '关卡码无效'; return; }
            online.selectLevel({ kind: 'custom', name: data.name, code: v.trim() });
            this.status = '';
          },
        });
        this.status = '粘贴自定义关卡码后按回车';
        return;
      }
      if (this.inRect({ x: cx - 140, y: 424, w: 280, h: 64 }, x, y)) {
        this.game.audio.playUIClick();
        online.requestStart();
        return;
      }
    } else {
      const me = online.players.find(p => p.id === online.selfId);
      if (this.inRect({ x: cx - 140, y: 424, w: 280, h: 64 }, x, y)) {
        this.game.audio.playUIClick();
        online.setReady(!me?.ready);
      }
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    drawMenuBackground(ctx, this.time);
    if (this.view === 'connect') this.renderConnect(ctx, W, H);
    else this.renderRoom(ctx, W, H);
  }

  /** 在渲染层把当前提示文案分类为 info / error（不改动业务侧赋值逻辑） */
  private statusKind(): 'info' | 'error' {
    const s = this.status;
    if (!s) return 'info';
    // 连接进度与操作指引属于提示，其余（连接失败/校验/服务器错误码）按错误展示
    if (s.startsWith('正在连接') || s.startsWith('粘贴')) return 'info';
    return 'error';
  }

  private renderConnect(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const cx = W / 2;
    const { alpha, scale } = enterAnim(this.enterTime);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -H / 2);

    drawHeader(ctx, '联机竞速', '各自跑各自的 · 同屏残影 · 实时排名 · 完赛可观战');
    drawBackButton(ctx, this.inRect(BACK_RECT, this.mx, this.my));

    if (!this.useCustomServer) {
      this.renderConnectSimple(ctx, cx);
      ctx.restore();
      return;
    }

    drawFieldLabel(ctx, '服务器地址', cx - 210, 168);
    drawField(ctx, { x: cx - 210, y: 178, w: 420, h: 46 }, this.url, 'ws://服务器地址:8080', this.overlay.isOpen);

    drawFieldLabel(ctx, '昵称', cx - 210, 248);
    drawField(ctx, { x: cx - 210, y: 258, w: 420, h: 46 }, this.name, '输入你的昵称', this.overlay.isOpen);

    drawButton(ctx, { x: cx - 210, y: 336, w: 200, h: 56 }, '创建房间', { variant: 'primary', state: this.busy ? 'disabled' : 'normal' });
    drawButton(ctx, { x: cx + 10, y: 336, w: 200, h: 56 }, '加入房间', { variant: 'ghost', state: this.busy ? 'disabled' : 'normal' });

    if (this.joinMode) {
      drawFieldLabel(ctx, '6位房间码', cx - 100, 418);
      drawField(ctx, { x: cx - 100, y: 428, w: 200, h: 46 }, this.code, 'ABC123', this.overlay.isOpen);
    }

    if (this.status) drawStatusToast(ctx, this.status, this.statusKind());
    drawFooterHint(ctx, '所有玩家填同一个服务器地址 · 房主建房后把6位房间码发给朋友');
    if (DEFAULT_SERVER_URL) {
      drawStickerText(ctx, '‹ 使用默认服务器', cx + 190, 508, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`,
        fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
    }
    ctx.restore();
  }

  /** 简化模式渲染：只填昵称 + 房间码 */
  private renderConnectSimple(ctx: CanvasRenderingContext2D, cx: number) {
    drawFieldLabel(ctx, '昵称', cx - 210, 190);
    drawField(ctx, { x: cx - 210, y: 200, w: 420, h: 46 }, this.name, '输入你的昵称', this.overlay.isOpen);

    drawFieldLabel(ctx, '房间码（加入好友房间时填写）', cx - 210, 270);
    drawField(ctx, { x: cx - 210, y: 280, w: 420, h: 52 }, this.code, '6位房间码', this.overlay.isOpen);

    drawButton(ctx, { x: cx - 210, y: 356, w: 420, h: 60 }, '加 入 房 间', {
      variant: 'primary', state: this.busy ? 'disabled' : 'normal', fontSize: UI.size.h2,
    });
    drawButton(ctx, { x: cx - 210, y: 428, w: 420, h: 46 }, '创建新房间', {
      variant: 'ghost', state: this.busy ? 'disabled' : 'normal',
    });

    drawStickerText(ctx, '使用自建服务器 ›', cx + 190, 508, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`,
      fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
    });

    if (this.status) drawStatusToast(ctx, this.status, this.statusKind());
    drawFooterHint(ctx, '只需昵称+房间码即可联机 · 创建房间后把6位房间码发给朋友');
  }

  private renderRoom(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const cx = W / 2;
    const { alpha, scale } = enterAnim(this.enterTime);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -H / 2);

    drawBackButton(ctx, this.inRect(BACK_RECT, this.mx, this.my));

    drawStickerText(ctx, online.room || '------', cx, 100, {
      font: `bold 48px ${UI.font.mono}`,
      fill: UI.color.text, stroke: UI.color.rim, lineWidth: 8, align: 'center',
    });
    drawStickerText(ctx, '房间码 · 把房间码发给朋友即可加入', cx, 126, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`,
      fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 5, align: 'center',
    });

    // 房主专属：房间号旁边提供复制按钮；房间号本身始终完整可见，复制失败也能手抄
    const copyUi = roomCodeCopyUi(online.isHost && online.phase !== 'race', this.copyFlash > 0);
    if (copyUi.visible) {
      drawButton(ctx, this.roomCopyRect(cx), copyUi.label, {
        variant: this.copyFlash > 0 ? 'ghost' : 'primary', fontSize: UI.size.small,
      });
    }

    const cardW = 200, gap = 16;
    const totalW = 4 * cardW + 3 * gap;
    const startX = cx - totalW / 2;
    for (let i = 0; i < 4; i++) {
      const px = startX + i * (cardW + gap);
      const py = 150;
      const p = online.players[i];
      // 房主用金色描边、自己用天蓝描边，其余为普通白卡
      const isSelf = !!p && p.id === online.selfId;
      const isHost = !!p && p.host;
      const accent = isHost ? UI.color.charge : (isSelf ? UI.color.accent2 : UI.color.accent);
      drawToonCard(ctx, { x: px, y: py, w: cardW, h: 110 }, { accent, selected: isHost || isSelf });
      if (p) {
        drawStickerText(ctx, (p.host ? '房主 · ' : '') + p.name, px + cardW / 2, py + 46, {
          font: `bold 18px ${UI.font.ui}`,
          fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'center',
        });
        drawStickerText(ctx, p.ready ? '已准备' : '未准备', px + cardW / 2, py + 76, {
          font: `bold ${UI.size.small}px ${UI.font.ui}`,
          fill: p.ready ? UI.color.successInk : UI.color.dim,
          stroke: UI.color.rim, lineWidth: 4, align: 'center',
        });
      } else {
        drawStickerText(ctx, '等待加入…', px + cardW / 2, py + 62, {
          font: `${UI.size.small}px ${UI.font.ui}`,
          fill: UI.color.dim, stroke: UI.color.rim, lineWidth: 4, align: 'center',
        });
      }
    }

    if (online.phase === 'race') {
      drawStickerText(ctx, '比赛进行中', cx, 330, {
        font: `bold ${UI.size.h2}px ${UI.font.ui}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 6, align: 'center',
      });
      if (online.isHost) {
        drawButton(ctx, { x: cx - 170, y: 400, w: 340, h: 60 }, '结束比赛 · 全体返回大厅', { variant: 'primary' });
      } else {
        drawStickerText(ctx, '等待房主结束本场比赛…', cx, 430, {
          font: `bold ${UI.size.small}px ${UI.font.ui}`,
          fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 5, align: 'center',
        });
      }
      ctx.restore();
      return;
    }

    drawFieldLabel(ctx, '比赛关卡', cx - 236, 290);
    if (online.isHost) {
      drawButton(ctx, { x: cx - 236, y: 300, w: 48, h: 46 }, '‹', { variant: 'ghost' });
      drawField(ctx, { x: cx - 182, y: 300, w: 364, h: 46 }, this.levelName(), '');
      drawButton(ctx, { x: cx + 188, y: 300, w: 48, h: 46 }, '›', { variant: 'ghost' });
      drawButton(ctx, { x: cx - 120, y: 356, w: 240, h: 38 }, '使用自定义关卡码', { variant: 'ghost', fontSize: UI.size.small });
      drawButton(ctx, { x: cx - 140, y: 424, w: 280, h: 64 }, '开 始 比 赛', { variant: 'primary', fontSize: UI.size.h2 });
      drawStickerText(ctx, '点击开始后全员3秒倒计时统一出发', cx, 510, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`,
        fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
    } else {
      drawField(ctx, { x: cx - 182, y: 300, w: 364, h: 46 }, this.levelName(), '');
      const me = online.players.find(p => p.id === online.selfId);
      drawButton(ctx, { x: cx - 140, y: 424, w: 280, h: 64 }, me?.ready ? '取 消 准 备' : '准 备', {
        variant: me?.ready ? 'ghost' : 'primary', fontSize: UI.size.h2,
      });
      drawStickerText(ctx, '房主开始后自动进入比赛', cx, 510, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`,
        fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
    }

    if (this.status) drawStatusToast(ctx, this.status, this.statusKind());
    ctx.restore();
  }
}

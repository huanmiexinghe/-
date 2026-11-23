// 关卡编辑器：放置/擦除障碍、滚动浏览、试玩、保存、关卡码导入导出

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { COLORS, GAME_CONFIG } from '../data/config';
import { Obstacle, ObstacleConfig, ObstacleKind } from '../entities/Obstacle';
import { CustomLevelData, CustomLevelStore, customToLevelDef } from '../systems/CustomLevels';
import {
  EDITOR_CATEGORIES, EDITOR_LAYOUT, EDITOR_TOOLS, EditorToolDef, ToolCategoryId, ToolId,
  clampToolScroll, categoryTabAt, maxToolScroll, tabRect, toolContentWidth, toolIndexAt, toolsOf,
} from '../systems/EditorTools';
import {
  DEFAULT_EDITOR_PARAMS, EditHistory, EditorParams, EditorSnapshot, PortalPending,
} from '../systems/EditHistory';
import { MECH } from '../systems/Mechanics';
import { copyText, uploadLevel, sharePanelModel } from '../net/LevelShare';
import { withAlpha } from '../utils/Color';
import { UI } from '../ui/theme';
import {
  drawMenuBackground, drawButton, drawStickerText, toonShape,
} from '../ui/widgets';
import { GameScene } from './GameScene';
import { CustomLevelsScene } from './CustomLevelsScene';

const L = EDITOR_LAYOUT;
const TOP_H = L.topH;
const BOTTOM_Y = 498;
const GROUND = GAME_CONFIG.GROUND_Y;
const CEIL = GAME_CONFIG.CEILING_Y;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

interface Btn {
  label: string;
  x: number;
  w: number;
  action: () => void;
  enabled?: () => boolean;
}

export class EditorScene extends Scene {
  private data: CustomLevelData;
  private store = new CustomLevelStore();
  private tool: ToolId = 'RED_SPIKE';
  private cameraX = 0;
  private mouse: { x: number; y: number } | null = null;
  private portalSeq = 1;
  private pendingPortal: PortalPending | null = null;
  private status = '';
  private statusTimer = 0;
  private time = 0;
  private buttons: Btn[] = [];
  /** 撤销栈：20 步快照（放置/删除/移动参数/清空等变更前调用 push） */
  private history = new EditHistory();

  // 顶部工具栏：分类 + 单行工具（可左右拖动、带惯性）
  private category: ToolCategoryId = 'hazard';
  private toolScroll = 0;
  /** 滚动速度（px/s，正值向右滚），抬起后用于惯性 */
  private toolVx = 0;
  private toolDrag: {
    x0: number; scroll0: number; lastX: number; lastT: number; moved: boolean;
  } | null = null;
  /** 顶部上传进行中，避免重复提交 */
  private uploading = false;
  /** 上传成功后自动展示的服务端分享码（空 = 不显示面板） */
  private shareCode = '';
  /** 最近一次复制分享码的时间（this.time，用于按钮反馈） */
  private shareCopyAt = -1;
  /** 上次上传时的内容指纹：内容变了就要重新上传拿新码 */
  private lastUploadFingerprint = '';

  // FR-11 参数面板（新障碍的可调参数）
  private params: EditorParams = structuredClone(DEFAULT_EDITOR_PARAMS);
  private paramHits: { x: number; y: number; w: number; h: number; apply: () => void }[] = [];
  /** 复用已渲染的障碍实例，避免每帧 new */
  private obstacleCache = new WeakMap<object, Obstacle>();
  /** 幽灵预览单实例复用 */
  private previewInstance: Obstacle | null = null;
  private previewKey = '';

  constructor(private game: Game, existing?: CustomLevelData) {
    super();
    this.data = existing
      ? structuredClone(existing)
      : { id: 0, name: '我的关卡', obstacles: [], createdAt: Date.now() };
    // 从已有数据推断传送门序号
    const ids = this.data.obstacles
      .map(o => (o.meta?.portalId as number) ?? 0)
      .filter(n => typeof n === 'number');
    this.portalSeq = (ids.length ? Math.max(...ids) : 0) + 1;
    // 保持当前工具的所属分类，避免打开后工具行与选中态不一致
    this.category = this.toolCategory(this.tool);
  }

  onEnter() {
    this.time = 0;
    // 旧地图带分享码时，初始内容视为与服务器一致（可直接再次展示码）
    this.lastUploadFingerprint = this.data.shareCode ? this.obstaclesFingerprint() : '';
    this.game.input.setTouchLayout('menu');
    this.buttons = [
      { label: '试玩', x: 12, w: 78, action: () => this.playTest() },
      { label: '保存', x: 96, w: 78, action: () => this.saveLevel() },
      {
        label: '撤销', x: 180, w: 78, action: () => this.undo(),
        enabled: () => this.history.canUndo,
      },
      { label: '清空', x: 264, w: 78, action: () => this.clearAll() },
      { label: '上传', x: 348, w: 78, action: () => this.uploadToServer() },
      { label: '分享码', x: 432, w: 84, action: () => this.exportShare() },
      { label: '◀', x: 602, w: 48, action: () => this.scroll(-320) },
      { label: '▶', x: 656, w: 48, action: () => this.scroll(320) },
      { label: '返回', x: 858, w: 90, action: () => this.back() },
    ];

    this.game.input.onTap = (x, y) => this.handleClick(x, y);
    this.game.input.onMove = (x, y) => this.handleMove(x, y);
    this.game.input.onPointerDown = (x, y) => this.handlePointerDown(x, y);
    this.game.input.onPointerUp = () => this.handlePointerUp();
    this.game.input.onWheel = (dy) => { this.scroll(dy * 140); };
  }

  onExit() {
    this.game.input.onTap = null;
    this.game.input.onMove = null;
    this.game.input.onPointerDown = null;
    this.game.input.onPointerUp = null;
    this.game.input.onWheel = null;
    this.toolDrag = null;
  }

  /// 当前分类的工具列表
  private currentTools(): EditorToolDef[] {
    return toolsOf(this.category);
  }

  private toolCategory(id: ToolId): ToolCategoryId {
    return EDITOR_TOOLS.find(t => t.id === id)?.category ?? 'hazard';
  }

  private setCategory(index: number) {
    const cat = EDITOR_CATEGORIES[index];
    if (!cat || cat.id === this.category) return;
    this.category = cat.id;
    this.toolScroll = 0;
    this.toolVx = 0;
    this.toolDrag = null;
    const list = this.currentTools();
    if (!list.some(t => t.id === this.tool) && list.length > 0) {
      this.tool = list[0].id;
    }
    this.game.audio.playUIClick();
  }

  /** 记录变更前快照（撤销按钮据此精确回滚） */
  private pushHistory() {
    this.history.push({
      obstacles: this.data.obstacles,
      params: this.params,
      pendingPortal: this.pendingPortal,
      portalSeq: this.portalSeq,
      tool: this.tool,
    });
  }

  private undo() {
    const snap: EditorSnapshot | null = this.history.undo();
    if (!snap) { this.setStatus('没有可撤销的操作'); return; }
    this.data.obstacles = snap.obstacles;
    this.params = snap.params;
    this.pendingPortal = snap.pendingPortal;
    this.portalSeq = snap.portalSeq;
    this.tool = snap.tool;
    this.category = this.toolCategory(this.tool);
    this.toolScroll = clampToolScroll(this.category, this.toolScroll);
    this.toolVx = 0;
    this.previewKey = '';
    this.setStatus(`已撤销（还可撤销 ${this.history.size} 步）`);
    this.game.audio.playUIClick();
  }

  private handlePointerDown(x: number, y: number) {
    if (y >= L.toolY && y <= L.toolY + L.toolH) {
      this.toolDrag = {
        x0: x,
        scroll0: this.toolScroll,
        lastX: x,
        lastT: performance.now(),
        moved: false,
      };
      this.toolVx = 0;
    }
  }

  private handleMove(x: number, y: number) {
    this.mouse = { x, y };
    const drag = this.toolDrag;
    if (!drag) return;
    const dx = x - drag.x0;
    if (!drag.moved) {
      // 与 Input 的点击语义一致：抬起前移动不超过 12px 才算点击
      if (Math.abs(dx) <= 12) return;
      drag.moved = true;
      drag.x0 = x;
      drag.scroll0 = this.toolScroll;
      drag.lastX = x;
      drag.lastT = performance.now();
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT) / 1000;
    // 手往右拖 → 内容右移 → 偏移减小
    this.toolVx = -(x - drag.lastX) / dt;
    drag.lastX = x;
    drag.lastT = now;
    this.toolScroll = clampToolScroll(this.category, drag.scroll0 - (x - drag.x0));
  }

  private handlePointerUp() {
    this.toolDrag = null;
  }

  private setStatus(msg: string) {
    this.status = msg;
    this.statusTimer = 3;
  }

  private scroll(dx: number) {
    const maxCam = Math.max(0, this.contentRight() + 400 - GAME_CONFIG.CANVAS_WIDTH);
    this.cameraX = Math.max(0, Math.min(maxCam, this.cameraX + dx));
  }

  private contentRight(): number {
    return this.data.obstacles.reduce((m, o) => Math.max(m, o.x + o.w), 2000);
  }

  update(dt: number) {
    this.time += dt;
    if (this.statusTimer > 0) this.statusTimer -= dt;
    const input = this.game.input;
    if (input.isKeyPressed('Escape')) { this.back(); return; }
    // 撤销：Ctrl+Z / Z（KeyZ 在 Ctrl 按下时同样触发）
    if (input.isKeyPressed('KeyZ')) this.undo();
    // 键盘滚动
    if (input.isKeyDown('ArrowLeft') || input.isKeyDown('KeyA')) this.scroll(-520 * dt);
    if (input.isKeyDown('ArrowRight') || input.isKeyDown('KeyD')) this.scroll(520 * dt);
    // 工具行惯性：抬起后按速度继续滑，遇边界立即停
    if (!this.toolDrag) {
      if (Math.abs(this.toolVx) > 20) {
        const before = this.toolScroll;
        let next = this.toolScroll + this.toolVx * dt;
        next = clampToolScroll(this.category, next);
        if (next === before && Math.abs(this.toolVx) > 0) this.toolVx = 0;
        this.toolScroll = next;
        this.toolVx *= Math.exp(-3.5 * dt);
        if (Math.abs(this.toolVx) < 20) this.toolVx = 0;
      } else {
        this.toolVx = 0;
      }
    }
  }

  // ---- 操作 ----

  private handleClick(sx: number, sy: number) {
    // 分享码面板打开时优先处理，并拦截底层编辑操作
    if (this.shareCode) {
      const r = this.sharePanelRects();
      if (sx >= r.copy.x && sx <= r.copy.x + r.copy.w && sy >= r.copy.y && sy <= r.copy.y + r.copy.h) {
        this.game.audio.playUIClick();
        this.copyShareCode();
        return;
      }
      if (sx >= r.close.x && sx <= r.close.x + r.close.w && sy >= r.close.y && sy <= r.close.y + r.close.h) {
        this.game.audio.playUIClick();
        this.shareCode = '';
        return;
      }
      return;
    }
    // 顶部工具栏：先分类标签，再当前分类的工具行
    if (sy < TOP_H) {
      const tab = categoryTabAt(sx, sy);
      if (tab >= 0) { this.setCategory(tab); return; }
      const list = this.currentTools();
      const idx = toolIndexAt(this.category, sx, sy, this.toolScroll);
      if (idx >= 0 && idx < list.length) {
        this.tool = list[idx].id;
        this.game.audio.playUIClick();
      }
      return;
    }
    // 参数面板（先于放置判定，避免点按钮时把障碍放到面板下面）
    for (const h of this.paramHits) {
      if (sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h) {
        this.game.audio.playUIClick();
        h.apply();
        return;
      }
    }
    // 底部按钮
    if (sy >= BOTTOM_Y) {
      for (const b of this.buttons) {
        if (sx >= b.x && sx <= b.x + b.w) {
          if (b.enabled && !b.enabled()) return;
          this.game.audio.playUIClick();
          b.action();
          return;
        }
      }
      return;
    }
    if (sy < TOP_H + 8 || sy > GROUND + 48) return;

    const worldX = Math.round((sx + this.cameraX) / 16) * 16;
    this.applyTool(worldX, sy);
  }

  private applyTool(wx: number, sy: number) {
    const push = (o: CustomLevelData['obstacles'][number]) => {
      this.pushHistory();
      this.data.obstacles.push(o);
      this.game.audio.playSwitch('BLUE');
    };

    switch (this.tool) {
      case 'RED_SPIKE':
      case 'BLUE_SPIKE': {
        const ceiling = sy < 270;
        push({
          kind: this.tool, x: wx,
          y: ceiling ? CEIL : GROUND - 32, w: 32, h: 32,
        });
        break;
      }
      case 'WALL': {
        const h = Math.max(24, Math.min(64, GROUND - sy));
        push({ kind: 'WALL', x: wx, y: GROUND - h, w: 40, h });
        break;
      }
      case 'PORTAL_A':
      case 'PORTAL_B': {
        // 同色圆环配对：第一次放入口，第二次必须用同色工具放出口
        if (this.pendingPortal && this.pendingPortal.kind !== this.tool) {
          this.setStatus('出口必须与入口同色（只有同色圆环互相传送）');
          return;
        }
        // 配对状态与序号也会变化，快照必须在改动前记录
        this.pushHistory();
        if (!this.pendingPortal) {
          const id = this.portalSeq++;
          this.pendingPortal = { id, kind: this.tool };
          this.data.obstacles.push({
            kind: this.tool, x: wx, y: this.portalY(sy), w: 48, h: 64, meta: { portalId: id },
          });
          const name = this.tool === 'PORTAL_A' ? '紫色' : '绿色';
          this.setStatus(`${name}圆环 #${id} 已放置 — 再用 ${name}门 工具在出口处点一下`);
        } else {
          const { id } = this.pendingPortal;
          this.data.obstacles.push({
            kind: this.tool, x: wx, y: this.portalY(sy), w: 48, h: 64, meta: { portalId: id },
          });
          this.pendingPortal = null;
          this.setStatus(`同色圆环 #${id} 配对完成（地面↔天花板会自动翻转重力）`);
        }
        this.game.audio.playSwitch('BLUE');
        break;
      }
      case 'ZONE_RED':
      case 'ZONE_BLUE': {
        const p = this.tool === 'ZONE_RED' ? 'RED' : 'BLUE';
        push({ kind: 'POLARITY_ZONE', x: wx, y: CEIL, w: 64, h: GROUND - CEIL, meta: { forcedPolarity: p } });
        break;
      }
      case 'FLIP':
        push({ kind: 'GRAVITY_FLIP', x: wx, y: CEIL, w: 56, h: GROUND - CEIL });
        break;
      case 'BOOST':
        push({
          kind: 'SPEED_BOOST', x: wx, y: GROUND - 20, w: 120, h: 20,
          meta: { multiplier: this.params.boostMul, duration: this.params.boostDur },
        });
        break;
      case 'PEND_R':
      case 'PEND_B': {
        // 锚点固定在天花板；点击的纵向位置决定绳长（摆球静止点）
        const rope = clamp(Math.round(sy - CEIL), 150, 320);
        const period = clamp(this.params.pendPeriod, MECH.PEND.minPeriod, 4.0);
        push({
          kind: 'PENDULUM', x: wx, y: CEIL, w: 40, h: 40,
          meta: {
            rope,
            polarity: this.tool === 'PEND_R' ? 'RED' : 'BLUE',
            amplitude: this.params.pendAmplitude,
            swingSpeed: (Math.PI * 2) / period,
            warnLead: this.params.pendWarn,
          },
        });
        this.setStatus(`摆锤已放置（绳长 ${rope}，周期 ${period.toFixed(2)}s，预警 ${this.params.pendWarn.toFixed(2)}s）`);
        break;
      }
      case 'GEM': {
        const meta = this.params.gemColor === 'ANY' ? undefined : { color: this.params.gemColor };
        push({ kind: 'COLLECTIBLE', x: wx, y: clamp(Math.round(sy - 12), CEIL + 6, GROUND - 30), w: 24, h: 24, meta });
        this.setStatus(this.params.gemColor === 'ANY'
          ? '晶片已放置（任意极性可拾取）'
          : `晶片已放置（仅${this.params.gemColor === 'RED' ? '红' : '蓝'}色极性可拾取）`);
        break;
      }
      case 'STAR': {
        push({
          kind: 'SPECIAL_ITEM', x: wx, y: clamp(Math.round(sy - 17), CEIL + 6, GROUND - 40), w: 34, h: 34,
          meta: { itemId: 'CUSTOM_STAR', itemName: '星核' },
        });
        break;
      }
      case 'PLATFORM': {
        // 单向支撑平台：点击高度决定平台位置，宽度固定 160（可站立跳过矮墙）
        const y = clamp(Math.round(sy - 7), CEIL + 20, GROUND - 90);
        push({ kind: 'PLATFORM', x: wx, y, w: 160, h: 14 });
        this.setStatus('浮台已放置：可站立，不会阻挡左右移动');
        break;
      }
      case 'MPLAT': {
        const y = clamp(Math.round(sy - 7), CEIL + 20, GROUND - 90);
        push({
          kind: 'MOVING_PLATFORM', x: wx, y, w: 140, h: 14,
          meta: {
            axis: this.params.mplatAxis,
            range: this.params.mplatRange,
            period: this.params.mplatPeriod,
            phase: 0,
          },
        });
        this.setStatus(`移动浮台已放置（${this.params.mplatAxis === 'y' ? '垂直' : '水平'}，幅度 ${this.params.mplatRange}）`);
        break;
      }
      case 'PWALL': {
        push({
          kind: 'POLARITY_WALL', x: wx, y: CEIL, w: 24, h: GROUND - CEIL,
          meta: { polarity: this.params.wallPolarity },
        });
        this.setStatus(`相位墙已放置（${this.params.wallPolarity === 'RED' ? '红' : '蓝'}色可穿）`);
        break;
      }
      case 'LASER': {
        const v = this.params.laserOrientation === 'V';
        push({
          kind: 'PULSE_LASER',
          x: wx, y: v ? CEIL : GROUND - 42,
          w: v ? 28 : 200, h: v ? GROUND - CEIL - 90 : 42,
          meta: {
            orientation: this.params.laserOrientation,
            period: this.params.laserPeriod,
            warn: 0.8,
            on: 0.5,
          },
        });
        this.setStatus(`脉冲激光已放置（${v ? '竖' : '横'}向，周期 ${this.params.laserPeriod}s）`);
        break;
      }
      case 'LOCK': {
        push({ kind: 'POLARITY_LOCK', x: wx, y: CEIL, w: 64, h: GROUND - CEIL });
        this.setStatus('极性锁已放置：门廊内无法换色，穿出补 +3 连击');
        break;
      }
      case 'BAIT': {
        if (this.data.obstacles.filter(o => o.kind === 'CORE_BAIT').length >= 2) {
          this.setStatus('磁芯诱饵每关最多 2 枚');
          break;
        }
        const size = 40;
        push({ kind: 'CORE_BAIT', x: wx, y: GROUND - 70 - size / 2, w: size, h: size });
        this.setStatus('磁芯诱饵已放置：磁芯 +1、连击 +2，换色锁定 1.2s（每关最多 2 枚）');
        break;
      }
      case 'MIRROR': {
        const y = clamp(Math.round(sy - 45), CEIL + 20, GROUND - 120);
        push({ kind: 'MAGNET_MIRROR', x: wx, y, w: 44, h: 90 });
        this.setStatus('磁极镜已放置：穿过时强制反转极性 1 次');
        break;
      }
      case 'RAIN': {
        push({
          kind: 'MAGNET_RAIN', x: wx, y: CEIL, w: 520, h: GROUND - CEIL,
          meta: { polarity: this.params.rainPolarity, count: this.params.rainCount },
        });
        this.setStatus(`磁芯雨已放置（${this.params.rainCount} 枚，红蓝交替）`);
        break;
      }
      case 'LAUNCH': {
        push({
          kind: 'LAUNCH_PAD', x: wx, y: GROUND - 22, w: 96, h: 22,
          meta: { polarity: this.params.launchPolarity },
        });
        this.setStatus('极性弹射板已放置：同色高弹、异色低弹');
        break;
      }
      case 'SWALL': {
        push({
          kind: 'POLARITY_WALL', x: wx, y: CEIL, w: 32, h: GROUND - CEIL,
          meta: {
            polarity: this.params.wallPolarity,
            range: this.params.slideRange,
            period: this.params.slidePeriod,
            phase: 0,
          },
        });
        this.setStatus(`滑动相位墙已放置（幅度 ±${this.params.slideRange}px，周期 ${this.params.slidePeriod}s）`);
        break;
      }
      case 'CONVEY': {
        push({
          kind: 'CONVEYOR', x: wx, y: GROUND - 20, w: 320, h: 20,
          meta: { dir: this.params.conveyorDir, speed: this.params.conveyorSpeed },
        });
        this.setStatus(`传送带已放置（${this.params.conveyorDir > 0 ? '加速' : '减速'} ${this.params.conveyorSpeed}px/s）`);
        break;
      }
      case 'PIT': {
        push({ kind: 'PIT', x: wx, y: GROUND - 1, w: this.params.pitWidth, h: 30 });
        this.setStatus(`断桥已放置（坑宽 ${this.params.pitWidth}px，跳跃可过）`);
        break;
      }
      case 'COMBO_GATE': {
        push({ kind: 'COMBO_GATE', x: wx, y: CEIL, w: 44, h: GROUND - CEIL, meta: { required: this.params.comboRequired } });
        this.setStatus(`连击门已放置（需连击 ≥${this.params.comboRequired} 穿过，不足即死）`);
        break;
      }
      case 'FINISH': {
        // 终点唯一：先移除旧终点再放置，整体算一步撤销
        this.pushHistory();
        this.data.obstacles = this.data.obstacles.filter(o => o.kind !== 'FINISH');
        this.data.obstacles.push({ kind: 'FINISH', x: wx, y: CEIL, w: 24, h: GROUND - CEIL });
        this.game.audio.playSwitch('BLUE');
        break;
      }
      case 'ERASE': {
        for (let i = this.data.obstacles.length - 1; i >= 0; i--) {
          const o = this.data.obstacles[i];
          if (o.kind === 'PENDULUM') {
            // 摆锤按摆球的实时摆动位置判定点击
            const amp = (o.meta?.amplitude as number) ?? 0.6;
            const spd = (o.meta?.swingSpeed as number) ?? 2.2;
            const rope = (o.meta?.rope as number) ?? 240;
            const phase = ((o.x % 360) / 360) * Math.PI * 2;
            const ang = amp * Math.sin(this.time * spd + phase);
            const cx = o.x + o.w / 2 + Math.sin(ang) * rope;
            const cy = o.y + Math.cos(ang) * rope;
            const r = o.w / 2 + 14;
            if (wx >= cx - r && wx <= cx + r && sy >= cy - r && sy <= cy + r) {
              this.pushHistory();
              this.data.obstacles.splice(i, 1);
              this.game.audio.playUIClick();
              return;
            }
            continue;
          }
          if (sx_hit(o, wx, sy)) {
            this.pushHistory();
            this.data.obstacles.splice(i, 1);
            this.game.audio.playUIClick();
            return;
          }
        }
        break;
      }
    }
  }

  private portalY(sy: number): number {
    return Math.max(CEIL, Math.min(GROUND - 64, sy - 32));
  }

  /** FR-11：当前工具的可调参数行 */
  private paramRows(): { label: string; value: string; step: (dir: number) => void }[] {
    switch (this.tool) {
      case 'MPLAT':
        return [
          {
            label: '轴向', value: this.params.mplatAxis === 'y' ? '垂直' : '水平',
            step: () => { this.params.mplatAxis = this.params.mplatAxis === 'y' ? 'x' : 'y'; },
          },
          {
            label: '幅度', value: `${this.params.mplatRange}px`,
            step: d => { this.params.mplatRange = clamp(this.params.mplatRange + d * 15, 60, 140); },
          },
          {
            label: '周期', value: `${this.params.mplatPeriod.toFixed(1)}s`,
            step: d => {
              const v = this.params.mplatPeriod + d * 0.2;
              this.params.mplatPeriod = Math.round(clamp(v, 2.4, 4) * 10) / 10;
            },
          },
        ];
      case 'GEM':
        return [
          {
            label: '颜色',
            value: this.params.gemColor === 'ANY' ? '任意' : (this.params.gemColor === 'RED' ? '红' : '蓝'),
            step: () => {
              this.params.gemColor = this.params.gemColor === 'ANY'
                ? 'RED' : (this.params.gemColor === 'RED' ? 'BLUE' : 'ANY');
            },
          },
        ];
      case 'PWALL':
        return [
          {
            label: '颜色', value: this.params.wallPolarity === 'RED' ? '红' : '蓝',
            step: () => { this.params.wallPolarity = this.params.wallPolarity === 'RED' ? 'BLUE' : 'RED'; },
          },
        ];
      case 'LASER':
        return [
          {
            label: '朝向', value: this.params.laserOrientation === 'V' ? '竖向' : '横向',
            step: () => {
              this.params.laserOrientation = this.params.laserOrientation === 'V' ? 'H' : 'V';
            },
          },
          {
            label: '周期', value: `${this.params.laserPeriod.toFixed(1)}s`,
            step: d => {
              const v = this.params.laserPeriod + d * 0.2;
              this.params.laserPeriod = Math.round(clamp(v, 2.4, 3.2) * 10) / 10;
            },
          },
        ];
      case 'BOOST':
        return [
          {
            label: '倍率', value: `×${this.params.boostMul.toFixed(1)}`,
            step: d => {
              const v = this.params.boostMul + d * 0.2;
              this.params.boostMul = Math.round(clamp(v, 1.2, 3) * 10) / 10;
            },
          },
          {
            label: '时长', value: `${this.params.boostDur.toFixed(1)}s`,
            step: d => {
              const v = this.params.boostDur + d * 0.5;
              this.params.boostDur = Math.round(clamp(v, 0.5, 6) * 10) / 10;
            },
          },
        ];
      case 'RAIN':
        return [
          {
            label: '颜色', value: this.params.rainPolarity === 'RED' ? '红' : '蓝',
            step: () => { this.params.rainPolarity = this.params.rainPolarity === 'RED' ? 'BLUE' : 'RED'; },
          },
          {
            label: '枚数', value: `${this.params.rainCount}`,
            step: d => { this.params.rainCount = clamp(this.params.rainCount + d, 1, 5); },
          },
        ];
      case 'LAUNCH':
        return [
          {
            label: '颜色', value: this.params.launchPolarity === 'RED' ? '红' : '蓝',
            step: () => {
              this.params.launchPolarity = this.params.launchPolarity === 'RED' ? 'BLUE' : 'RED';
            },
          },
        ];
      case 'SWALL':
        return [
          {
            label: '颜色', value: this.params.wallPolarity === 'RED' ? '红' : '蓝',
            step: () => { this.params.wallPolarity = this.params.wallPolarity === 'RED' ? 'BLUE' : 'RED'; },
          },
          {
            label: '幅度', value: `±${this.params.slideRange}px`,
            step: d => { this.params.slideRange = clamp(this.params.slideRange + d * 20, 20, 140); },
          },
          {
            label: '周期', value: `${this.params.slidePeriod.toFixed(1)}s`,
            step: d => {
              const v = this.params.slidePeriod + d * 0.2;
              this.params.slidePeriod = Math.round(clamp(v, 2, 5) * 10) / 10;
            },
          },
        ];
      case 'CONVEY':
        return [
          {
            label: '方向', value: this.params.conveyorDir > 0 ? '加速' : '减速',
            step: () => { this.params.conveyorDir = this.params.conveyorDir > 0 ? -1 : 1; },
          },
          {
            label: '速度', value: `${this.params.conveyorSpeed}px/s`,
            step: d => {
              this.params.conveyorSpeed = clamp(this.params.conveyorSpeed + d * 30, 30, 180);
            },
          },
        ];
      case 'PIT':
        return [
          {
            label: '宽度', value: `${this.params.pitWidth}px`,
            step: d => {
              const idx = Math.round((this.params.pitWidth - 180) / 60);
              this.params.pitWidth = [180, 240, 300][clamp(idx + d, 0, 2)];
            },
          },
        ];
      case 'PEND_R':
      case 'PEND_B':
        return [
          {
            label: '振幅', value: `${this.params.pendAmplitude.toFixed(2)}rad`,
            step: d => {
              const v = this.params.pendAmplitude + d * 0.05;
              this.params.pendAmplitude = Math.round(clamp(v, 0.35, 0.85) * 100) / 100;
            },
          },
          {
            label: '周期', value: `${this.params.pendPeriod.toFixed(2)}s`,
            step: d => {
              const v = this.params.pendPeriod + d * 0.2;
              this.params.pendPeriod = Math.round(clamp(v, MECH.PEND.minPeriod, 4.0) * 100) / 100;
            },
          },
          {
            label: '预警', value: `${this.params.pendWarn.toFixed(2)}s`,
            step: d => {
              const v = this.params.pendWarn + d * 0.05;
              this.params.pendWarn = Math.round(clamp(v, 0.3, 0.8) * 100) / 100;
            },
          },
        ];
      default:
        return [];
    }
  }

  private playTest() {
    if (this.data.obstacles.length === 0) {
      this.setStatus('关卡是空的，先放几个障碍吧');
      return;
    }
    const snapshot = structuredClone(this.data);
    const def = customToLevelDef(snapshot);
    this.game.switchScene(new GameScene(this.game, {
      def,
      customData: snapshot,
      returnScene: () => new EditorScene(this.game, this.data),
    }));
  }

  private saveLevel() {
    if (this.data.obstacles.length === 0) { this.setStatus('空关卡不能保存'); return; }
    // 名称直接沿用当前编辑器名称，不再调用系统输入框
    this.data.name = this.data.name.trim().slice(0, 20) || '我的关卡';
    if (!this.data.id) this.data.id = this.store.newId();
    this.data.createdAt = this.data.createdAt || Date.now();
    this.store.save(structuredClone(this.data));
    this.setStatus(`已保存：${this.data.name}`);
  }

  /**
   * 「分享码」按钮：统一走服务端 8 位码。
   * 已上传且内容未改动 → 直接再次展示现有码；有任何改动 → 重新上传拿新码。
   */
  private async exportShare() {
    if (this.data.obstacles.length === 0) { this.setStatus('关卡是空的，先放几个障碍吧'); return; }
    if (this.data.shareCode && this.lastUploadFingerprint === this.obstaclesFingerprint()) {
      this.showSharePanel(this.data.shareCode);
      const ok = await copyText(this.data.shareCode);
      if (ok) { this.shareCopyAt = this.time; this.setStatus('分享码已复制到剪贴板'); }
      return;
    }
    // 内容变了或尚未上传：上传后再展示（旧码仍指向旧快照，不能直接复用）
    await this.uploadToServer();
  }

  private obstaclesFingerprint() {
    return JSON.stringify(this.data.obstacles);
  }

  /** 展示分享码面板；不依赖剪贴板权限，码本身始终可见 */
  private showSharePanel(code: string) {
    this.shareCode = code;
    this.shareCopyAt = -1;
  }

  /** 上传当前地图到服务器，成功后拿到分享码并复制 */
  private async uploadToServer() {
    if (this.uploading) return;
    if (this.data.obstacles.length === 0) { this.setStatus('关卡是空的，先放几个障碍吧'); return; }
    // 名称直接取当前编辑器的名称，不再弹出输入框
    this.data.name = this.data.name.trim().slice(0, 20) || '我的关卡';
    this.uploading = true;
    this.setStatus('正在上传到服务器…');
    try {
      const res = await uploadLevel(this.data);
      // 记下服务端分享码并写入「我的地图」：之后可在列表里再次查看/复制
      this.data.shareCode = res.code;
      if (!this.data.id) this.data.id = this.store.newId();
      this.data.createdAt = this.data.createdAt || Date.now();
      this.store.save(structuredClone(this.data));
      // 自动展示大字号分享码面板（全应用内 UI，不再用系统 prompt）
      this.showSharePanel(res.code);
      this.lastUploadFingerprint = this.obstaclesFingerprint();
      const copied = await copyText(res.code);
      if (copied) {
        this.shareCopyAt = this.time;
        this.setStatus(`上传成功！分享码 ${res.code} 已复制到剪贴板`);
      } else {
        this.setStatus(`上传成功！请点击面板中的「复制分享码」`);
      }
    } catch (err) {
      // 失败时明确原因，不显示空码
      this.shareCode = '';
      this.setStatus(`上传失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.uploading = false;
    }
  }

  /** 分享码面板的固定布局：点击与绘制共用，避免错位 */
  private sharePanelRects() {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const w = 520;
    const h = 300;
    const x = (W - w) / 2;
    const y = 120;
    return {
      x, y, w, h,
      copy: { x: x + 60, y: y + h - 78, w: 220, h: 46 },
      close: { x: x + 300, y: y + h - 78, w: 160, h: 46 },
    };
  }

  private async copyShareCode() {
    if (!this.shareCode) return;
    const ok = await copyText(this.shareCode);
    if (ok) {
      this.shareCopyAt = this.time;
      this.setStatus('分享码已复制到剪贴板');
    } else {
      this.setStatus('复制失败，请手动记录上方分享码');
    }
  }

  private renderSharePanel(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    ctx.save();
    ctx.fillStyle = UI.color.scrim;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const r = this.sharePanelRects();
    toonShape(ctx, { x: r.x, y: r.y, w: r.w, h: r.h }, {
      fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: 16, shadow: 8,
    });
    const copied = this.shareCopyAt >= 0 && this.time - this.shareCopyAt < 2;
    const model = sharePanelModel(this.shareCode, copied);
    const cx = r.x + r.w / 2;
    drawStickerText(ctx, '分享码已就绪！', cx, r.y + 40, {
      font: `bold 24px ${UI.font.ui}`, fill: UI.color.successInk,
      stroke: UI.ink, lineWidth: 2, align: 'center', baseline: 'middle',
    });
    drawStickerText(ctx, '把这串 8 位分享码发给好友', cx, r.y + 76, {
      font: `${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub,
      stroke: UI.color.rim, lineWidth: 4, align: 'center', baseline: 'middle',
    });
    // 大字号分享码（不依赖剪贴板权限：即使复制失败，码也一直可见）
    drawStickerText(ctx, model.codeText, cx, r.y + 136, {
      font: `bold 44px ${UI.font.mono}`, fill: UI.color.grape,
      stroke: UI.color.rim, lineWidth: 8, align: 'center', baseline: 'middle',
    });
    drawStickerText(ctx, model.hint, cx, r.y + 176, {
      font: `${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub,
      stroke: UI.color.rim, lineWidth: 4, align: 'center', baseline: 'middle',
    });
    drawButton(ctx, r.copy, model.copyLabel, {
      variant: copied ? 'ghost' : 'primary', fontSize: UI.size.body,
    });
    drawButton(ctx, r.close, '关闭', { variant: 'ghost', fontSize: UI.size.body });
  }

  private clearAll() {
    if (!window.confirm('清空当前关卡的全部内容？')) return;
    this.pushHistory();
    this.data.obstacles = [];
    this.pendingPortal = null;
    this.cameraX = 0;
    this.setStatus('已清空（可撤销）');
  }

  private back() {
    this.game.switchScene(new CustomLevelsScene(this.game));
  }

  // ---- 渲染 ----

  render(ctx: CanvasRenderingContext2D) {
    // 卡通天空背景；编辑区里的障碍物预览仍走 Obstacle.render，保持原样
    drawMenuBackground(ctx, this.time);

    this.renderTrack(ctx);
    this.renderToolbar(ctx);
    this.renderParamPanel(ctx);
    this.renderBottomBar(ctx);
  }

  /** FR-11：参数面板（只对带参数的工具有效） */
  private renderParamPanel(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const rows = this.paramRows();
    this.paramHits = [];
    if (rows.length === 0) return;

    const w = 286;
    const x = W - w - 14;
    const y = TOP_H + 14;
    const h = 30 + rows.length * 30;
    ctx.save();
    ctx.fillStyle = UI.color.scrimStrong;
    ctx.strokeStyle = UI.inkSoft;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = UI.color.accent;
    ctx.font = `bold 12px ${UI.font.ui}`;
    ctx.fillText('参数', x + 12, y + 20);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ry = y + 30 + i * 30;
      ctx.textAlign = 'left';
      ctx.fillStyle = UI.color.rim;
      ctx.font = `12px ${UI.font.ui}`;
      ctx.fillText(row.label, x + 14, ry + 16);
      ctx.textAlign = 'center';
      ctx.fillStyle = UI.color.sub;
      ctx.fillText(row.value, x + w - 108, ry + 16);

      const bw = 26;
      const bh = 22;
      const bx = x + w - 66;
      const by = ry + 3;
      ctx.fillStyle = withAlpha(UI.paper, 0.14);
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillRect(bx + bw + 4, by, bw, bh);
      ctx.fillStyle = UI.color.rim;
      ctx.font = `bold 14px ${UI.font.ui}`;
      ctx.fillText('‹', bx + bw / 2, by + 16);
      ctx.fillText('›', bx + bw * 1.5 + 4, by + 16);

      this.paramHits.push({ x: bx, y: by, w: bw, h: bh, apply: () => { this.pushHistory(); row.step(-1); } });
      this.paramHits.push({ x: bx + bw + 4, y: by, w: bw, h: bh, apply: () => { this.pushHistory(); row.step(1); } });
    }
    ctx.restore();
  }

  private renderTrack(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    ctx.save();
    ctx.translate(-this.cameraX, 0);

    // 网格
    const startGX = Math.floor(this.cameraX / 100) * 100;
    ctx.strokeStyle = UI.inkFaint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startGX; x < this.cameraX + W + 100; x += 100) {
      ctx.moveTo(x, TOP_H); ctx.lineTo(x, GROUND + 48);
    }
    ctx.stroke();

    // 刻度坐标
    ctx.font = '10px "Consolas", monospace';
    ctx.fillStyle = UI.color.sub;
    ctx.textAlign = 'center';
    for (let x = startGX; x < this.cameraX + W + 100; x += 500) {
      ctx.fillText(`${x}`, x, TOP_H + 14);
    }

    // 地面/天花板
    ctx.strokeStyle = UI.inkSoft;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.cameraX - 50, GROUND); ctx.lineTo(this.cameraX + W + 50, GROUND);
    ctx.moveTo(this.cameraX - 50, CEIL); ctx.lineTo(this.cameraX + W + 50, CEIL);
    ctx.stroke();

    // 起点标记
    ctx.strokeStyle = COLORS.GRAVITY;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(120, CEIL); ctx.lineTo(120, GROUND);
    ctx.stroke();
    ctx.setLineDash([]);
    drawStickerText(ctx, '起点', 120, CEIL - 6, {
      font: `bold 12px ${UI.font.ui}`,
      fill: COLORS.GRAVITY, stroke: UI.color.rim, lineWidth: 4, align: 'center',
    });

    // 障碍
    for (const dto of this.data.obstacles) {
      if (dto.x + dto.w < this.cameraX - 100 || dto.x > this.cameraX + W + 100) {
        // 摆锤锚点离屏但摆球可能甩入视野，放大剔除范围
        if (dto.kind !== 'PENDULUM' || dto.x < this.cameraX - 320 || dto.x > this.cameraX + W + 320) continue;
      }
      let o = this.obstacleCache.get(dto);
      if (!o) {
        o = new Obstacle({
          kind: dto.kind as ObstacleKind, x: dto.x, y: dto.y, w: dto.w, h: dto.h, meta: dto.meta,
        });
        this.obstacleCache.set(dto, o);
      }
      if (dto.kind === 'PENDULUM') o.updateSwing(this.time);
      else if (dto.kind === 'POLARITY_WALL') o.updateMotion(this.time);
      o.render(ctx, this.time);
    }

    // 鼠标幽灵预览
    if (this.mouse && this.mouse.y >= TOP_H + 8 && this.mouse.y <= GROUND + 48) {
      const wx = Math.round((this.mouse.x + this.cameraX) / 16) * 16;
      const preview = this.previewObstacle(wx, this.mouse.y);
      if (preview) {
        // 预览也复用同一个实例，仅当参数变化时重建
        const key = `${preview.kind}|${preview.x}|${preview.y}|${preview.w}|${preview.h}|${JSON.stringify(preview.meta ?? null)}`;
        if (key !== this.previewKey || !this.previewInstance) {
          this.previewInstance = new Obstacle(preview);
          this.previewKey = key;
        }
        const o = this.previewInstance;
        if (preview.kind === 'PENDULUM') o.updateSwing(this.time);
        else if (preview.kind === 'POLARITY_WALL') o.updateMotion(this.time);
        ctx.globalAlpha = 0.45;
        o.render(ctx, this.time);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }

  private previewObstacle(wx: number, sy: number): ObstacleConfig | null {
    const cfg = (kind: ObstacleKind, x: number, y: number, w: number, h: number, meta?: any): ObstacleConfig =>
      ({ kind, x, y, w, h, meta });
    switch (this.tool) {
      case 'RED_SPIKE':
      case 'BLUE_SPIKE':
        return cfg(this.tool, wx, sy < 270 ? CEIL : GROUND - 32, 32, 32);
      case 'WALL': {
        const h = Math.max(24, Math.min(64, GROUND - sy));
        return cfg('WALL', wx, GROUND - h, 40, h);
      }
      case 'PORTAL_A':
      case 'PORTAL_B': {
        const pid = this.pendingPortal && this.pendingPortal.kind === this.tool
          ? this.pendingPortal.id
          : this.portalSeq;
        return cfg(this.tool, wx, this.portalY(sy), 48, 64, { portalId: pid });
      }
      case 'ZONE_RED': return cfg('POLARITY_ZONE', wx, CEIL, 64, GROUND - CEIL, { forcedPolarity: 'RED' });
      case 'ZONE_BLUE': return cfg('POLARITY_ZONE', wx, CEIL, 64, GROUND - CEIL, { forcedPolarity: 'BLUE' });
      case 'FLIP': return cfg('GRAVITY_FLIP', wx, CEIL, 56, GROUND - CEIL);
      case 'BOOST':
        return cfg('SPEED_BOOST', wx, GROUND - 20, 120, 20, {
          multiplier: this.params.boostMul, duration: this.params.boostDur,
        });
      case 'PEND_R':
      case 'PEND_B': {
        const rope = clamp(Math.round(sy - CEIL), 150, 320);
        const period = clamp(this.params.pendPeriod, MECH.PEND.minPeriod, 4.0);
        return cfg('PENDULUM', wx, CEIL, 40, 40, {
          rope,
          polarity: this.tool === 'PEND_R' ? 'RED' : 'BLUE',
          amplitude: this.params.pendAmplitude,
          swingSpeed: (Math.PI * 2) / period,
          warnLead: this.params.pendWarn,
        });
      }
      case 'GEM':
        return cfg('COLLECTIBLE', wx, clamp(Math.round(sy - 12), CEIL + 6, GROUND - 30), 24, 24,
          this.params.gemColor === 'ANY' ? undefined : { color: this.params.gemColor });
      case 'STAR':
        return cfg('SPECIAL_ITEM', wx, clamp(Math.round(sy - 17), CEIL + 6, GROUND - 40), 34, 34, {
          itemId: 'CUSTOM_STAR', itemName: '星核',
        });
      case 'PLATFORM':
        return cfg('PLATFORM', wx, clamp(Math.round(sy - 7), CEIL + 20, GROUND - 90), 160, 14);
      case 'MPLAT':
        return cfg('MOVING_PLATFORM', wx, clamp(Math.round(sy - 7), CEIL + 20, GROUND - 90), 140, 14, {
          axis: this.params.mplatAxis, range: this.params.mplatRange,
          period: this.params.mplatPeriod, phase: 0,
        });
      case 'PWALL':
        return cfg('POLARITY_WALL', wx, CEIL, 24, GROUND - CEIL, { polarity: this.params.wallPolarity });
      case 'LASER': {
        const v = this.params.laserOrientation === 'V';
        return cfg('PULSE_LASER', wx, v ? CEIL : GROUND - 42, v ? 28 : 200, v ? GROUND - CEIL - 90 : 42, {
          orientation: this.params.laserOrientation, period: this.params.laserPeriod, warn: 0.8, on: 0.5,
        });
      }
      case 'LOCK': return cfg('POLARITY_LOCK', wx, CEIL, 64, GROUND - CEIL);
      case 'BAIT': {
        const size = 40;
        return cfg('CORE_BAIT', wx, GROUND - 70 - size / 2, size, size);
      }
      case 'MIRROR':
        return cfg('MAGNET_MIRROR', wx, clamp(Math.round(sy - 45), CEIL + 20, GROUND - 120), 44, 90);
      case 'RAIN':
        return cfg('MAGNET_RAIN', wx, CEIL, 520, GROUND - CEIL, {
          polarity: this.params.rainPolarity, count: this.params.rainCount,
        });
      case 'LAUNCH':
        return cfg('LAUNCH_PAD', wx, GROUND - 22, 96, 22, { polarity: this.params.launchPolarity });
      case 'SWALL':
        return cfg('POLARITY_WALL', wx, CEIL, 32, GROUND - CEIL, {
          polarity: this.params.wallPolarity,
          range: this.params.slideRange,
          period: this.params.slidePeriod,
          phase: 0,
        });
      case 'CONVEY':
        return cfg('CONVEYOR', wx, GROUND - 20, 320, 20, {
          dir: this.params.conveyorDir, speed: this.params.conveyorSpeed,
        });
      case 'PIT':
        return cfg('PIT', wx, GROUND - 1, this.params.pitWidth, 30);
      case 'COMBO_GATE':
        return cfg('COMBO_GATE', wx, CEIL, 44, GROUND - CEIL, { required: this.params.comboRequired });
      case 'FINISH': return cfg('FINISH', wx, CEIL, 24, GROUND - CEIL);
      case 'ERASE': return null;
    }
  }

  private renderToolbar(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    // 卡通工具栏底板
    toonShape(ctx, { x: 6, y: 6, w: W - 12, h: TOP_H - 8 }, {
      fill: UI.color.panel, stroke: UI.inkSoft, lineWidth: 3, radius: UI.radius.lg,
    });

    // 第一行：分类标签
    EDITOR_CATEGORIES.forEach((cat, i) => {
      const r = tabRect(i, W);
      const selected = cat.id === this.category;
      toonShape(ctx, { x: r.x, y: r.y, w: r.w, h: r.h }, {
        fill: selected ? UI.color.accent : withAlpha(UI.paper, 0.6),
        stroke: selected ? UI.ink : UI.inkSoft,
        lineWidth: selected ? 4 : 3,
        radius: UI.radius.md,
        shadow: selected ? 4 : 2,
      });
      drawStickerText(ctx, cat.label, r.x + r.w / 2, r.y + r.h / 2 + 1, {
        font: `bold 20px ${UI.font.ui}`,
        fill: selected ? UI.color.rim : UI.color.text,
        stroke: selected ? UI.ink : UI.color.rim,
        lineWidth: selected ? 3 : 4,
        align: 'center',
        baseline: 'middle',
      });
    });

    // 第二行：本分类的工具，单行横向滚动
    const list = this.currentTools();
    const viewW = W - L.toolX0 * 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.toolX0, L.toolY - 2, viewW, L.toolH + 4);
    ctx.clip();
    list.forEach((t, i) => {
      const cellX = L.toolX0 + i * (L.toolW + L.toolGap) - this.toolScroll;
      const selected = this.tool === t.id;
      const inset = selected ? 1 : 3;
      const r = {
        x: cellX + inset,
        y: L.toolY + 2 + inset,
        w: L.toolW - inset * 2,
        h: L.toolH - 8 - inset * 2,
      };
      // 触屏命中区按整格 (64px 高) 计算，视觉内缩只影响观感
      toonShape(ctx, r, {
        fill: withAlpha(t.color, selected ? 0.34 : 0.18),
        stroke: selected ? UI.color.accent : UI.inkSoft,
        lineWidth: selected ? 4 : 3,
        radius: UI.radius.sm,
        shadow: selected ? 4 : 3,
      });
      // 色块图标：显示该物件在游戏中的实际配色
      toonShape(ctx, { x: cellX + L.toolW / 2 - 9, y: L.toolY + 10, w: 18, h: 18 }, {
        fill: t.color, stroke: UI.inkSoft, lineWidth: 2, radius: 5,
      });
      drawStickerText(ctx, t.label, cellX + L.toolW / 2, L.toolY + 46, {
        font: `bold 14px ${UI.font.ui}`,
        fill: UI.color.text, stroke: UI.color.rim, lineWidth: 3, align: 'center',
      });
    });
    ctx.restore();

    // 左右滑动提示 + 滚动条（仅当本分类放不下时出现）
    const maxScroll = maxToolScroll(this.category, W);
    if (maxScroll > 0) {
      if (this.toolScroll > 1) {
        drawStickerText(ctx, '‹', L.toolX0 - 8, L.toolY + L.toolH / 2, {
          font: `bold 22px ${UI.font.ui}`,
          fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'center', baseline: 'middle',
        });
      }
      if (this.toolScroll < maxScroll - 1) {
        drawStickerText(ctx, '›', W - L.toolX0 + 8, L.toolY + L.toolH / 2, {
          font: `bold 22px ${UI.font.ui}`,
          fill: UI.color.text, stroke: UI.color.rim, lineWidth: 4, align: 'center', baseline: 'middle',
        });
      }
      const trackY = L.toolY + L.toolH + 2;
      ctx.fillStyle = withAlpha(UI.ink, 0.18);
      ctx.fillRect(L.toolX0, trackY, viewW, 3);
      const total = toolContentWidth(this.category);
      ctx.fillStyle = UI.color.accent;
      ctx.fillRect(
        L.toolX0 + (viewW * this.toolScroll) / total,
        trackY,
        Math.max(24, (viewW * viewW) / total),
        3,
      );
    }
  }

  private renderBottomBar(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    // 卡通底板
    toonShape(ctx, { x: 6, y: BOTTOM_Y - 4, w: W - 12, h: H - (BOTTOM_Y - 4) - 2 }, {
      fill: UI.color.panel, stroke: UI.inkSoft, lineWidth: 3, radius: UI.radius.lg,
    });

    for (const b of this.buttons) {
      const able = b.enabled ? b.enabled() : true;
      // 命中矩形仍由 handleClick 依 b.x / b.w 判定，绘制位置与之对齐
      drawButton(ctx, { x: b.x, y: BOTTOM_Y, w: b.w, h: 36 }, b.label, {
        variant: 'ghost', fontSize: UI.size.small,
        state: able ? 'normal' : 'disabled',
      });
    }

    // 状态提示：画布下沿的小 toast，避免和底部按钮文字重叠
    if (this.statusTimer > 0) {
      const shown = this.status.length > 34 ? `${this.status.slice(0, 34)}…` : this.status;
      ctx.font = `bold ${UI.size.small}px ${UI.font.ui}`;
      const tw = ctx.measureText(shown).width;
      const tr = { x: 480 - (tw + 44) / 2, y: BOTTOM_Y - 50, w: tw + 44, h: 34 };
      toonShape(ctx, tr, { fill: UI.paperWarm, stroke: UI.ink, lineWidth: 3, radius: UI.radius.pill, shadow: 4 });
      drawStickerText(ctx, shown, 480, tr.y + 17, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`,
        fill: UI.color.text, align: 'center', baseline: 'middle',
      });
    } else {
      const nameShort = this.data.name.length > 8 ? `${this.data.name.slice(0, 8)}…` : this.data.name;
      const info = `${nameShort} · ${this.data.obstacles.length} 个物件 · Z 撤销`;
      drawStickerText(ctx, info, 781, BOTTOM_Y + 22, {
        font: `bold 12px ${UI.font.ui}`,
        fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 4, align: 'center',
      });
    }

    // 上传成功后的分享码面板放在最上层（模态，点击被 handleClick 拦截）
    if (this.shareCode) this.renderSharePanel(ctx);
  }
}

function sx_hit(o: { x: number; y: number; w: number; h: number }, wx: number, sy: number): boolean {
  const pad = 8;
  return wx >= o.x - pad && wx <= o.x + o.w + pad && sy >= o.y - pad && sy <= o.y + o.h + pad;
}

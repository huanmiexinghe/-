// 障碍物基类与全部障碍类型（数据驱动）

import { COLORS, GAME_CONFIG, Polarity } from '../data/config';
import { MECH, rainCoreY, pendulumAngle, pendulumCharged, pendulumChargeLevel, pendulumWarned, pendulumWarnProgress, pendulumMaxWarnLead } from '../systems/Mechanics';
import { AABB, clamp } from '../utils/Math';
import { withAlpha } from '../utils/Color';
import { UI, STROKE, PALETTE } from '../ui/theme';
import { toonShape, drawStickerText, drawPolarityMark } from '../ui/widgets';

/** 向当前路径追加一个圆角三角形（尖刺形体） */
function roundTriangle(
  ctx: CanvasRenderingContext2D,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  radius: number,
) {
  const pts: [number, number][] = [[ax, ay], [bx, by], [cx, cy]];
  for (let i = 0; i < 3; i++) {
    const [px, py] = pts[i];
    const [qx, qy] = pts[(i + 2) % 3];
    const [rx, ry] = pts[(i + 1) % 3];
    const l1 = Math.hypot(qx - px, qy - py) || 1;
    const l2 = Math.hypot(rx - px, ry - py) || 1;
    const r = Math.min(radius, l1 * 0.45, l2 * 0.45);
    const sx = px + ((qx - px) / l1) * r;
    const sy = py + ((qy - py) / l1) * r;
    const ex = px + ((rx - px) / l2) * r;
    const ey = py + ((ry - py) / l2) * r;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
    ctx.quadraticCurveTo(px, py, ex, ey);
  }
  ctx.closePath();
}

export type ObstacleKind =
  | 'RED_SPIKE' | 'BLUE_SPIKE' | 'WALL'
  | 'PORTAL_A' | 'PORTAL_B'
  | 'POLARITY_ZONE' | 'GRAVITY_FLIP' | 'SPEED_BOOST'
  | 'PENDULUM'
  | 'COLLECTIBLE' | 'SPECIAL_ITEM' | 'SPECIAL_DOOR'
  | 'PLATFORM'
  | 'MOVING_PLATFORM'
  | 'POLARITY_WALL'
  | 'PULSE_LASER'
  | 'MAGNET_RAIN' | 'POLARITY_LOCK' | 'CORE_BAIT' | 'MAGNET_MIRROR'
  | 'LAUNCH_PAD' | 'CONVEYOR' | 'PIT'
  | 'COMBO_GATE'
  | 'FINISH';

export interface ObstacleMeta {
  /** 传送门配对 ID */
  portalId?: number;
  /** 反转区目标极性 */
  forcedPolarity?: Polarity;
  /** 加速带倍率/持续时间 */
  multiplier?: number;
  duration?: number;
  /** 摆锤：绳长/摆幅(弧度)/角速度/初相/极性 */
  rope?: number;
  amplitude?: number;
  swingSpeed?: number;
  phase?: number;
  polarity?: Polarity;
  /** 移动浮台：运动轴 / 振幅(px) / 周期(秒) / 相位(0–1) */
  axis?: 'x' | 'y';
  range?: number;
  period?: number;
  /** 脉冲激光：朝向 / 预警秒 / 激活秒 */
  orientation?: 'V' | 'H';
  warn?: number;
  on?: number;
  /** 磁暴摆锤：充能前的预警时长（秒） */
  warnLead?: number;
  /** 无尽磁芯标记（不计入关卡晶片总数） */
  currency?: number;
  /** 传送带：方向（+1 加速 / −1 减速）与附加速度 */
  dir?: 1 | -1;
  speed?: number;
  /** 磁芯雨：每轮下落枚数 */
  count?: number;
  /** 特殊物品 */
  itemId?: string;
  itemName?: string;
  /** 特殊门目标特殊关卡 id */
  targetId?: number;
  /** 连击门：所需最低连击数（COMBO_GATE 专属；≥此值方可穿过） */
  required?: number;
  [key: string]: unknown;
}

export interface ObstacleConfig {
  kind: ObstacleKind;
  x: number;
  y: number;
  w: number;
  h: number;
  meta?: ObstacleMeta;
}

export class Obstacle {
  kind: ObstacleKind;
  x: number; y: number; w: number; h: number;
  meta: ObstacleMeta | undefined;
  triggered = false; // 一次性触发标记（传送门/反转区/重力翻转/加速带/特殊门）
  collected = false; // 晶片 / 特殊物品 / 磁芯诱饵
  /** 彩色晶片颜色不符时的晃动截止时间（GameScene 设置，仅视觉） */
  bumpUntil = -1;
  locked = false;    // 终点锁定（晶片未集齐）
  /** 极性锁是否已经发放过出门奖励 */
  rewarded = false;
  /** 磁芯雨已收集的枚数位掩码（每道雨带最多 3 枚） */
  rainHits = 0;

  // 摆锤动态状态
  private swingAngle = 0;
  ballCX = 0;
  ballCY = 0;
  /** 最近一次 updateSwing 的关卡时间（用于预警/充能判定，保证与画面同一帧） */
  private swingTime = 0;
  private wasCharged = false;
  /** 充能窗口结束后的消磁保护剩余时间 */
  dischargeGrace = 0;
  /** 移动浮台当前相对初始位置的偏移（由 updateMotion 计算） */
  ox = 0;
  oy = 0;

  constructor(cfg: ObstacleConfig) {
    this.kind = cfg.kind;
    this.x = cfg.x; this.y = cfg.y;
    this.w = cfg.w; this.h = cfg.h;
    this.meta = cfg.meta;
    if (this.kind === 'PENDULUM') {
      this.ballCX = this.x + this.w / 2;
      this.ballCY = this.y + (this.meta?.rope ?? 180);
    }
  }

  get bounds(): AABB {
    if (this.kind === 'PENDULUM') {
      const r = this.ballR;
      return { x: this.ballCX - r, y: this.ballCY - r, w: r * 2, h: r * 2 };
    }
    if (this.kind === 'MOVING_PLATFORM' || this.kind === 'POLARITY_WALL' || this.kind === 'CONVEYOR') {
      return { x: this.x + this.ox, y: this.y + this.oy, w: this.w, h: this.h };
    }
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  }

  /** 视锥剔除用的世界 x 范围 */
  get viewLeft(): number {
    if (this.kind === 'PENDULUM') return this.ballCX - this.ballR;
    if (this.kind === 'MOVING_PLATFORM' || this.kind === 'POLARITY_WALL' || this.kind === 'CONVEYOR') {
      return this.x + this.ox;
    }
    return this.x;
  }
  get viewRight(): number {
    if (this.kind === 'PENDULUM') return this.ballCX + this.ballR;
    if (this.kind === 'MOVING_PLATFORM' || this.kind === 'POLARITY_WALL' || this.kind === 'CONVEYOR') {
      return this.x + this.ox + this.w;
    }
    return this.x + this.w;
  }

  get ballR(): number {
    return this.w / 2;
  }

  get color(): string {
    switch (this.kind) {
      case 'RED_SPIKE': return COLORS.SPIKE_RED;
      case 'BLUE_SPIKE': return COLORS.SPIKE_BLUE;
      case 'WALL': return COLORS.GRAY;
      case 'PORTAL_A': return COLORS.PORTAL_A;
      case 'PORTAL_B': return COLORS.PORTAL_B;
      case 'POLARITY_ZONE': return COLORS.REVERSE_ZONE;
      case 'GRAVITY_FLIP': return COLORS.GRAVITY;
      case 'SPEED_BOOST': return COLORS.SPEED_BOOST;
      case 'PENDULUM': return this.meta?.polarity === 'BLUE' ? COLORS.BLUE : COLORS.RED;
      case 'COLLECTIBLE': return COLORS.COLLECTIBLE;
      case 'SPECIAL_ITEM': return COLORS.SPECIAL_ITEM;
      case 'SPECIAL_DOOR': return COLORS.SPECIAL_DOOR;
      case 'PLATFORM': return COLORS.PLATFORM;
      case 'MOVING_PLATFORM': return COLORS.MOVING_PLATFORM;
      case 'POLARITY_WALL': return this.meta?.polarity === 'BLUE' ? COLORS.BLUE : COLORS.RED;
      case 'PULSE_LASER': return COLORS.LASER;
      case 'MAGNET_RAIN': return COLORS.COLLECTIBLE;
      case 'POLARITY_LOCK': return COLORS.GRAY;
      case 'CORE_BAIT': return COLORS.COLLECTIBLE;
      case 'MAGNET_MIRROR': return COLORS.PORTAL_A;
      case 'LAUNCH_PAD': return this.meta?.polarity === 'BLUE' ? COLORS.BLUE : COLORS.RED;
      case 'CONVEYOR': return COLORS.PLATFORM;
      case 'PIT': return COLORS.PIT;
      case 'COMBO_GATE': return this.triggered ? COLORS.GRAVITY : COLORS.SPEED_BOOST;
      case 'FINISH': return PALETTE.dust050;
    }
  }

  /** 极性：尖刺/摆锤/相位墙返回对应极性，其余返回 null */
  get polarity(): Polarity | null {
    if (this.kind === 'RED_SPIKE') return 'RED';
    if (this.kind === 'BLUE_SPIKE') return 'BLUE';
    if (this.kind === 'PENDULUM') return (this.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED');
    if (this.kind === 'POLARITY_WALL') return (this.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED');
    return null;
  }

  // ---- 摆锤运动 ----

  get pendulumAnchor() {
    return { x: this.x + this.w / 2, y: this.y };
  }

  get pendulumAngle() {
    return this.swingAngle;
  }

  /** 摆锤振幅（弧度），默认取机制数值 */
  get pendulumAmplitude(): number {
    return this.meta?.amplitude ?? MECH.PEND.amplitude;
  }

  /** 摆锤角速度（弧度/秒）；旧数据用 swingSpeed，缺省按默认周期换算 */
  get pendulumSpeed(): number {
    return this.meta?.swingSpeed ?? (Math.PI * 2) / MECH.PEND.period;
  }

  /** 摆锤初相（弧度），与渲染使用同一来源 */
  get pendulumPhase(): number {
    return this.meta?.phase ?? ((this.x % 360) / 360) * Math.PI * 2;
  }

  /** 实际预警时长：关卡可调，但不超过安全间隙的 90% */
  get pendulumWarnLead(): number {
    const max = pendulumMaxWarnLead(this.pendulumSpeed);
    const v = this.meta?.warnLead ?? MECH.PEND.warnLead;
    return Math.max(0.15, Math.min(v, max));
  }

  /** 当前是否处于充能（伤害）窗口 */
  get isCharged(): boolean {
    return pendulumCharged(this.swingAngle, this.pendulumAmplitude);
  }

  /** 当前是否处于充能前的预警期 */
  get isWarned(): boolean {
    return pendulumWarned(this.swingTime, this.pendulumAmplitude, this.pendulumSpeed, this.pendulumPhase, this.pendulumWarnLead);
  }

  /** 充能强度 0–1（中心最强） */
  get chargeLevel(): number {
    return pendulumChargeLevel(this.swingAngle, this.pendulumAmplitude);
  }

  /** 预警进度 0–1（球外倒计时圆环） */
  get warnProgress(): number {
    return pendulumWarnProgress(this.swingTime, this.pendulumAmplitude, this.pendulumSpeed, this.pendulumPhase, this.pendulumWarnLead);
  }

  /** 按游戏时间更新摆锤位置，并推进充能/消磁状态 */
  updateSwing(time: number) {
    const amp = this.pendulumAmplitude;
    const spd = this.pendulumSpeed;
    const phase = this.pendulumPhase;
    // 时间回退（重开/复活）时重置状态，避免把上一轮的充能状态带进来
    if (time < this.swingTime) {
      this.swingTime = time;
      this.wasCharged = false;
      this.dischargeGrace = 0;
    }
    const dt = Math.max(0, Math.min(0.1, time - this.swingTime));
    this.swingTime = time;
    this.swingAngle = pendulumAngle(time, amp, spd, phase);
    const rope = this.meta?.rope ?? MECH.PEND.rope;
    this.ballCX = this.x + this.w / 2 + Math.sin(this.swingAngle) * rope;
    this.ballCY = this.y + Math.cos(this.swingAngle) * rope;

    const charged = this.isCharged;
    if (this.wasCharged && !charged) {
      this.dischargeGrace = MECH.PEND.dischargeGrace;
    } else if (!charged) {
      this.dischargeGrace = Math.max(0, this.dischargeGrace - dt);
    }
    this.wasCharged = charged;
  }

  /** 统一的动态障碍更新入口（摆锤 / 移动浮台）；由 GameScene 每帧以关卡时间调用 */
  updateMotion(time: number) {
    if (this.kind === 'PENDULUM') {
      this.updateSwing(time);
      return;
    }
    if (this.kind === 'MOVING_PLATFORM') {
      const axis = this.meta?.axis ?? 'y';
      const range = this.meta?.range ?? 90;
      const period = Math.max(0.5, this.meta?.period ?? 3.0);
      const phase = this.meta?.phase ?? ((this.x % 360) / 360);
      const off = Math.sin((Math.PI * 2 * time) / period + phase * Math.PI * 2) * range;
      if (axis === 'x') { this.ox = off; this.oy = 0; }
      else { this.ox = 0; this.oy = off; }
      // 浮台越界 clamp 在地板与天花板之间（PRD FR-06 边界）
      const minY = GAME_CONFIG.CEILING_Y + 40;
      const maxY = GAME_CONFIG.GROUND_Y - this.h;
      const clampedY = Math.max(minY, Math.min(maxY, this.y + this.oy));
      this.oy = clampedY - this.y;
      return;
    }
    if (this.kind === 'POLARITY_WALL') {
      // M05 滑动相位墙：水平正弦往复（无 range 时保持静止）
      const range = this.meta?.range ?? 0;
      if (range > 0) {
        const period = Math.max(0.5, this.meta?.period ?? 3.0);
        const phase = this.meta?.phase ?? ((this.x % 360) / 360);
        this.ox = Math.sin((Math.PI * 2 * time) / period + phase * Math.PI * 2) * range;
      } else {
        this.ox = 0;
      }
      this.oy = 0;
      return;
    }
    this.ox = 0;
    this.oy = 0;
  }

  // ---- 脉冲激光时间状态（FR-06，必须由关卡时间计算，保证确定性）----

  get laserPeriod(): number {
    return Math.max(GAME_CONFIG.PULSE_LASER_WARN + 0.2, this.meta?.period ?? 2.8);
  }

  get laserWarnTime(): number {
    return Math.max(GAME_CONFIG.PULSE_LASER_WARN, this.meta?.warn ?? GAME_CONFIG.PULSE_LASER_WARN);
  }

  get laserOnTime(): number {
    const v = this.meta?.on ?? 0.5;
    const min = GAME_CONFIG.PULSE_LASER_ON_MIN;
    const max = GAME_CONFIG.PULSE_LASER_ON_MAX;
    return Math.max(min, Math.min(max, v));
  }

  private laserCycleTime(time: number): number {
    const period = this.laserPeriod;
    const phase = this.meta?.phase ?? ((this.x / 400) % 1);
    const t = (time + phase * period) % period;
    return t < 0 ? t + period : t;
  }

  /** 0 = 关闭，1 = 预警，2 = 激活（致死） */
  laserState(time: number): 0 | 1 | 2 {
    if (this.kind !== 'PULSE_LASER') return 0;
    const t = this.laserCycleTime(time);
    if (t < this.laserWarnTime) return 1;
    if (t < this.laserWarnTime + this.laserOnTime) return 2;
    return 0;
  }

  // ---- 渲染 ----

  render(ctx: CanvasRenderingContext2D, time: number) {
    if (this.collected && (this.kind === 'COLLECTIBLE' || this.kind === 'SPECIAL_ITEM' || this.kind === 'CORE_BAIT')) return;
    const c = this.color;
    ctx.save();
    switch (this.kind) {
      case 'RED_SPIKE':
      case 'BLUE_SPIKE':
        this.renderSpikes(ctx, c);
        break;
      case 'WALL':
        this.renderPillar(ctx, time);
        break;
      case 'PORTAL_A':
      case 'PORTAL_B':
        this.renderPortal(ctx, c, time);
        break;
      case 'POLARITY_ZONE':
        this.renderPolarityZone(ctx, c, time);
        break;
      case 'GRAVITY_FLIP':
        this.renderGravityFlip(ctx, c, time);
        break;
      case 'SPEED_BOOST':
        this.renderSpeedBoost(ctx, c, time);
        break;
      case 'PENDULUM':
        this.renderPendulum(ctx, c, time);
        break;
      case 'COLLECTIBLE':
        this.renderGem(ctx, time);
        break;
      case 'SPECIAL_ITEM':
        this.renderStarItem(ctx, time);
        break;
      case 'SPECIAL_DOOR':
        this.renderSpecialDoor(ctx, time);
        break;
      case 'PLATFORM':
      case 'MOVING_PLATFORM':
        this.renderPlatform(ctx, time);
        break;
      case 'POLARITY_WALL':
        this.renderPolarityWall(ctx, c, time);
        break;
      case 'PULSE_LASER':
        this.renderPulseLaser(ctx, c, time);
        break;
      case 'MAGNET_RAIN':
        this.renderMagnetRain(ctx, time);
        break;
      case 'POLARITY_LOCK':
        this.renderPolarityLock(ctx, time);
        break;
      case 'CORE_BAIT':
        this.renderCoreBait(ctx, time);
        break;
      case 'MAGNET_MIRROR':
        this.renderMagnetMirror(ctx, time);
        break;
      case 'LAUNCH_PAD':
        this.renderLaunchPad(ctx, c, time);
        break;
      case 'CONVEYOR':
        this.renderConveyor(ctx, time);
        break;
      case 'PIT':
        this.renderPit(ctx, time);
        break;
      case 'COMBO_GATE':
        this.renderComboGate(ctx, time);
        break;
      case 'FINISH':
        this.renderFinish(ctx, time);
        break;
    }
    ctx.restore();
  }

  private renderSpikes(ctx: CanvasRenderingContext2D, c: string) {
    // 参考图：圆润三角 + 粗白描边（推翻上一轮的纯色实心三角）
    const onCeiling = this.y < GAME_CONFIG.GROUND_Y - 200;
    const { x, y, w, h } = this;
    const spikes = Math.max(1, Math.round(w / 18));
    const sw = w / spikes;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    for (let i = 0; i < spikes; i++) {
      const sx = x + i * sw;
      const tipX = sx + sw / 2;
      if (onCeiling) roundTriangle(ctx, sx, y, tipX, y + h, sx + sw, y, Math.min(sw, h) * 0.2);
      else roundTriangle(ctx, sx, y + h, tipX, y, sx + sw, y + h, Math.min(sw, h) * 0.2);
    }
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.stroke();

    // 色弱刻印：收小、只落在尖刺内部，靠白色笔画而非大圆底
    const markSize = clamp(Math.min(sw, h) * 0.46, 9, 11);
    const pol = this.kind === 'BLUE_SPIKE' ? 'BLUE' : 'RED';
    for (let i = 0; i < spikes; i++) {
      const cx = x + i * sw + sw / 2;
      const cy = onCeiling ? y + h * 0.4 : y + h * 0.62;
      drawPolarityMark(ctx, cx, cy, markSize, pol);
    }
    ctx.restore();
  }

  /** 磁能石柱（自动判定落地柱 / 吊顶柱）：竖向圆角柱 + 圆柱高光 + 光晕 */
  private renderPillar(ctx: CanvasRenderingContext2D, time: number) {
    const onCeiling = this.y < GAME_CONFIG.GROUND_Y - 200;
    const { x, y, w, h } = this;
    const radius = 8;

    // ---- 柱身：竖向圆角柱 + 横向金属渐变（圆柱感）+ 光晕 ----
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#2b2b38');
    grad.addColorStop(0.18, '#9a9ab4');
    grad.addColorStop(0.42, '#d7d7e6');
    grad.addColorStop(0.64, '#7d7d96');
    grad.addColorStop(1, '#2b2b38');
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.stroke();
    ctx.restore();

    // 白色竖向高光 + 右侧暗边
    ctx.fillStyle = withAlpha(UI.paper, 0.45);
    ctx.beginPath();
    ctx.roundRect(x + Math.max(3, w * 0.2), y + 8, Math.max(2, w * 0.14), Math.max(2, h - 16), 4);
    ctx.fill();
    ctx.fillStyle = withAlpha(UI.ink, 0.22);
    ctx.beginPath();
    ctx.roundRect(x + w - Math.max(5, w * 0.24), y + 8, Math.max(2, w * 0.1), Math.max(2, h - 16), 3);
    ctx.fill();

    // ---- 固定端法兰盘（圆角加宽板 + 两颗螺栓）----
    const baseY = onCeiling ? y : y + h - 12;
    toonShape(ctx, { x: x - 8, y: baseY, w: w + 16, h: 12 }, {
      fill: '#8b8ba6', stroke: PALETTE.dust050, lineWidth: STROKE.sticker, radius: 6,
    });
    ctx.fillStyle = withAlpha(UI.paper, 0.35);
    ctx.fillRect(x - 6, baseY + 1.5, w + 12, 2);
    ctx.fillStyle = UI.paper;
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.detail;
    for (const bx of [x + 2, x + w - 2]) {
      ctx.beginPath();
      ctx.arc(bx, baseY + 6, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ---- 自由端警示帽：黄黑斜纹 ----
    const capH = 16;
    const capY = onCeiling ? y + h - capH : y;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - 4, capY, w + 8, capH, 6);
    ctx.clip();
    ctx.fillStyle = UI.color.lemon;
    ctx.fillRect(x - 4, capY, w + 8, capH);
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = 6;
    for (let sx = x - 18; sx < x + w + 18; sx += 14) {
      ctx.beginPath();
      ctx.moveTo(sx, capY + capH + 2);
      ctx.lineTo(sx + 12, capY - 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.beginPath();
    ctx.roundRect(x - 4, capY, w + 8, capH, 6);
    ctx.stroke();

    // ---- 自由端警示灯：带光晕的灯珠 ----
    const lampY = onCeiling ? y + h + 6 : y - 6;
    const lampPulse = 0.55 + Math.sin(time * 7) * 0.45;
    ctx.shadowColor = COLORS.RED;
    ctx.shadowBlur = 8 + lampPulse * 8;
    ctx.fillStyle = withAlpha(COLORS.RED, 0.6 + lampPulse * 0.4);
    ctx.beginPath();
    ctx.arc(x + w / 2, lampY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 极性刻印：只在有极性的柱子上，落在固定端附近的柱身下部
    const pol = this.polarity;
    if (pol) {
      const markY = onCeiling ? y + 30 : y + h - 30;
      drawPolarityMark(ctx, x + w / 2, markY, 12, pol);
    }
  }

  private renderPortal(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const pulse = 0.9 + Math.sin(time * 5) * 0.1;
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2;
    const rx = (this.w / 2) * pulse;
    const ry = (this.h / 2) * pulse;

    // 环体：亮色填充 + 粗白描边（参考图贴纸画法，去掉同色光晕）
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 内洞：浅色漩涡底
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(2, rx * 0.62), Math.max(2, ry * 0.62), 0, 0, Math.PI * 2);
    ctx.fillStyle = UI.paper;
    ctx.fill();

    // 旋转漩涡弧
    ctx.strokeStyle = c;
    ctx.lineWidth = STROKE.charged;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(2, rx * 0.66), Math.max(2, ry * 0.66), time * 2, 0, Math.PI * 1.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(2, rx * 0.4), Math.max(2, ry * 0.4), -time * 2.4, Math.PI, Math.PI * 2.4);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private renderPolarityZone(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const { x, y, w, h } = this;

    // 极性区：实色深铁板 + 暗边，颜色只留在边框与符号上（不再整片半透明发光）
    toonShape(ctx, { x, y, w, h }, {
      fill: COLORS.PLATFORM, stroke: UI.ink, lineWidth: STROKE.charged, radius: 14,
    });

    // 内部虚线装饰框（极性色细线）
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = STROKE.detail;
    ctx.strokeStyle = withAlpha(c, 0.55);
    ctx.beginPath();
    ctx.roundRect(x + 7, y + 7, Math.max(2, w - 14), Math.max(2, h - 14), 10);
    ctx.stroke();
    ctx.restore();

    // 前进箭头（深靛描边 + 亮色芯，随时间轻微浮动）
    const cy = y + h / 2;
    const bob = Math.sin(time * 4) * 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const ax = x + w / 2 - 22 + i * 18 + bob;
      ctx.beginPath();
      ctx.moveTo(ax, cy - 11);
      ctx.lineTo(ax + 10, cy);
      ctx.lineTo(ax, cy + 11);
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = c;
      ctx.lineWidth = STROKE.charged;
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  private renderGravityFlip(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const { x, y, w, h } = this;

    // 反转区：实色深铁板 + 暗边（不再整片半透明填充）
    toonShape(ctx, { x, y, w, h }, {
      fill: COLORS.PLATFORM, stroke: UI.ink, lineWidth: STROKE.charged, radius: 14,
    });

    // 内部虚线装饰框（极性色细线）
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = withAlpha(c, 0.55);
    ctx.lineWidth = STROKE.detail;
    ctx.beginPath();
    ctx.roundRect(x + 7, y + 7, Math.max(2, w - 14), Math.max(2, h - 14), 10);
    ctx.stroke();
    ctx.restore();

    // 上下双箭头（圆角三角）表示重力翻转
    const cx = x + w / 2;
    const bob = Math.sin(time * 3) * 2;
    const halfW = Math.min(11, w * 0.3);
    const arrow = (tipX: number, tipY: number, baseY: number) => {
      const d = Math.min(halfW * 0.5, 6);
      const lx = tipX - halfW;
      const rx = tipX + halfW;
      const len = Math.hypot(halfW, baseY - tipY) || 1;
      const p1x = tipX + ((lx - tipX) / len) * d;
      const p1y = tipY + ((baseY - tipY) / len) * d;
      const p2x = tipX + ((rx - tipX) / len) * d;
      const p2y = tipY + ((baseY - tipY) / len) * d;
      ctx.beginPath();
      ctx.moveTo(lx, baseY);
      ctx.lineTo(p1x, p1y);
      ctx.quadraticCurveTo(tipX, tipY, p2x, p2y);
      ctx.lineTo(rx, baseY);
      ctx.closePath();
    };

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.fillStyle = c;
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.detail;
    // 上箭头（朝上）
    ctx.shadowColor = c;
    ctx.shadowBlur = 10;
    arrow(cx, y + h * 0.16 - bob, y + h * 0.42 - bob);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    // 下箭头（朝下）
    ctx.shadowColor = c;
    ctx.shadowBlur = 10;
    arrow(cx, y + h * 0.84 + bob, y + h * 0.58 + bob);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.restore();
  }

  /** 氮气加速踏板：白色糖果踏板 + 蓝色流光箭头 */
  private renderSpeedBoost(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const { x, y, w, h } = this;
    const cy = y + h / 2;
    const cyan = UI.color.accent2;

    // 踏板主体：白底 + 深靛描边 + 轻量光晕
    ctx.save();
    ctx.shadowColor = cyan;
    ctx.shadowBlur = 12;
    toonShape(ctx, { x, y, w, h }, {
      fill: c, stroke: UI.ink, lineWidth: STROKE.charged, radius: 8,
    });
    ctx.restore();

    // 顶面蓝色落脚条
    toonShape(ctx, { x: x + 4, y: y + 3, w: Math.max(2, w - 8), h: 5 }, {
      fill: cyan, lineWidth: 0, radius: 3,
    });

    // 流动的双 V 箭头（向右冲刺）
    const chevrons = Math.max(2, Math.floor(w / 44));
    const span = w / chevrons;
    const off = (time * 260) % span;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = -1; i <= chevrons; i++) {
      const cxp = x + 10 + i * span + off;
      const fade = Math.max(0, Math.min(1, (cxp - x) / 18, (x + w - cxp) / 18 + 0.2));
      ctx.globalAlpha = 0.35 + fade * 0.65;
      ctx.beginPath();
      ctx.moveTo(cxp - 6, cy - 5);
      ctx.lineTo(cxp + 2, cy);
      ctx.lineTo(cxp - 6, cy + 5);
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = cyan;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = cyan;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';

    // 四角铆钉
    ctx.fillStyle = UI.ink;
    ctx.beginPath(); ctx.arc(x + 5, y + 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 5, y + 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 5, y + h - 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 5, y + h - 2, 2, 0, Math.PI * 2); ctx.fill();
  }

  /** 磁暴摆锤：锚点 + 能量绳 + 带眼睛与极性字母的卡通球 */
  private renderPendulum(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const anchor = this.pendulumAnchor;
    const rope = this.meta?.rope ?? MECH.PEND.rope;
    const amp = this.pendulumAmplitude;
    const hotAngle = amp * MECH.PEND.chargeRatio;
    const charge = this.chargeLevel;
    const warned = this.isWarned;
    const warnP = this.warnProgress;
    const pulse = 0.5 + Math.sin(time * 10) * 0.5;

    // 地面投影：始终可见，用来预判摆球的水平落点；充能/预警时加深并脉冲
    const shadowY = GAME_CONFIG.GROUND_Y - 6;
    const shW = clamp(this.ballR * 2.4 - (shadowY - this.ballCY) * 0.05, 14, 46);
    ctx.fillStyle = withAlpha(UI.ink, 0.10 + charge * 0.20 + (warned ? 0.06 * pulse : 0));
    ctx.beginPath();
    ctx.ellipse(this.ballCX, shadowY, shW, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // 摆动轨迹淡弧
    ctx.strokeStyle = withAlpha(UI.ink, 0.14);
    ctx.lineWidth = STROKE.detail;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, rope, Math.PI / 2 - amp, Math.PI / 2 + amp);
    ctx.stroke();

    // 危险区段：摆球最低、最靠近跑道的中心弧段；用实色标出，不再做同色光晕
    if (charge > 0 || warned) {
      ctx.strokeStyle = c;
      ctx.lineWidth = STROKE.charged;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, rope, Math.PI / 2 - hotAngle, Math.PI / 2 + hotAngle);
      ctx.stroke();
    }

    // 磁力场半径（仅用于预警虚线环）
    const fieldR = MECH.PEND.magnetRange;
    if (warned) {
      // 预警虚线外圈：琥珀实色虚线，给出明确反应窗口
      ctx.strokeStyle = UI.color.lemon;
      ctx.lineWidth = STROKE.charged;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(this.ballCX, this.ballCY, fieldR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 绳（深靛外描边 + 浅色芯）
    ctx.lineCap = 'round';
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.hero;
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(this.ballCX, this.ballCY);
    ctx.stroke();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.charged;
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(this.ballCX, this.ballCY);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // 锚点座：圆角铆钉盘
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.GRAY;
    ctx.fill();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = UI.paper;
    ctx.fill();

    // 摆球：冷态半透明（可安全穿过），充能时加一圈实色细环
    const r = this.ballR;
    if (charge > 0) {
      ctx.strokeStyle = withAlpha(c, 0.55);
      ctx.lineWidth = STROKE.detail;
      ctx.beginPath();
      ctx.arc(this.ballCX, this.ballCY, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.55 + charge * 0.45;
    ctx.beginPath();
    ctx.arc(this.ballCX, this.ballCY, r, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.stroke();

    // 高光
    ctx.beginPath();
    ctx.ellipse(this.ballCX - r * 0.3, this.ballCY - r * 0.35, r * 0.3, r * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(UI.paper, 0.6);
    ctx.fill();

    // 眼睛（瞳孔朝摆动方向偏移）
    const look = Math.sin(this.pendulumAngle) * r * 0.18;
    const ey = this.ballCY - r * 0.16;
    const ex = r * 0.34;
    const er = Math.max(3, r * 0.19);
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(this.ballCX + s * ex, ey, er, 0, Math.PI * 2);
      ctx.fillStyle = UI.paper;
      ctx.fill();
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = STROKE.detail;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.ballCX + s * ex + look, ey + 1, er * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = UI.ink;
      ctx.fill();
    }

    // 底部极性刻印：+ / − 符号替代 N/S 字母，色弱玩家不必依赖色相
    const pol: 'RED' | 'BLUE' = this.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED';
    drawPolarityMark(ctx, this.ballCX, this.ballCY + r * 0.55, clamp(r * 0.55, 10, 12), pol);
    ctx.globalAlpha = 1;

    // 预警倒计时圆环：从 12 点方向按进度填充，充能前 0.45s 内可见
    if (warned) {
      const ringR = r + 9;
      const start = -Math.PI / 2;
      ctx.strokeStyle = withAlpha(UI.ink, 0.35);
      ctx.lineWidth = STROKE.structure;
      ctx.beginPath();
      ctx.arc(this.ballCX, this.ballCY, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = UI.paper;
      ctx.beginPath();
      ctx.arc(this.ballCX, this.ballCY, ringR, start, start + Math.PI * 2 * warnP);
      ctx.stroke();
    }
  }

  /** 浮空平台：悬浮金属板（单向支撑，可站立，无伤害） */
  private renderPlatform(ctx: CanvasRenderingContext2D, time: number) {
    const x = this.x + this.ox;
    const y = this.y + this.oy;
    const w = this.w;
    const h = this.h;
    const c = COLORS.PLATFORM;

    // 底部悬浮辉光（呼吸）
    const glow = 0.2 + Math.sin(time * 3 + this.x * 0.01) * 0.08;
    const gg = ctx.createLinearGradient(0, y + h, 0, y + h + 26);
    gg.addColorStop(0, withAlpha(c, glow));
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(x + 4, y + h, w - 8, 26);

    // 板体：竖向金属渐变 + 圆角 + 光晕
    const body = ctx.createLinearGradient(x, y, x, y + h);
    body.addColorStop(0, '#b9f3ec');
    body.addColorStop(0.35, c);
    body.addColorStop(1, '#1f7a72');
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.stroke();
    ctx.restore();

    // 顶面能量条（落脚面提示）
    ctx.fillStyle = UI.paper;
    ctx.fillRect(x + 3, y, w - 6, 3);

    // 侧面铆钉
    ctx.fillStyle = withAlpha(UI.ink, 0.8);
    for (let rx = x + 12; rx < x + w - 6; rx += 26) {
      ctx.beginPath(); ctx.arc(rx, y + h / 2 + 1, 2, 0, Math.PI * 2); ctx.fill();
    }

    // 底部悬浮引擎光点
    ctx.fillStyle = withAlpha(c, 0.85);
    const engines = Math.max(2, Math.floor(w / 70));
    for (let i = 0; i < engines; i++) {
      const ex = x + (w * (i + 0.5)) / engines;
      const ey = y + h + 4 + Math.sin(time * 6 + i * 1.7) * 1.5;
      ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** 相位墙：同色可穿、异色致命；半透明条纹 + 极性符号（不新增颜色编码） */
  private renderPolarityWall(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const x = this.x + this.ox;
    const y = this.y + this.oy;
    const w = this.w;
    const h = this.h;
    const alpha = this.triggered ? 0.28 : 0.72;
    toonShape(ctx, { x, y, w, h }, {
      fill: withAlpha(c, alpha), stroke: UI.color.rim, lineWidth: STROKE.charged, radius: 8,
    });

    // 斜条纹（同色系，强化“可以穿过”的视觉）
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.clip();
    ctx.strokeStyle = withAlpha(c, this.triggered ? 0.3 : 0.95);
    ctx.lineWidth = 9;
    for (let sy = y - h; sy < y + h + 20; sy += 26) {
      ctx.beginPath();
      ctx.moveTo(x, sy);
      ctx.lineTo(x + w, sy + w);
      ctx.stroke();
    }
    ctx.restore();

    // 极性符号：红 = “+”，蓝 = “−”（形状编码，色弱可用）
    const cx = x + w / 2;
    const cy = y + h / 2;
    const s = Math.min(18, Math.max(9, Math.min(w, h) * 0.22));
    const pulse = 0.75 + Math.sin(time * 4 + x * 0.02) * 0.25;
    ctx.fillStyle = UI.paper;
    ctx.beginPath();
    ctx.arc(cx, cy, s + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.detail;
    ctx.stroke();
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = Math.max(3, s * 0.28);
    ctx.globalAlpha = pulse;
    ctx.beginPath();
    const p = this.meta?.polarity === 'BLUE' ? '−' : '+';
    ctx.moveTo(cx - s * 0.55, cy);
    ctx.lineTo(cx + s * 0.55, cy);
    if (p === '+') {
      ctx.moveTo(cx, cy - s * 0.55);
      ctx.lineTo(cx, cy + s * 0.55);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = UI.color.rim;
    ctx.lineWidth = STROKE.charged;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.stroke();
  }

  /** 脉冲激光：关闭=淡虚线，预警=琥珀蓄能虚线，激活=带电光束 + 双刃线 */
  private renderPulseLaser(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const { x, y, w, h } = this;
    const state = this.laserState(time);
    const vertical = (this.meta?.orientation ?? 'V') === 'V';

    // 发射器端帽：旧版卡通圆角小铁块 + 白色高光
    const caps = vertical
      ? [
          { x: x - 4, y: y - 6, w: w + 8, h: 8 },
          { x: x - 4, y: y + h - 2, w: w + 8, h: 8 },
        ]
      : [
          { x: x - 6, y: y + h - 2, w: 8, h: 8 },
          { x: x + w - 2, y: y + h - 2, w: 8, h: 8 },
        ];
    for (const cap of caps) {
      toonShape(ctx, cap, {
        fill: UI.ink, stroke: PALETTE.dust050, lineWidth: STROKE.sticker, radius: 4,
      });
      ctx.fillStyle = withAlpha(UI.paper, 0.55);
      ctx.fillRect(cap.x + 2, cap.y + 1.5, Math.max(2, cap.w - 4), 1.5);
    }

    const line = () => {
      ctx.beginPath();
      if (vertical) { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); }
      else { ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); }
      ctx.stroke();
    };

    if (state === 2) {
      // 激活：实色光束 + 白色内芯（去掉外层光晕）
      ctx.save();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
      ctx.fill();
      ctx.strokeStyle = PALETTE.dust050;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = withAlpha(UI.paper, 0.95);
      ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.28);
      ctx.lineCap = 'round';
      line();
      ctx.restore();
    } else if (state === 1) {
      // 预警：琥珀短促脉冲虚线，明显可见
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(time * Math.PI * 6));
      ctx.save();
      ctx.setLineDash([8, 8]);
      ctx.lineDashOffset = -time * 40;
      ctx.strokeStyle = withAlpha(UI.color.lemon, 0.3 + 0.4 * pulse);
      ctx.lineWidth = 5;
      line();
      ctx.strokeStyle = withAlpha(UI.color.lemon, 0.95);
      ctx.lineWidth = 2;
      line();
      ctx.restore();
    } else {
      // 关闭：一条很淡的线
      ctx.strokeStyle = withAlpha(c, 0.18);
      ctx.lineWidth = 2;
      line();
    }
  }

  // ---- 新遭遇机制渲染（P0 / P1）----

  /** M01 磁芯雨：雨带内周期性下落的红/蓝磁芯 */
  private renderMagnetRain(ctx: CanvasRenderingContext2D, time: number) {
    const { x, w } = this;
    const count = this.meta?.count ?? MECH.RAIN.count;
    const base = (this.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED') as Polarity;

    // 雨带边界（虚线，表明这是“雨区”而非实体）
    ctx.strokeStyle = withAlpha(COLORS.COLLECTIBLE, 0.55);
    ctx.lineWidth = STROKE.detail;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.moveTo(x, GAME_CONFIG.CEILING_Y);
    ctx.lineTo(x, GAME_CONFIG.GROUND_Y);
    ctx.moveTo(x + w, GAME_CONFIG.CEILING_Y);
    ctx.lineTo(x + w, GAME_CONFIG.GROUND_Y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < count; i++) {
      if (this.rainHits & (1 << i)) continue;
      const cx = x + 20 + i * MECH.RAIN.gap;
      const cy = rainCoreY(time, i, GAME_CONFIG.CEILING_Y, GAME_CONFIG.GROUND_Y, MECH.RAIN.size);
      const p = i % 2 === 0 ? base : (base === 'RED' ? 'BLUE' : 'RED');
      const color = p === 'RED' ? COLORS.RED : COLORS.BLUE;
      const r = MECH.RAIN.size / 2;

      // 磁芯外环：细实线，不再用同色半透明填充
      ctx.strokeStyle = withAlpha(color, 0.55);
      ctx.lineWidth = STROKE.detail;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = STROKE.charged;
      ctx.stroke();

      // 磁芯符号：红 + / 蓝 −
      ctx.strokeStyle = UI.paper;
      ctx.lineWidth = 2.5;
      const s = r * 0.52;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx + s, cy);
      if (p === 'RED') { ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy + s); }
      ctx.stroke();
    }
  }

  /** M02 极性锁：门廊内禁止换色 */
  private renderPolarityLock(ctx: CanvasRenderingContext2D, time: number) {
    const { x, y, w, h } = this;
    const active = this.triggered;
    const c = COLORS.GRAY;

    toonShape(ctx, { x, y, w, h }, {
      fill: withAlpha(c, active ? 0.22 : 0.12), stroke: UI.ink, lineWidth: STROKE.charged, radius: 10,
    });

    // 门柱
    toonShape(ctx, { x: x - 10, y, w: 12, h }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 6,
    });
    toonShape(ctx, { x: x + w - 2, y, w: 12, h }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 6,
    });

    // 锁链横纹（提示“换色被锁住”）
    ctx.strokeStyle = withAlpha(UI.ink, 0.55);
    ctx.lineWidth = STROKE.detail;
    for (let yy = y + 40; yy < y + h - 30; yy += 46) {
      ctx.beginPath();
      ctx.moveTo(x + 2, yy);
      ctx.lineTo(x + w - 2, yy);
      ctx.stroke();
    }

    // 中央挂锁
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy - 8, 10, Math.PI, 0);
    ctx.stroke();
    toonShape(ctx, { x: cx - 15, y: cy - 8, w: 30, h: 24 }, {
      fill: active ? UI.color.lemon : UI.color.gold, stroke: UI.ink, lineWidth: STROKE.charged, radius: 7,
    });
    ctx.fillStyle = UI.ink;
    ctx.beginPath();
    ctx.arc(cx, cy + 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 1.5, cy + 2, 3, 8);

    // 激活时用琥珀虚线框提示，不再做外发光
    if (active) {
      ctx.strokeStyle = UI.color.lemon;
      ctx.lineWidth = STROKE.charged;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.roundRect(x - 4, y, w + 8, h, 12);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** M07 磁芯诱饵：悬空金芯，拾取后锁换色 */
  private renderCoreBait(ctx: CanvasRenderingContext2D, time: number) {
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2 + Math.sin(time * 2.4 + this.x * 0.01) * 4;
    const r = this.w / 2;

    // 悬吊绳
    ctx.strokeStyle = withAlpha(UI.ink, 0.4);
    ctx.lineWidth = STROKE.detail;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cy - r - 4);
    ctx.stroke();

    // 磁芯细环：实线轮廓替代外扩填充
    ctx.strokeStyle = withAlpha(COLORS.COLLECTIBLE, 0.55);
    ctx.lineWidth = STROKE.detail;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.stroke();

    // 磁芯主体（金色 + 深靛描边 + 红蓝双极）
    toonShape(ctx, { x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, {
      fill: COLORS.COLLECTIBLE, stroke: UI.ink, lineWidth: STROKE.charged, radius: r,
    });
    ctx.fillStyle = COLORS.RED;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.34, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.BLUE;
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.34, r * 0.28, 0, Math.PI * 2);
    ctx.fill();

    // 锁形小标（提示换色权会被锁）
    drawStickerText(ctx, '锁', cx, cy - r - 16, {
      font: 'bold 13px "Microsoft YaHei", sans-serif',
      fill: UI.paper, stroke: UI.ink, lineWidth: 3,
      align: 'center', baseline: 'middle',
    });
  }

  /** M09 磁极镜：强制反转极性 */
  private renderMagnetMirror(ctx: CanvasRenderingContext2D, time: number) {
    const { x, y, w, h } = this;
    const used = this.triggered;
    const c = COLORS.PORTAL_A;

    // 外框
    toonShape(ctx, { x: x - 6, y: y - 6, w: w + 12, h: h + 12 }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 12,
    });
    // 镜面
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.clip();
    ctx.fillStyle = withAlpha(c, used ? 0.25 : 0.55 + Math.sin(time * 4) * 0.12);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = withAlpha(UI.paper, 0.55);
    ctx.lineWidth = 7;
    for (let i = -h; i < w + h; i += 22) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.charged;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.stroke();

    // 反转箭头
    drawStickerText(ctx, '⇄', x + w / 2, y + h / 2, {
      font: 'bold 20px "Microsoft YaHei", sans-serif',
      fill: UI.paper, stroke: UI.ink, lineWidth: 3,
      align: 'center', baseline: 'middle',
    });
  }

  /** M03 极性弹射板：同色高弹、异色低弹 */
  private renderLaunchPad(ctx: CanvasRenderingContext2D, c: string, time: number) {
    const { x, y, w, h } = this;
    const compress = this.triggered ? 0 : Math.sin(time * 3 + x * 0.02) * 3;

    // 底座
    toonShape(ctx, { x, y: y + h - 8, w, h: 12 }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 7,
    });

    // 弹簧
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.detail;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const yy = y + h - 10 - i * 7 + compress;
      ctx.moveTo(x + 12, yy);
      ctx.lineTo(x + w - 12, yy);
    }
    ctx.stroke();

    // 踏板（极性色，带电体亮边）
    toonShape(ctx, { x: x + 6, y: y - 2 + compress, w: w - 12, h: 14 }, {
      fill: c, stroke: UI.color.rim, lineWidth: STROKE.charged, radius: 7,
    });

    // 向上箭头
    const cx = x + w / 2;
    ctx.strokeStyle = UI.paper;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, y + 6 + compress);
    ctx.lineTo(cx, y - 16 + compress);
    ctx.moveTo(cx - 7, y - 9 + compress);
    ctx.lineTo(cx, y - 17 + compress);
    ctx.lineTo(cx + 7, y - 9 + compress);
    ctx.stroke();
  }

  /** M06 极性传送带：方向箭头滚动 */
  private renderConveyor(ctx: CanvasRenderingContext2D, time: number) {
    const x = this.x + this.ox;
    const y = this.y + this.oy;
    const { w, h } = this;
    const dir = this.meta?.dir ?? 1;

    toonShape(ctx, { x, y, w, h }, {
      fill: COLORS.PLATFORM, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 7,
    });

    // 滚动的箭头
    const speed = (this.meta?.speed ?? MECH.CONVEYOR.speed) * 0.5;
    const shift = ((time * speed * dir) % 36 + 36) % 36;
    ctx.strokeStyle = withAlpha(UI.ink, 0.55);
    ctx.lineWidth = STROKE.detail;
    ctx.lineJoin = 'round';
    for (let gx = x - 36 + shift; gx < x + w + 36; gx += 36) {
      const ax = Math.max(x + 6, Math.min(x + w - 6, gx));
      ctx.beginPath();
      ctx.moveTo(ax - 5 * dir, y + 4);
      ctx.lineTo(ax + 5 * dir, y + h / 2);
      ctx.lineTo(ax - 5 * dir, y + h - 4);
      ctx.stroke();
    }
    // 两端滚轮
    ctx.fillStyle = UI.paper;
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.detail;
    for (const rx of [x + 7, x + w - 7]) {
      ctx.beginPath();
      ctx.arc(rx, y + h / 2, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** M10 断桥：地面裂缝，站进去即坠落 */
  private renderPit(ctx: CanvasRenderingContext2D, time: number) {
    const { x, w } = this;
    const top = GAME_CONFIG.GROUND_Y;
    const depth = MECH.PIT.depth;

    // 深坑
    ctx.fillStyle = COLORS.PIT;
    ctx.fillRect(x, top, w, depth);
    // 坑底阴影（统一铁灰阴影，不用彩色）
    ctx.fillStyle = withAlpha(UI.ink, 0.35);
    ctx.fillRect(x, top + depth - 14, w, 14);

    // 断裂地面边缘（锯齿）
    ctx.strokeStyle = UI.color.structureEdge;
    ctx.lineWidth = STROKE.structure;
    ctx.lineJoin = 'round';
    for (const edgeX of [x, x + w]) {
      const s = edgeX === x ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(edgeX, top);
      ctx.lineTo(edgeX - s * 9, top + 6);
      ctx.lineTo(edgeX + s * 2, top + 12);
      ctx.lineTo(edgeX - s * 7, top + 18);
      ctx.lineTo(edgeX + s * 3, top + 26);
      ctx.stroke();
    }

    // 黄黑警示条（坑口）
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, top, w, 8);
    ctx.clip();
    ctx.fillStyle = UI.color.lemon;
    ctx.fillRect(x, top, w, 8);
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = 5;
    for (let sx = x - 10; sx < x + w + 10; sx += 16) {
      ctx.beginPath();
      ctx.moveTo(sx, top + 9);
      ctx.lineTo(sx + 10, top - 1);
      ctx.stroke();
    }
    ctx.restore();

    // 下落速率提示（琥珀实点）
    ctx.fillStyle = withAlpha(UI.color.lemon, 0.55);
    ctx.beginPath();
    ctx.arc(x + w / 2, top + depth - 8, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 金色能量晶片（旋转菱形） */
  private renderGem(ctx: CanvasRenderingContext2D, time: number) {
    // 颜色不符时的左右晃动（0.35s），给玩家“这颗吃不到”的即时反馈
    const bump = time < this.bumpUntil ? Math.sin(time * 70) * 4 : 0;
    const gemColor = this.meta?.color === 'RED'
      ? COLORS.RED
      : this.meta?.color === 'BLUE' ? COLORS.BLUE : COLORS.COLLECTIBLE;
    const cx = this.x + this.w / 2 + bump;
    const cy = this.y + this.h / 2 + Math.sin(time * 3 + this.x) * 3;
    const hw = (this.w / 2) * (0.35 + 0.65 * Math.abs(Math.cos(time * 2.5 + this.x)));
    const hh = this.h / 2;

    // 菱形本体：参考图的金色菱形 + 白描边（去掉细环、光晕与切面高光）
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.fillStyle = this.meta?.color ? gemColor : COLORS.COLLECTIBLE;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.stroke();
  }

  /** 特殊物品：带描边的卡通星核 */
  private renderStarItem(ctx: CanvasRenderingContext2D, time: number) {
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2 + Math.sin(time * 2.2) * 4;
    const r1 = this.w / 2;
    const r2 = r1 * 0.45;
    const rot = time * 1.2;

    // 星核细环：替代外扩半透明光晕
    ctx.strokeStyle = withAlpha(COLORS.SPECIAL_ITEM, 0.55);
    ctx.lineWidth = STROKE.detail;
    ctx.beginPath();
    ctx.arc(cx, cy, r1 * 1.5, 0, Math.PI * 2);
    ctx.stroke();

    // 五角星：扁平橙 + 深靛厚描边
    const star = (radius1: number, radius2: number, angle0: number) => {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? radius1 : radius2;
        const a = angle0 + (i / 10) * Math.PI * 2 - Math.PI / 2;
        const px = cx + Math.cos(a) * rr;
        const py = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    star(r1, r2, rot);
    ctx.fillStyle = COLORS.SPECIAL_ITEM;
    ctx.shadowColor = COLORS.SPECIAL_ITEM;
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = UI.ink;
    ctx.lineWidth = STROKE.charged;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 内侧浅色小星
    star(r1 * 0.55, r2 * 0.55, rot);
    ctx.fillStyle = withAlpha(UI.paper, 0.5);
    ctx.fill();

    // 中心亮点
    ctx.beginPath();
    ctx.arc(cx, cy, r1 * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = UI.paper;
    ctx.fill();
  }

  /** 特殊星门 */
  private renderSpecialDoor(ctx: CanvasRenderingContext2D, time: number) {
    const used = this.triggered;
    const c = COLORS.SPECIAL_DOOR;
    const { x, y, w, h } = this;

    // 门框双柱
    toonShape(ctx, { x: x - 8, y: y - 12, w: 14, h: h + 12 }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 6,
    });
    toonShape(ctx, { x: x + w - 6, y: y - 12, w: 14, h: h + 12 }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 6,
    });
    // 门楣
    toonShape(ctx, { x: x - 12, y: y - 26, w: w + 24, h: 16 }, {
      fill: UI.color.grape, stroke: UI.color.structureEdge, lineWidth: STROKE.structure, radius: 8,
    });

    // 门洞能量（半透明同色 + 深靛描边）
    toonShape(ctx, { x, y, w, h }, {
      fill: withAlpha(c, used ? 0.18 : 0.5 + Math.sin(time * 3) * 0.12),
      stroke: UI.ink, lineWidth: STROKE.charged, radius: 10,
    });

    // 旋涡环（深靛描边 + 白色流线）
    if (!used) {
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const t = time * 1.5 + i * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.max(4, w / 2 - 8), Math.max(6, h / 2 - 12), 0, t, t + Math.PI * 0.9);
        ctx.strokeStyle = UI.paper;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.shadowColor = c;
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      ctx.lineCap = 'butt';
    }

    // 门楣上的星标
    drawStickerText(ctx, '✦', x + w / 2, y - 18, {
      font: `bold 14px ${UI.font.ui}`,
      fill: used ? UI.color.dim : UI.color.gold,
      stroke: UI.ink, lineWidth: 3,
      align: 'center', baseline: 'middle',
    });

    // 教程演示门：展示但不传送
    if (this.meta?.demo === true) {
      drawStickerText(ctx, '演示', x + w / 2, y + h / 2, {
        font: 'bold 12px "Microsoft YaHei", sans-serif',
        fill: UI.paper, stroke: UI.ink, lineWidth: 3,
        align: 'center', baseline: 'middle',
      });
    }
  }

  /** 连击门：必须 combo ≥ required 才能穿过，否则等同实体墙 */
  private renderComboGate(ctx: CanvasRenderingContext2D, time: number) {
    const { x, y, w, h } = this;
    const req = this.meta?.required ?? 10;
    const open = this.triggered;
    const pulse = 0.75 + Math.sin(time * 5 + x * 0.01) * 0.25;
    const cyan = UI.color.accent2;

    // 门柱（始终可见）
    for (const colX of [x - 6, x + w]) {
      toonShape(ctx, { x: colX, y: y - 4, w: 12, h: h + 8 }, {
        fill: open ? COLORS.GRAVITY : UI.color.mint,
        stroke: UI.color.structureEdge,
        lineWidth: STROKE.structure,
        radius: 6,
      });
    }

    // 门楣（显示所需连击数）
    toonShape(ctx, { x: x - 8, y: y - 16, w: w + 16, h: 14 }, {
      fill: open ? COLORS.GRAVITY : COLORS.BLUE,
      stroke: UI.color.structureEdge,
      lineWidth: STROKE.structure,
      radius: 7,
    });

    // 连击数显示
    drawStickerText(ctx, `×${req}`, x + w / 2, y - 9, {
      font: `bold 13px ${UI.font.mono}`,
      fill: UI.paper, stroke: UI.ink, lineWidth: 3,
      align: 'center', baseline: 'middle',
    });

    // 门洞（未开启时半透明锁纹；开启后通透绿色）
    if (open) {
      ctx.fillStyle = withAlpha(COLORS.GRAVITY, 0.22 + pulse * 0.12);
    } else {
      ctx.fillStyle = withAlpha(UI.ink, 0.16);
    }
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = open ? withAlpha(COLORS.GRAVITY, 0.7) : withAlpha(UI.color.accent2, 0.55);
    ctx.lineWidth = STROKE.charged;
    if (open) ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 未开启时的锁纹（对角线）
    if (!open) {
      ctx.strokeStyle = withAlpha(UI.ink, 0.25);
      ctx.lineWidth = STROKE.detail;
      for (let sy = y - h; sy < y + h + h; sy += 22) {
        ctx.beginPath();
        ctx.moveTo(x, sy);
        ctx.lineTo(x + w, sy + w);
        ctx.stroke();
      }
      // 中央锁标
      drawStickerText(ctx, '锁', x + w / 2, y + h / 2, {
        font: `bold 18px ${UI.font.ui}`,
        fill: UI.color.lemon, stroke: UI.ink, lineWidth: 3,
        align: 'center', baseline: 'middle',
      });
    }
  }

  private renderFinish(ctx: CanvasRenderingContext2D, time: number) {
    const { x, y, w, h } = this;
    const radius = UI.radius.sm;

    if (this.locked) {
      // 锁定终点：灰化棋盘 + 方形挂锁 + 底部琥珀警示带
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.clip();
      const sq = 12;
      for (let r = 0; r * sq < h; r++) {
        for (let cc = 0; cc * sq < w; cc++) {
          ctx.fillStyle = (r + cc) % 2 === 0 ? UI.color.sub : COLORS.GRAY;
          ctx.fillRect(x + cc * sq, y + r * sq, sq, sq);
        }
      }
      // 底部琥珀警示带（斜纹）：唯一说明「还差条件」的信息
      const bandH = 10;
      ctx.fillStyle = UI.color.lemon;
      ctx.fillRect(x, y + h - bandH, w, bandH);
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = 4;
      for (let sx = x - 10; sx < x + w + 10; sx += 10) {
        ctx.beginPath();
        ctx.moveTo(sx, y + h);
        ctx.lineTo(sx + bandH, y + h - bandH);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = STROKE.structure;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.stroke();

      // 方形挂锁（直角锁体 + 深色锁梁 + 钥匙孔）
      const lx = x + w / 2;
      const ly = y + h / 2;
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(lx, ly - 4, 8, Math.PI, 0);
      ctx.stroke();
      toonShape(ctx, { x: lx - 12, y: ly - 4, w: 24, h: 20 }, {
        fill: UI.color.gold, stroke: UI.ink, lineWidth: STROKE.charged, radius: 0,
      });
      ctx.fillStyle = UI.ink;
      ctx.beginPath();
      ctx.arc(lx, ly + 3, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(lx - 1.5, ly + 3, 3, 6);
      return;
    }

    // ---- 旧版黑白格旗：棋盘格柱 + 白描边（去掉呼吸光晕）----
    const sq = 12;
    for (let r = 0; r * sq < h; r++) {
      for (let cc = 0; cc * sq < w; cc++) {
        ctx.fillStyle = (r + cc) % 2 === 0 ? UI.paper : '#333344';
        ctx.fillRect(x + cc * sq, y + r * sq, Math.min(sq, w - cc * sq), Math.min(sq, h - r * sq));
      }
    }
    ctx.strokeStyle = PALETTE.dust050;
    ctx.lineWidth = STROKE.sticker;
    ctx.strokeRect(x, y, w, h);
  }
}
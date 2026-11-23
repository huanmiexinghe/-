// 玩家角色：磁极双子

import { GAME_CONFIG, Polarity, polarityColor } from '../data/config';
import { MECH } from '../systems/Mechanics';
import { UI, PALETTE, STROKE } from '../ui/theme';
import { AABB, clamp } from '../utils/Math';
import { withAlpha } from '../utils/Color';

/** 角色绘制姿态：本地玩家与远端玩家共用同一套完整本体渲染（实心、表情、投影） */
export interface RunnerPose {
  x: number;
  y: number;
  width: number;
  height: number;
  polarity: Polarity;
  sliding: boolean;
  grounded: boolean;
  /** 重力翻转（倒挂）：y 为顶部 */
  flipped: boolean;
  flipAngle: number;
  runPhase: number;
  squashY: number;
  /** 无敌闪烁剩余时间（秒） */
  invincibleTime: number;
  rainbowMode?: boolean;
  /** 远端玩家描白边，避免与本地同色角色重叠时分不清 */
  ring?: boolean;
  /** 加速前倾角（弧度，正=向前倾）；倒挂时由 drawRunner 自动反向 */
  lean?: number;
  /** 加速横向拉伸（1 = 不拉伸），只做视觉，不改碰撞盒 */
  stretch?: number;
}

/** 绘制一个完整角色本体（不含名字标签/拖尾） */
export function drawRunner(ctx: CanvasRenderingContext2D, pose: RunnerPose, time: number) {
  const color = pose.rainbowMode ? `hsl(${(time * 180) % 360}, 100%, 60%)` : polarityColor(pose.polarity);
  const w = pose.width;
  const h = pose.height;
  const bottomTop = pose.flipped ? pose.y : pose.y + GAME_CONFIG.PLAYER_SIZE - h;
  const cx = pose.x + w / 2;
  const cy = bottomTop + h / 2;

  ctx.save();
  if (pose.invincibleTime > 0 && Math.floor(time * 20) % 2 === 0) ctx.globalAlpha = 0.45;

  ctx.translate(cx, cy);
  ctx.rotate(pose.flipAngle);
  if (pose.lean) ctx.rotate(pose.flipped ? -pose.lean : pose.lean);
  const runBob = pose.grounded && !pose.sliding ? Math.sin(pose.runPhase * 2) * 2 : 0;
  ctx.scale(1 / pose.squashY, pose.squashY);
  if (pose.stretch && pose.stretch !== 1) ctx.scale(pose.stretch, 1);
  ctx.translate(0, runBob);

  const r = 8;

  // 远端区分：铁屑亮边（画在本体下方，只强化轮廓，不做发光）
  if (pose.ring) {
    ctx.beginPath();
    ctx.roundRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, r + 2);
    ctx.fillStyle = PALETTE.dust050;
    ctx.fill();
  }

  // 底部硬投影（接触阴影，四像素偏移，不模糊）
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2 + 4, w, h, r);
  ctx.fillStyle = withAlpha(UI.ink, 0.18);
  ctx.fill();

  // 身体：圆角方块 + 粗白描边（参考图的贴纸画法，不再用同色光晕）
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.dust050;
  ctx.lineWidth = STROKE.sticker;
  ctx.stroke();

  // 卡通脸：两只黑眼睛 + 白色高光点（参考图没有眼白）
  const eyeY = -h * 0.05;
  const eyeDX = w * 0.17;
  const eyeRX = w * 0.085;
  const eyeRY = h * 0.115;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(dir * eyeDX, eyeY, eyeRX, eyeRY, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1b1b26';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dir * eyeDX + w * 0.022, eyeY - h * 0.032, w * 0.026, 0, Math.PI * 2);
    ctx.fillStyle = UI.paper;
    ctx.fill();
  }

  ctx.restore();
}

export class Player {
  x = 0;
  y = 0;
  vx = GAME_CONFIG.RUN_SPEED;
  vy = 0;
  polarity: Polarity = 'RED';
  isGrounded = false;
  isSliding = false;
  invincibleTime = 0;
  switchCooldown = 0;
  slideTimer = 0;
  slideCooldown = 0;
  gravityFlipped = false;
  alive = true;
  combo = 0;

  /** 极性锁剩余时间：>0 时拒绝换色（M02 门廊 / M07 诱饵） */
  polarityLockTimer = 0;
  /** 传送带提供的水平速度（px/s），每帧由 GameScene 注入 */
  conveyorVx = 0;
  /** 摆锤磁力提供的水平推速（px/s），每帧由 GameScene 注入 */
  magnetVx = 0;

  // 加速带
  speedBoostTimer = 0;
  speedBoostMultiplier = 1;
  /** 外部速度系数（无尽模式随时间递增） */
  externalSpeedMul = 1;

  // 动画
  private runPhase = 0;
  private squashY = 1;
  private flipAngle = 0; // 重力翻转动画角度

  // 尾迹计时
  private trailTimer = 0;

  reset(startX: number, startY: number) {
    this.x = startX;
    this.y = startY;
    this.vy = 0;
    this.polarity = 'RED';
    this.isGrounded = true;
    this.isSliding = false;
    this.invincibleTime = 0;
    this.switchCooldown = 0;
    this.slideTimer = 0;
    this.slideCooldown = 0;
    this.polarityLockTimer = 0;
    this.conveyorVx = 0;
    this.magnetVx = 0;
    this.gravityFlipped = false;
    this.alive = true;
    this.combo = 0;
    this.speedBoostTimer = 0;
    this.speedBoostMultiplier = 1;
    this.externalSpeedMul = 1;
    this.squashY = 1;
    this.flipAngle = 0;
  }

  get width() { return GAME_CONFIG.PLAYER_SIZE; }
  get height() {
    return this.isSliding ? GAME_CONFIG.PLAYER_SLIDE_HEIGHT : GAME_CONFIG.PLAYER_SIZE;
  }

  /** 当前实际奔跑速度（含加速带/连击加成） */
  get speed(): number {
    let s = GAME_CONFIG.RUN_SPEED * this.speedBoostMultiplier * this.externalSpeedMul;
    if (this.combo >= 50) s *= 1 + GAME_CONFIG.COMBO_SPEED_BONUS_50;
    else if (this.combo >= 30) s *= 1 + GAME_CONFIG.COMBO_SPEED_BONUS_30;
    else if (this.combo >= 20) s *= 1 + GAME_CONFIG.COMBO_SPEED_BONUS_20;
    return s;
  }

  get bounds(): AABB {
    const h = this.height;
    // 滑行时高度压缩，底部对齐（或重力翻转时顶部对齐）
    const y = this.gravityFlipped ? this.y : this.y + GAME_CONFIG.PLAYER_SIZE - h;
    return { x: this.x, y, w: this.width, h };
  }

  /** 中心点（特效用） */
  get centerX() { return this.x + this.width / 2; }
  get centerY() {
    const b = this.bounds;
    return b.y + b.h / 2;
  }

  switchPolarity(): boolean {
    if (this.polarityLockTimer > 0) return false;
    if (this.switchCooldown > 0) return false;
    this.polarity = this.polarity === 'RED' ? 'BLUE' : 'RED';
    this.switchCooldown = GAME_CONFIG.SWITCH_COOLDOWN;
    // 极短容错（0.1s）提升切换手感；冷却 0.18s > 容错，狂按无法保持无敌。
    // 只取 max：传送/重力翻转给予的较长无敌不会被切换缩短，也不会被无限延长。
    this.invincibleTime = Math.max(this.invincibleTime, GAME_CONFIG.SWITCH_GRACE_TIME);
    // 连击只奖励有效事件（安全穿障碍/收集/穿门/强制区），切换本身不加分（FR-02）
    return true;
  }

  forcePolarity(p: Polarity) {
    if (this.polarity !== p) {
      this.polarity = p;
      this.invincibleTime = Math.max(this.invincibleTime, 0.2);
    }
  }

  /** M09 磁极镜：强制反转一次极性（不受换色冷却影响） */
  mirrorPolarity() {
    this.polarity = this.polarity === 'RED' ? 'BLUE' : 'RED';
    this.invincibleTime = Math.max(this.invincibleTime, MECH.MIRROR.invincible);
  }

  /** M02 / M07：锁定换色权（取最长，不会被较短锁定缩短） */
  lockSwitch(seconds: number) {
    this.polarityLockTimer = Math.max(this.polarityLockTimer, seconds);
  }

  jump(): boolean {
    if (!this.isGrounded || this.isSliding) return false;
    const force = this.gravityFlipped ? -GAME_CONFIG.JUMP_FORCE : GAME_CONFIG.JUMP_FORCE;
    this.vy = force;
    this.isGrounded = false;
    this.squashY = 1.15;
    return true;
  }

  slide(): boolean {
    if (this.isSliding || this.slideCooldown > 0 || !this.isGrounded) return false;
    this.isSliding = true;
    this.slideTimer = GAME_CONFIG.SLIDE_DURATION;
    return true;
  }

  applyGravityFlip() {
    this.gravityFlipped = !this.gravityFlipped;
  }

  applyBoost(multiplier: number, duration: number) {
    this.speedBoostMultiplier = multiplier;
    this.speedBoostTimer = duration;
  }

  update(dt: number, groundY: number, ceilingY: number, platforms: AABB[] = []): { landed: boolean } {
    let landed = false;
    if (!this.alive) return { landed };

    // 冷却计时
    this.switchCooldown = Math.max(0, this.switchCooldown - dt);
    this.polarityLockTimer = Math.max(0, this.polarityLockTimer - dt);
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.invincibleTime = Math.max(0, this.invincibleTime - dt);
    this.runPhase += dt * 8;

    // 加速带
    if (this.speedBoostTimer > 0) {
      this.speedBoostTimer -= dt;
      if (this.speedBoostTimer <= 0) this.speedBoostMultiplier = 1;
    }

    // 滑行
    if (this.isSliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0) {
        this.isSliding = false;
        this.slideCooldown = GAME_CONFIG.SLIDE_COOLDOWN;
      }
    }

    // 水平移动（自动奔跑 + 传送带附加速度）
    this.x += (this.speed + this.conveyorVx + this.magnetVx) * dt;
    this.conveyorVx = 0;
    this.magnetVx = 0;

    // 重力
    const grav = this.gravityFlipped ? -GAME_CONFIG.GRAVITY : GAME_CONFIG.GRAVITY;
    const prevBottom = this.y + GAME_CONFIG.PLAYER_SIZE;
    this.vy += grav * dt;
    this.vy = clamp(this.vy, -GAME_CONFIG.MAX_FALL_SPEED, GAME_CONFIG.MAX_FALL_SPEED);
    this.y += this.vy * dt;

    // 地面/天花板碰撞
    const wasAirborne = !this.isGrounded;
    if (!this.gravityFlipped) {
      if (this.y + GAME_CONFIG.PLAYER_SIZE >= groundY) {
        this.y = groundY - GAME_CONFIG.PLAYER_SIZE;
        this.vy = 0;
        this.isGrounded = true;
        if (wasAirborne) { landed = true; this.squashY = 0.9; }
      } else {
        this.isGrounded = false;
      }
    } else {
      if (this.y <= ceilingY) {
        this.y = ceilingY;
        this.vy = 0;
        this.isGrounded = true;
        if (wasAirborne) { landed = true; this.squashY = 0.9; }
      } else {
        this.isGrounded = false;
      }
    }

    // 浮空平台支撑（单向：仅正常重力下落时，从上方穿过平台顶才落脚）
    if (!this.gravityFlipped && !this.isGrounded && this.vy >= 0) {
      const bottom = this.y + GAME_CONFIG.PLAYER_SIZE;
      for (const pl of platforms) {
        if (this.x + GAME_CONFIG.PLAYER_SIZE <= pl.x || this.x >= pl.x + pl.w) continue;
        if (prevBottom <= pl.y + 2 && bottom >= pl.y) {
          this.y = pl.y - GAME_CONFIG.PLAYER_SIZE;
          this.vy = 0;
          this.isGrounded = true;
          if (wasAirborne) { landed = true; this.squashY = 0.9; }
          break;
        }
      }
    }

    // 压扁回弹动画
    this.squashY += (1 - this.squashY) * 12 * dt;

    // 重力翻转动画
    const targetAngle = this.gravityFlipped ? Math.PI : 0;
    const diff = targetAngle - this.flipAngle;
    if (Math.abs(diff) > 0.01) {
      this.flipAngle += diff * 12 * dt;
    } else {
      this.flipAngle = targetAngle;
    }

    // 尾迹计时
    this.trailTimer += dt;

    return { landed };
  }

  /** 是否该生成尾迹 */
  consumeTrail(): boolean {
    const interval = this.speedBoostTimer > 0 ? 0.02 : 0.05;
    if (this.trailTimer >= interval) {
      this.trailTimer = 0;
      return true;
    }
    return false;
  }

  die() {
    this.alive = false;
  }

  render(ctx: CanvasRenderingContext2D, time: number, rainbowMode: boolean, speedFx = true) {
    if (!this.alive) return;
    // 速度感：只在高于基准跑速时前倾 + 轻微拉伸，幅度上限 2.6° / 3.5%
    const fast = speedFx
      ? Math.min(1, Math.max(0, (this.speed - GAME_CONFIG.RUN_SPEED) / GAME_CONFIG.RUN_SPEED))
      : 0;
    drawRunner(ctx, {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      polarity: this.polarity,
      sliding: this.isSliding,
      grounded: this.isGrounded,
      flipped: this.gravityFlipped,
      flipAngle: this.flipAngle,
      runPhase: this.runPhase,
      squashY: this.squashY,
      invincibleTime: this.invincibleTime,
      rainbowMode,
      lean: fast * 0.045,
      stretch: 1 + fast * 0.035,
    }, time);
  }
}

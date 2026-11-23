// 粒子系统：对象池 + 多种粒子类型

import { rand } from '../utils/Math';
import { PALETTE } from '../ui/theme';

export interface Particle {
  active: boolean;
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number; startSize: number;
  color: string;
  type: 'circle' | 'ring' | 'triangle' | 'spark';
  rotation: number;
  rotSpeed: number;
  gravity: number;
  shrink: boolean;
}

const MAX_PARTICLES = 600;

export class ParticleSystem {
  private pool: Particle[] = [];

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({
        active: false, x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 1, size: 0, startSize: 0,
        color: PALETTE.dust050, type: 'circle', rotation: 0, rotSpeed: 0,
        gravity: 0, shrink: true,
      });
    }
  }

  private spawn(cfg: Partial<Particle>) {
    for (const p of this.pool) {
      if (p.active) continue;
      Object.assign(p, {
        active: true, x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 0.5, size: 3, startSize: 3,
        color: PALETTE.dust050, type: 'circle', rotation: 0, rotSpeed: 0,
        gravity: 0, shrink: true,
      }, cfg);
      return p;
    }
    return null;
  }

  /** 尾迹粒子 */
  trail(x: number, y: number, color: string, count = 1) {
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + rand(-4, 4), y: y + rand(-6, 6),
        vx: rand(-40, 0), vy: rand(-20, 20),
        maxLife: rand(0.3, 0.5), size: rand(2, 4), startSize: rand(2, 4),
        color, type: 'circle',
      });
    }
  }

  /** 切换冲击波 */
  switchRing(x: number, y: number, color: string) {
    this.spawn({
      x, y, vx: 0, vy: 0, maxLife: 0.3,
      size: 4, startSize: 4, color, type: 'ring', shrink: false,
    });
  }

  /** 碰撞火花 */
  sparks(x: number, y: number, color: string, count = 7) {
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(80, 220);
      this.spawn({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        maxLife: rand(0.15, 0.3), size: rand(2, 4), startSize: rand(2, 4),
        color, type: 'spark', gravity: 300,
      });
    }
  }

  /** 死亡碎裂：20 个三角形 + 6 道放射线条（顿帧结束后一次性炸开） */
  deathBurst(x: number, y: number, color: string) {
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * Math.PI * 2 + rand(-0.18, 0.18);
      const speed = rand(130, 360);
      this.spawn({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 90,
        maxLife: rand(0.32, 0.55), size: rand(4, 9), startSize: rand(4, 9),
        color, type: 'triangle',
        rotation: rand(0, Math.PI * 2), rotSpeed: rand(-11, 11),
        gravity: 620,
      });
    }
    // 放射线条：给出“冲击方向”，比纯三角形更容易读出撞击点
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + 0.26;
      const speed = rand(520, 780);
      this.spawn({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        maxLife: rand(0.12, 0.2), size: 3, startSize: 3,
        color, type: 'spark', shrink: true,
      });
    }
  }

  /** 传送漩涡 */
  portalSwirl(x: number, y: number, color: string) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      this.spawn({
        x: x + Math.cos(angle) * 30, y: y + Math.sin(angle) * 30,
        vx: -Math.cos(angle) * 120 - Math.sin(angle) * 60,
        vy: -Math.sin(angle) * 120 + Math.cos(angle) * 60,
        maxLife: 0.25, size: 3, startSize: 3, color, type: 'circle',
      });
    }
  }

  /** 连击里程碑全屏爆发 */
  comboBurst(x: number, y: number, color: string) {
    for (let i = 0; i < 40; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(150, 450);
      this.spawn({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        maxLife: rand(0.4, 0.8), size: rand(2, 5), startSize: rand(2, 5),
        color, type: 'circle', gravity: 100,
      });
    }
  }

  /** 加速带流光 */
  boostStreak(x: number, y: number, color: string) {
    this.spawn({
      x, y: y + rand(-20, 20),
      vx: rand(-500, -350), vy: 0,
      maxLife: rand(0.2, 0.35), size: rand(2, 4), startSize: rand(2, 4),
      color, type: 'spark', shrink: true,
    });
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.active = false; continue; }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.rotSpeed * dt;
      if (p.type === 'ring') {
        // 冲击波扩散 0 -> 80px
        p.size = p.startSize + (80 - p.startSize) * (p.life / p.maxLife);
      } else if (p.shrink) {
        p.size = p.startSize * (1 - p.life / p.maxLife);
      }
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      const alpha = p.type === 'ring' ? (1 - t) * 0.9 : 1 - t;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;

      switch (p.type) {
        case 'circle':
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.1, p.size), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'ring':
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'triangle': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          const s = p.size;
          ctx.beginPath();
          ctx.moveTo(0, -s);
          ctx.lineTo(s * 0.87, s * 0.5);
          ctx.lineTo(-s * 0.87, s * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'spark':
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
          ctx.stroke();
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  clear() {
    for (const p of this.pool) p.active = false;
  }
}

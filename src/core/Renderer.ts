// 渲染器 + 屏幕震动（支持高清 DPR backing store）

import { GAME_CONFIG } from '../data/config';
import { isMobileDevice } from '../utils/Device';

export class ScreenShake {
  /** 显示设置「画面震动」关闭时不再产生抖动 */
  enabled = true;
  x = 0; y = 0;
  private ampX = 0;
  private ampY = 0;
  private decay = 0;

  trigger(amp = 4, decay = 8) {
    if (!this.enabled) { this.x = 0; this.y = 0; return; }
    this.ampX = amp;
    this.ampY = amp * 0.7;
    this.decay = decay;
  }

  update(dt: number) {
    if (this.ampX <= 0.1 && this.ampY <= 0.1) { this.x = 0; this.y = 0; return; }
    this.x = (Math.random() - 0.5) * 2 * this.ampX;
    this.y = (Math.random() - 0.5) * 2 * this.ampY;
    const k = Math.max(0, 1 - this.decay * dt);
    this.ampX *= k;
    this.ampY *= k;
  }
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  shake = new ScreenShake();
  readonly dpr: number;

  constructor(public canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d')!;
    this.ctx = c;
    // 手机端限制 DPR 上限 1.5，桌面端上限 2，避免 3x 屏渲染压力过大
    const maxDpr = isMobileDevice() ? 1.5 : 2;
    this.dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    canvas.width = GAME_CONFIG.CANVAS_WIDTH * this.dpr;
    canvas.height = GAME_CONFIG.CANVAS_HEIGHT * this.dpr;
    c.scale(this.dpr, this.dpr);
  }

  clear(bg: string) {
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, GAME_CONFIG.CANVAS_WIDTH, GAME_CONFIG.CANVAS_HEIGHT);
  }

  pushCamera(x: number, y: number) {
    this.ctx.save();
    this.ctx.translate(-x + this.shake.x, -y + this.shake.y);
  }

  popCamera() {
    this.ctx.restore();
  }
}

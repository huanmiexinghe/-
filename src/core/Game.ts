// 游戏主循环 + 状态管理

import { Scene } from './Scene';
import { Renderer } from './Renderer';
import { Input } from './Input';
import { AudioSystem } from './Audio';
import { GAME_CONFIG } from '../data/config';
import { ToastManager } from '../systems/ToastManager';
import { AchievementSystem } from '../systems/AchievementSystem';
import { SaveSystem } from '../systems/SaveSystem';

export class Game {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  input: Input;
  audio: AudioSystem;
  ctx: CanvasRenderingContext2D;
  toasts = new ToastManager();
  achievements!: AchievementSystem;

  private container: HTMLElement;
  private currentScene: Scene | null = null;
  private nextScene: Scene | null = null;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private fixedDt = 1 / 60;

  private initedAudio = false;

  constructor() {
    this.container = document.getElementById('app')!;
    this.canvas = document.createElement('canvas');
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.maxHeight = '100%';
    this.container.appendChild(this.canvas);

    this.renderer = new Renderer(this.canvas);
    this.ctx = this.renderer.ctx;
    this.input = new Input(this.canvas);
    this.audio = new AudioSystem();

    // 首次用户交互激活音频上下文（移动端 AudioContext 必须手势解锁）
    const unlock = () => {
      if (!this.initedAudio) {
        this.audio.init();
        this.initedAudio = true;
      }
      this.audio.resume();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    // 从后台切回时恢复被系统挂起的音频
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.audio.resume();
    });
    window.addEventListener('focus', () => this.audio.resume());
  }

  switchScene(scene: Scene) {
    this.nextScene = scene;
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
  }

  private loop = (timestamp: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    // 场景切换
    if (this.nextScene) {
      this.currentScene?.onExit();
      this.currentScene = this.nextScene;
      this.nextScene = null;
      this.currentScene.onEnter();
    }

    let rawDt = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;
    rawDt = Math.min(rawDt, 0.05); // 防卡顿帧率突变

    this.accumulator += rawDt;
    while (this.accumulator >= this.fixedDt) {
      this.currentScene?.update(this.fixedDt);
      this.input.postUpdate();
      this.renderer.shake.update(this.fixedDt);
      this.toasts.update(this.fixedDt);
      this.accumulator -= this.fixedDt;
    }

    this.currentScene?.render(this.ctx);
    this.toasts.render(this.ctx, GAME_CONFIG.CANVAS_WIDTH);
  };
}

export let gameInstance: Game;

export function createGame(): Game {
  gameInstance = new Game();
  const save = SaveSystem.get();
  gameInstance.achievements = new AchievementSystem(gameInstance.toasts, gameInstance.audio, save);
  // 启动即应用静音/主音量（Audio 会保存设置，待首次用户手势 init 后生效）
  gameInstance.audio.applySettings(save.data.muted, save.data.volume);
  gameInstance.renderer.shake.enabled = save.data.shake;
  return gameInstance;
}

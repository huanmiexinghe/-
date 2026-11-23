// 输入管理：键盘 + 触屏（手机版：游戏内虚拟热区 + 菜单点击）

import { KEY_BINDINGS, GAME_CONFIG } from '../data/config';

export type InputAction = 'SWITCH' | 'JUMP' | 'SLIDE' | 'PAUSE' | 'CONFIRM';

const ACTION_KEYS: Record<InputAction, readonly string[]> = {
  SWITCH: KEY_BINDINGS.SWITCH_POLARITY,
  JUMP: KEY_BINDINGS.JUMP,
  SLIDE: KEY_BINDINGS.SLIDE,
  PAUSE: KEY_BINDINGS.PAUSE,
  CONFIRM: KEY_BINDINGS.CONFIRM,
};

// 游戏内虚拟热区（960×540 逻辑坐标）
const BTN_JUMP = { cx: 108, cy: 472, r: 62 };
const BTN_SWITCH = { cx: 852, cy: 472, r: 62 };
const BTN_PAUSE = { x: 900, y: 8, w: 52, h: 44 };

type TouchLayout = 'menu' | 'game';

interface PointerInfo {
  x0: number;
  y0: number;
  zone: 'jump' | 'switch' | 'pause' | 'none';
  slideFired: boolean;
  /** 菜单布局下指针移动超过阈值后不再算作点击（用于列表拖动滚动） */
  moved: boolean;
}

function inCircle(p: { x: number; y: number }, c: { cx: number; cy: number; r: number }) {
  const dx = p.x - c.cx, dy = p.y - c.cy;
  return dx * dx + dy * dy <= c.r * c.r;
}
function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export class Input {
  private keysDown = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();

  // 触屏状态
  private touchActions: InputAction[] = [];
  private pointers = new Map<number, PointerInfo>();
  private touchLayout: TouchLayout = 'menu';

  /** 场景可注册的原始键盘回调（用于菜单导航） */
  onKeyDown: ((code: string) => void) | null = null;
  /** 触屏点击回调（菜单用；菜单布局在抬起时触发，拖动滚动不会误点） */
  onTap: ((x: number, y: number) => void) | null = null;
  /** 指针按下/抬起回调（选关拖动滚动用） */
  onPointerDown: ((x: number, y: number) => void) | null = null;
  onPointerUp: ((x: number, y: number) => void) | null = null;
  /** 指针移动回调（编辑器预览 / 拖动滚动用） */
  onMove: ((x: number, y: number) => void) | null = null;
  /** 滚轮回调（编辑器滚动用），dy > 0 向下滚 */
  onWheel: ((dy: number) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('wheel', this.handleWheel, { passive: true });
    window.addEventListener('blur', () => this.keysDown.clear());
  }

  destroy() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.removeEventListener('wheel', this.handleWheel);
  }

  /** 切换触屏布局：菜单（整屏可点）/ 游戏（虚拟按钮） */
  setTouchLayout(layout: TouchLayout) {
    this.touchLayout = layout;
    this.pointers.clear();
  }

  /** 热区定义（供场景渲染按钮） */
  get touchZones() {
    return { jump: BTN_JUMP, switch: BTN_SWITCH, pause: BTN_PAUSE };
  }

  /** 当前被按下的热区（供按钮高亮渲染） */
  activeZones(): ReadonlySet<string> {
    const s = new Set<string>();
    for (const p of this.pointers.values()) if (p.zone !== 'none') s.add(p.zone);
    return s;
  }

  private inject(a: InputAction) {
    if (!this.touchActions.includes(a)) this.touchActions.push(a);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.keysDown.add(e.code);
    this.pressedThisFrame.add(e.code);
    this.onKeyDown?.(e.code);
    // 阻止游戏键滚动页面
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  }

  private handleKeyUp = (e: KeyboardEvent) => {
    this.keysDown.delete(e.code);
    this.releasedThisFrame.add(e.code);
  }

  /** 将客户端坐标转换为画布逻辑坐标 */
  clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width * GAME_CONFIG.CANVAS_WIDTH,
      y: (clientY - rect.top) / rect.height * GAME_CONFIG.CANVAS_HEIGHT,
    };
  }

  private handlePointerDown = (e: PointerEvent) => {
    const p = this.clientToCanvas(e.clientX, e.clientY);

    if (this.touchLayout === 'menu') {
      // 菜单布局：先记录按下位置，抬起时若未拖动才回传点击，
      // 这样选关页可以拖动滚动而不会误触关卡。
      this.pointers.set(e.pointerId, { x0: p.x, y0: p.y, zone: 'none', slideFired: false, moved: false });
      this.onPointerDown?.(p.x, p.y);
      return;
    }

    // 游戏布局：命中虚拟热区才动作，支持多点触控
    let zone: PointerInfo['zone'] = 'none';
    if (inCircle(p, BTN_SWITCH)) {
      zone = 'switch';
      this.inject('SWITCH');
    } else if (inCircle(p, BTN_JUMP)) {
      zone = 'jump';
      this.inject('JUMP');
    } else if (inRect(p.x, p.y, BTN_PAUSE)) {
      zone = 'pause';
      this.inject('PAUSE');
    } else {
      // 未命中虚拟热区：把点击透传给场景，
      // 否则游戏布局下的场景内按钮（如联机完赛「结束比赛」）在触屏上永远点不到
      this.onTap?.(p.x, p.y);
    }
    this.pointers.set(e.pointerId, { x0: p.x, y0: p.y, zone, slideFired: false, moved: false });
  }

  private handlePointerMove = (e: PointerEvent) => {
    const p = this.clientToCanvas(e.clientX, e.clientY);
    if (this.onMove) this.onMove(p.x, p.y);
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    // 菜单布局：移动超过阈值即视为拖动，抬起时不再触发点击
    if (this.touchLayout === 'menu') {
      if (!info.moved && Math.hypot(p.x - info.x0, p.y - info.y0) > 12) info.moved = true;
      return;
    }
    // 游戏中：在跳跃按钮上向下滑 = 滑行
    if (info.zone === 'jump' && !info.slideFired && p.y - info.y0 > 28) {
      info.slideFired = true;
      this.inject('SLIDE');
    }
  }

  private handlePointerUp = (e: PointerEvent) => {
    const info = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.touchLayout !== 'menu') {
      this.onPointerUp?.(0, 0);
      return;
    }
    const p = this.clientToCanvas(e.clientX, e.clientY);
    this.onPointerUp?.(p.x, p.y);
    if (info && !info.moved) this.onTap?.(info.x0, info.y0);
  }

  private handlePointerCancel = (e: PointerEvent) => {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (had) this.onPointerUp?.(0, 0);
  }

  private handleWheel = (e: WheelEvent) => {
    this.onWheel?.(Math.sign(e.deltaY));
  }

  isDown(action: InputAction): boolean {
    return ACTION_KEYS[action].some(k => this.keysDown.has(k));
  }

  /** 原始键码检测 */
  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  isKeyPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  isPressed(action: InputAction): boolean {
    if (ACTION_KEYS[action].some(k => this.pressedThisFrame.has(k))) return true;
    const idx = this.touchActions.indexOf(action);
    if (idx >= 0) {
      this.touchActions.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** 每帧结束时调用，清除瞬时状态 */
  postUpdate() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.touchActions.length = 0;
  }
}

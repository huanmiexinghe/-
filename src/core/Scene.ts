// 场景基类

export abstract class Scene {
  abstract onEnter(): void;
  abstract update(dt: number): void;
  abstract render(ctx: CanvasRenderingContext2D): void;
  abstract onExit(): void;
}

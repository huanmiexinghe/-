// 轻量物理：AABB 碰撞检测

import { AABB } from '../utils/Math';

export class Physics {
  static AABB(a: AABB, b: AABB): boolean {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  /** 带缩小的AABB（判定更宽容，提升手感） */
  static AABBShrink(a: AABB, b: AABB, shrink: number): boolean {
    return Physics.AABB(
      { x: a.x + shrink, y: a.y + shrink, w: a.w - shrink * 2, h: a.h - shrink * 2 },
      { x: b.x + shrink, y: b.y + shrink, w: b.w - shrink * 2, h: b.h - shrink * 2 }
    );
  }

  /** 圆 vs 矩形：用于摆球等真正圆形的判定，避免用方形包围盒“看着没碰到却判死” */
  static circleAABB(cx: number, cy: number, r: number, box: AABB): boolean {
    const nx = Math.max(box.x, Math.min(cx, box.x + box.w));
    const ny = Math.max(box.y, Math.min(cy, box.y + box.h));
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy <= r * r;
  }
}

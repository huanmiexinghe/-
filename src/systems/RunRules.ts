// 奔跑判定中的纯规则函数：越障连击窗口、移动浮台携带条件
// 抽成纯函数是为了可被 scripts/selfcheck.ts 直接断言，避免回归。

/** 越过判定距离窗口：只允许“刚刚越过”的障碍计数 */
export const PASS_WINDOW = 400;

/** 障碍右边缘是否处于合法的“刚越过”区间（下界防止重生/瞬移回溯补计） */
export function isWithinPassWindow(rightEdge: number, playerX: number, window = PASS_WINDOW): boolean {
  return rightEdge < playerX - 10 && rightEdge >= playerX - window;
}

/** 同色且当时确实触发过安全掠过，才允许补计连击 */
export function countsSafePass(samePolarity: boolean, triggered: boolean): boolean {
  return samePolarity && triggered;
}

/** 移动浮台是否真正支撑玩家（水平投影重叠是必需条件） */
export function carriesPlayer(opts: {
  prevBottom: number;
  prevTop: number;
  axis: 'x' | 'y';
  vy: number;
  playerLeft: number;
  playerRight: number;
  platLeft: number;
  platW: number;
}): boolean {
  return opts.axis === 'y'
    && opts.vy >= 0
    && Math.abs(opts.prevBottom - opts.prevTop) <= 6
    && opts.platLeft < opts.playerRight
    && opts.platLeft + opts.platW > opts.playerLeft;
}

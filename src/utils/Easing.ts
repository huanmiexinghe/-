// 缓动函数

export const Easing = {
  linear: (t: number) => t,
  easeOutQuad: (t: number) => t * (2 - t),
  easeOutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  easeInQuad: (t: number) => t * t,
  easeOutBack: (t: number) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
  easeOutElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
  },
};

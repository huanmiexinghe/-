// 设备能力检测（手机版适配用）

/** 是否为触屏（粗指针）设备 */
export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches;
}

/** 是否为移动端浏览器（含 Android WebView / iOS） */
export function isMobileDevice(): boolean {
  if (isCoarsePointer()) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// 安全区避让（Web 侧兜底）
//
// 原生侧已用沉浸式隐藏系统栏（见 MainActivity）。这里再做一层保险：
// 当系统栏/刘海仍然覆盖 WebView 时，把 #app 的内边距撑开，
// 让画布整体等比缩小并居中，顶部品牌栏与设置齿轮不会被遮住。
//
// 数据来源两路，取较大值：
// 1. env(safe-area-inset-*)：WebView 处于 edge-to-edge 时由 Chromium 给出；
// 2. --safe-area-inset-*：Capacitor 8 内置 SystemBars 插件注入（见 capacitor.config.ts）。
//
// 画布位置变化后，Input 仍用 canvas.getBoundingClientRect() 换算逻辑坐标，
// 点击命中区与视觉位置始终一致；「抬起且未拖动才触发」的点击语义不受影响。

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];

/** 探针元素：借助 CSS env() 读出安全区像素值（环境不支持时为 0） */
let probe: HTMLDivElement | null = null;

function readEnvInsets(): Record<Side, number> {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
  }
  probe.style.padding =
    'env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) ' +
    'env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)';
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

/** 读取 Capacitor SystemBars 注入的 CSS 变量（未注入时为 0） */
function readInjectedInset(side: Side): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--safe-area-inset-${side}`);
  return parseFloat(raw) || 0;
}

/** 按当前安全区重新设置 #app 的内边距（两路来源取较大值，避免重复累加） */
export function applySafeAreaInsets() {
  const app = document.getElementById('app');
  if (!app) return;
  const env = readEnvInsets();
  app.style.paddingTop = `${Math.max(env.top, readInjectedInset('top'))}px`;
  app.style.paddingRight = `${Math.max(env.right, readInjectedInset('right'))}px`;
  app.style.paddingBottom = `${Math.max(env.bottom, readInjectedInset('bottom'))}px`;
  app.style.paddingLeft = `${Math.max(env.left, readInjectedInset('left'))}px`;
}

/** 订阅变化：旋转/尺寸变化、插件注入 CSS 变量、从后台返回 */
export function watchSafeAreaInsets() {
  applySafeAreaInsets();
  window.addEventListener('resize', applySafeAreaInsets);
  // 旋转后视口尺寸滞后，延迟一帧再算一次
  window.addEventListener('orientationchange', () => setTimeout(applySafeAreaInsets, 200));
  document.addEventListener('visibilitychange', applySafeAreaInsets);
  // SystemBars 把 --safe-area-inset-* 写到 <html> 的 style 上，属性变化即刷新
  new MutationObserver(applySafeAreaInsets).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
}

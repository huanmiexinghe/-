import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.experiment.magneticrush',
  appName: '磁极冲刺',
  webDir: 'dist',
  server: {
    // 内测直连 ws://47.96.190.73:8080：页面来源改成 http://localhost（非 https 源），
    // 否则 Chromium 会把 ws:// 当成混合内容拦掉，表现为「连接失败」。
    // http://localhost 仍属于可信来源，clipboard 等安全上下文 API 不受影响；
    // 正式切 TLS 时把这里改回 'https'，并把 DEFAULT_SERVER_URL 换成 wss://域名。
    androidScheme: 'http',
  },
  android: {
    // 允许 WebView 调试（debug 包；正式发布时改为 false）
    webContentsDebuggingEnabled: true,
    // 允许混合内容（兜底开关）：当前页面来源已改成 http://localhost，
    // ws://47.96.190.73:8080 不再触发混合内容拦截；保留该开关是为了兼容
    // 玩家手填 https 自定义地址后又用 ws:// 局域网地址的旧场景。
    // 正式切 TLS 后页面回到 https://localhost，公网联机必须用 wss://，不要依赖此开关。
    allowMixedContent: true,
  },
  plugins: {
    // Capacitor 8 内置 SystemBars 插件（原生沉浸式的配置口径，主修法仍以 MainActivity 为准）：
    // - hidden: 启动即隐藏状态栏 + 导航栏；MainActivity 再叠加 sticky 行为并做焦点/回前台恢复
    // - insetsHandling: 'css' 把系统栏/刘海的安全区以 env() 与 --safe-area-inset-* 传给 WebView，
    //   由 src/ui/SafeArea.ts 统一避让；若改为 'native' 会走 decorView padding，避免两套叠加
    // - initialViewportFitValueHint: index.html 的 viewport 已声明 viewport-fit=cover
    SystemBars: {
      hidden: true,
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;

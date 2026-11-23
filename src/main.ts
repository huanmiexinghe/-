// 磁极冲刺 / Magnetic Rush - 手机版入口

import { createGame } from './core/Game';
import { HealthAdvisoryScene } from './scenes/HealthAdvisoryScene';
import { watchSafeAreaInsets } from './ui/SafeArea';

// 安全区兜底：画布避让状态栏/刘海，保证顶部按钮可点（原生沉浸式为主修法）
watchSafeAreaInsets();

const game = createGame();
// 冷启动先过一次健康游戏忠告；该场景只在这里创建，后续切场景不会再弹
game.switchScene(new HealthAdvisoryScene(game));
game.start();

// 注册 Service Worker（PWA 离线缓存；file:// 或不支持的环境自动跳过）
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => { /* 离线/私有模式下静默失败 */ });
  });
}

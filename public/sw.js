// 磁极冲刺 Service Worker — 离线缓存（stale-while-revalidate）
const CACHE = 'magnetic-rush-mobile-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE).catch(() => {}); // 单个资源失败不阻塞安装
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 仅缓存同源静态资源与页面（含带 hash 的构建产物）
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: false });
    const network = fetch(req).then(res => {
      if (res && res.status === 200 && res.type !== 'opaqueredirect') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});

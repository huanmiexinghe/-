import { defineConfig } from 'vite';

// 构建标识：本地时间（年月日-时分），显示在菜单右下角，便于确认装的是哪一版
const d = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const BUILD_STAMP = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

export default defineConfig({
  base: './',
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    port: 5173,
    open: false,
  },
});

import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { resolve } from 'node:path';

// 约定入口：main → src/main/index.ts，preload → src/preload/index.ts，
// renderer 根 → src/renderer/index.html；产物统一输出到 out/
export default defineConfig({
  main: {
    build: { sourcemap: true },
  },
  preload: {
    build: { sourcemap: 'inline' },
  },
  renderer: {
    plugins: [
      react(),
      // 编译期内联 SVG 图标（Phosphor 图标集），离线可用、按需打包
      Icons({ compiler: 'jsx', autoInstall: false }),
    ],
    server: {
      // 避开 Windows 保留端口段（默认 5173 落在 5092-5191 排除范围内会 EACCES）
      host: '127.0.0.1',
      port: 5290,
      strictPort: true,
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
  },
});

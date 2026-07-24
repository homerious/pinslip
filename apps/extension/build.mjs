// PinSlip 插件构建：三段式（无 @crxjs 依赖，直接驱动 vite JS API）。
//  1) 页面（popup/options）：标准 vite 多页构建，public/ 里的 manifest.json 与图标随之拷入 dist；
//  2) content script：必须单文件 iife（MV3 content script 不支持 ESM）；
//  3) background service worker：单文件 iife。
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

// 1) 页面 + 静态资源
await build({
  configFile: false,
  root,
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.join(root, 'popup.html'),
        options: path.join(root, 'options.html'),
      },
    },
  },
});

// 2/3) 单文件脚本（iife）
for (const [entry, out] of [
  ['src/content.ts', 'content.js'],
  ['src/background.ts', 'background.js'],
]) {
  await build({
    configFile: false,
    root,
    publicDir: false,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      lib: { entry: path.join(root, entry), formats: ['iife'], name: 'pinslip' },
      rollupOptions: { output: { entryFileNames: out, inlineDynamicImports: true } },
    },
  });
}

console.log('extension dist 构建完成');

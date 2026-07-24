// PinSlip 插件构建：三段式（无 @crxjs 依赖，直接驱动 vite JS API）。
//  1) 页面（popup/options）：标准 vite 多页构建；
//  2) content script：必须单文件 iife（MV3 content script 不支持 ESM）；
//  3) background：单文件 iife（Chrome 作 service worker，Firefox 作 event page 脚本）。
// --target chrome（默认）→ dist/；--target firefox → dist-firefox/。
// 源码完全共用，差异只在 manifest（public/manifest[.firefox].json）与输出目录。
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

const target = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'chrome';
if (!['chrome', 'firefox'].includes(target)) {
  console.error(`未知 target: ${target}（可选 chrome / firefox）`);
  process.exit(1);
}
const outDir = target === 'firefox' ? 'dist-firefox' : 'dist';
const manifestSrc =
  target === 'firefox' ? 'public/manifest.firefox.json' : 'public/manifest.json';

// 1) 页面（静态资源改手动拷贝：public/ 下有两份 manifest，只能按 target 选一份）
await build({
  configFile: false,
  root,
  publicDir: false,
  build: {
    outDir,
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
      outDir,
      emptyOutDir: false,
      lib: { entry: path.join(root, entry), formats: ['iife'], name: 'pinslip' },
      rollupOptions: { output: { entryFileNames: out, inlineDynamicImports: true } },
    },
  });
}

// 静态资源：目标 manifest 定名 manifest.json + 图标
fs.copyFileSync(path.join(root, manifestSrc), path.join(root, outDir, 'manifest.json'));
fs.cpSync(path.join(root, 'public', 'icons'), path.join(root, outDir, 'icons'), {
  recursive: true,
});

console.log(`extension ${outDir} 构建完成（target=${target}）`);

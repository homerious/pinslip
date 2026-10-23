#!/usr/bin/env node
// 在隔离的隐藏 Electron 窗口中加载真实 React/Milkdown 编辑器，不读取用户 vault。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '../apps/desktop');
const desktopRequire = createRequire(path.join(desktop, 'package.json'));

async function launch() {
  process.chdir(desktop);
  const temp = fs.mkdtempSync(path.join(desktop, '.paste-test-'));
  try {
    const { build } = await import(pathToFileURL(path.join(path.dirname(desktopRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
    const { default: react } = await import(pathToFileURL(desktopRequire.resolve('@vitejs/plugin-react')).href);
    const { default: icons } = await import(pathToFileURL(desktopRequire.resolve('unplugin-icons/vite')).href);
    fs.writeFileSync(path.join(temp, 'index.html'),
      '<html><body><div id="root"></div><script type="module" src="/tests/editor-paste.tsx"></script></body></html>');
    await build({
      root: desktop, configFile: false, base: './', logLevel: 'warn',
      plugins: [react(), icons({ compiler: 'jsx', autoInstall: false })],
      build: { outDir: path.join(temp, 'dist'), rollupOptions: { input: path.join(temp, 'index.html') } },
    });
    const env = { ...process.env, PINSLIP_PASTE_TEST_DIR: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(desktopRequire('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Editor paste tests timed out')); }, 45_000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    });
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved), fs.realpathSync(desktop));
    assert(path.basename(resolved).startsWith('.paste-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function run() {
  const { app, BrowserWindow } = require('electron');
  const temp = process.env.PINSLIP_PASTE_TEST_DIR;
  assert(temp && path.basename(temp).startsWith('.paste-test-'));
  app.setPath('userData', path.join(temp, 'profile'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(temp, 'dist', path.basename(temp), 'index.html'));
    const results = await win.webContents.executeJavaScript('window.runPasteTests()');
    for (const result of results) console.log(`${result.error ? 'FAIL' : 'PASS'} ${result.name}${result.error ? ': ' + result.error : ''}`);
    assert(results.length > 0 && results.every((result) => !result.error), 'Editor paste regression failed');
    console.log(`Editor paste: ${results.length}/${results.length} passed (Electron ${process.versions.electron})`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

(process.versions.electron ? run() : launch()).catch((error) => { console.error(error); process.exitCode = 1; });

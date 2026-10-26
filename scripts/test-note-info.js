#!/usr/bin/env node
// 隔离 Electron 渲染真实视图，HTTP/IPC 全部使用测试数据，不访问用户 vault。
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
  const temp = fs.mkdtempSync(path.join(desktop, '.info-test-'));
  try {
    const { build } = await import(pathToFileURL(path.join(path.dirname(desktopRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
    const { default: react } = await import(pathToFileURL(desktopRequire.resolve('@vitejs/plugin-react')).href);
    const { default: icons } = await import(pathToFileURL(desktopRequire.resolve('unplugin-icons/vite')).href);
    fs.writeFileSync(path.join(temp, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/tests/note-info.tsx"></script></body></html>');
    await build({
      root: desktop, configFile: false, base: './', logLevel: 'warn',
      resolve: { alias: { '@shared': path.join(desktop, 'src/shared') } },
      plugins: [react(), icons({ compiler: 'jsx', autoInstall: false })],
      build: { outDir: path.join(temp, 'dist'), rollupOptions: { input: path.join(temp, 'index.html') } },
    });
    const env = { ...process.env, PINSLIP_INFO_TEST_DIR: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(desktopRequire('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Note info tests timed out')); }, 60_000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    });
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved), fs.realpathSync(desktop));
    assert(path.basename(resolved).startsWith('.info-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function run() {
  const { app, BrowserWindow } = require('electron');
  const temp = process.env.PINSLIP_INFO_TEST_DIR;
  assert(temp && path.basename(temp).startsWith('.info-test-'));
  app.setPath('userData', path.join(temp, 'profile'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 640, height: 420, frame: false,
    webPreferences: { backgroundThrottling: false, offscreen: !!process.env.PINSLIP_INFO_SCREENSHOTS } });
  try {
    await win.loadFile(path.join(temp, 'dist', path.basename(temp), 'index.html'));
    const results = await win.webContents.executeJavaScript('window.runNoteInfoTests()');
    for (const result of results) console.log(`${result.error ? 'FAIL' : 'PASS'} ${result.name}${result.error ? ': ' + result.error : ''}`);
    assert(results.length > 0 && results.every((result) => !result.error), 'Note info regression failed');
    const capture = async (name) => {
      if (!process.env.PINSLIP_INFO_SCREENSHOTS) return;
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 200)); // 等待隐藏窗口提交新的合成帧。
      const dir = path.resolve(process.env.PINSLIP_INFO_SCREENSHOTS);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    win.setContentSize(220, 160);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const layout = await win.webContents.executeJavaScript(`(() => {
      const d = document.querySelector('.note-info'); const b = document.querySelector('.note-info__body');
      const r = d.getBoundingClientRect(); const c = document.querySelector('.note-info__button').getBoundingClientRect();
      return { fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        closeVisible: c.top >= 0 && c.bottom <= innerHeight, scrolls: b.scrollHeight > b.clientHeight,
        noHorizontalOverflow: b.scrollWidth <= b.clientWidth };
    })()`);
    assert(Object.values(layout).every(Boolean), 'Minimum window layout: ' + JSON.stringify(layout));
    await capture('note-info-minimum');
    win.setContentSize(340, 420);
    await capture('note-info');
    win.setContentSize(320, 600);
    await win.webContents.executeJavaScript('window.showNoteListPreview()');
    await capture('note-list-ids');
    for (const lang of ['zh-CN', 'de']) {
      win.setContentSize(640, 420);
      await new Promise(resolve => setTimeout(resolve, 150));
      await win.webContents.executeJavaScript(`window.showExportMenuPreview(${JSON.stringify(lang)}, true)`);
      await capture('export-menu-first-' + lang);
      await win.webContents.executeJavaScript(`window.showExportMenuPreview(${JSON.stringify(lang)}, false)`);
      await capture('export-menu-last-' + lang);
      win.setContentSize(220, 160);
      await win.webContents.executeJavaScript('window.checkHiddenExportMenu()');
      await win.webContents.executeJavaScript(`window.showExportMenuPreview(${JSON.stringify(lang)}, true)`);
      await capture('export-menu-minimum-' + lang);
    }
    win.setContentSize(320, 600);
    if (process.env.PINSLIP_INFO_SCREENSHOTS) {
      for (const lang of ['zh-CN', 'de']) {
        await win.webContents.executeJavaScript(`window.showManagerLayoutSettings(${JSON.stringify(lang)})`);
        // 隐藏窗中的 transform 动画可能不提交合成帧；轻微调整测试窗口刷新画面。
        win.setContentSize(321, 600);
        await new Promise((resolve) => setTimeout(resolve, 100));
        win.setContentSize(320, 600);
        await capture('manager-layout-settings-' + lang);
        await win.webContents.executeJavaScript(`window.showClipboardSettings(${JSON.stringify(lang)})`);
        win.setContentSize(321, 600);
        await new Promise((resolve) => setTimeout(resolve, 100));
        win.setContentSize(320, 600);
        await capture('clipboard-note-settings-' + lang);
        await win.webContents.executeJavaScript(`window.showCopySettingPreview(${JSON.stringify(lang)})`);
        win.setContentSize(321, 600);
        await new Promise((resolve) => setTimeout(resolve, 100));
        win.setContentSize(320, 600);
        await capture('copy-format-setting-' + lang);
        win.setContentSize(220, 160);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await win.webContents.executeJavaScript(`window.showCopyMenuPreview(${JSON.stringify(lang)})`);
        assert(await win.webContents.executeJavaScript('!!document.querySelector(".copy-format-menu")'), 'Copy preview stays open');
        await capture('copy-format-menu-minimum-' + lang);
        assert(await win.webContents.executeJavaScript('!!document.querySelector(".copy-format-menu")'), 'Capture retains the copy menu');
        await win.webContents.executeJavaScript(`window.showNoteMorePreview(${JSON.stringify(lang)})`);
        await capture('copy-format-more-minimum-' + lang);
        win.setContentSize(320, 600);
      }
    }
    console.log(`Note info: ${results.length}/${results.length} passed; minimum-size layout passed (Electron ${process.versions.electron})`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

(process.versions.electron ? run() : launch()).catch((error) => { console.error(error); process.exitCode = 1; });

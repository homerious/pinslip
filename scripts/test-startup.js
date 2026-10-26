#!/usr/bin/env node
// 运行实际主进程模块；系统自启 API 与文件系统隔离，不修改用户登录项。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('../apps/desktop/node_modules/typescript');
const root = path.resolve(__dirname, '../apps/desktop/src/main');
function load(file, mocks, processMock = process) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id) => id in mocks ? mocks[id] : require(id),
    process: processMock, console, URL, setTimeout, clearTimeout });
  return exports;
}
async function startup({ hidden = false, vault = true, tray = true, early = null, login = false } = {}) {
  const app = new EventEmitter();
  let ready; let shown = 0; let restored = 0; let background = 0;
  Object.assign(app, { requestSingleInstanceLock: () => true, quit() {}, whenReady: () => ({ then: (fn) => { ready = fn; } }),
    getLoginItemSettings: () => ({ wasOpenedAtLogin: login }) });
  const mocks = {
    electron: { app, BrowserWindow: {}, nativeTheme: new EventEmitter(), protocol: { handle() {} },
      powerMonitor: new EventEmitter(), screen: new EventEmitter() },
    '@electron-toolkit/utils': { electronApp: { setAppUserModelId() {} } },
    './windows/window-manager': { WindowManager: class { showMainWindow() { shown++; } async restoreNoteWindows() { restored++; } } },
    './services/go-process': { GoProcess: class { async ensureStarted() { background++; } } },
    './ipc': { registerIpcHandlers() {} }, './tray': { createTray() { background++; } },
    './autostart': { initAutoStart() {} }, './settings': { getVaultPath: () => vault, getAdvanced: () => ({ trayIcon: tray, autoStartHidden: true }) },
    './i18n': { initMainI18n() {} }, './shortcuts': { registerShortcuts() { background++; } },
    './services/vault-watch': { startVaultWatch() { background++; } }, './updater': { initAutoUpdater() {} },
    './windows/window-state': {}, '../shared/ipc-channels': {}, './startup': load('startup', {}),
  };
  load('index', mocks, { platform: login ? 'darwin' : 'win32', argv: hidden ? ['PinSlip.exe', '--hidden'] : ['PinSlip.exe'] });
  if (early) app.emit('second-instance', {}, early);
  await ready();
  const initial = shown;
  app.emit('second-instance', {}, ['PinSlip.exe', '--hidden']);
  assert.equal(shown, initial, 'Hidden duplicate must leave visibility unchanged');
  app.emit('second-instance', {}, ['PinSlip.exe']);
  assert.equal(shown, initial + 1, 'Normal duplicate must open manager');
  assert.equal(restored, vault ? 1 : 0);
  assert.equal(background, tray ? 4 : 3, 'Background services must start');
  return initial;
}
function autostart(platform, packaged = true) {
  const files = new Map(); const writes = []; const reads = []; let hidden = false; let registered = null;
  const app = { isPackaged: packaged, getPath: (key) => key === 'exe' ? '/Program Files/PinSlip/PinSlip.exe' : '/isolated/' + key,
    getLoginItemSettings(options) { reads.push(options); return { openAtLogin: registered !== null && JSON.stringify(options?.args || []) === JSON.stringify(registered) }; },
    setLoginItemSettings(options) { writes.push(options); registered = options.openAtLogin ? (options.args || []) : null; } };
  const api = load('autostart', { electron: { app }, './settings': { getAdvanced: () => ({ autoStartHidden: hidden }) },
    'node:fs': { existsSync: (p) => files.has(p), mkdirSync() {}, unlinkSync: (p) => files.delete(p), writeFileSync: (p,s) => files.set(p,s) } }, { platform });
  return { api, app, files, writes, reads, hide: (v) => { hidden = v; } };
}
(async () => {
  assert.equal(await startup(), 1);
  assert.equal(await startup({ hidden: true }), 0);
  assert.equal(await startup({ hidden: true, vault: false }), 1);
  assert.equal(await startup({ hidden: true, tray: false }), 1);
  assert.equal(await startup({ hidden: true, early: ['PinSlip.exe'] }), 1);
  assert.equal(await startup({ hidden: true, early: ['PinSlip.exe', '--hidden'] }), 0);
  assert.equal(await startup({ login: true }), 0);
  const win = autostart('win32');
  win.api.initAutoStart(); assert.equal(win.api.getAutoStart(), true);
  win.hide(true); win.api.setAutoStart(true); assert.equal(win.api.getAutoStart(), true);
  assert.equal(JSON.stringify(win.writes.at(-1).args), '["--hidden"]');
  assert.equal(win.reads.at(-1).path, win.app.getPath('exe'));
  win.api.setAutoStart(false); const count = win.writes.length;
  win.api.initAutoStart(); assert.equal(win.writes.length, count, 'Disabled autostart must stay disabled');
  const dev = autostart('win32', false); dev.api.initAutoStart(); dev.api.setAutoStart(true);
  assert.equal(dev.writes.length, 0); assert.equal(dev.api.getAutoStart(), false);
  const linux = autostart('linux'); linux.hide(true); linux.api.setAutoStart(true);
  assert.match([...linux.files.values()][0], /Exec=".*Program Files.*" --hidden/);
  linux.api.setAutoStart(false); assert.equal(linux.api.getAutoStart(), false);
  const mac = autostart('darwin'); mac.hide(true); mac.api.setAutoStart(true);
  assert.equal(mac.writes[0].args, undefined);
  // 使用实际窗口池恢复逻辑验证静默参数传递和已存在窗口的处理。
  const created = []; const openIds = ['one', 'two']; let focusCount = 0;
  const noteWindows = [];
  const { WindowManager } = load('windows/window-manager', {
    './note-close-guard': load('windows/note-close-guard', { '../../shared/ipc-channels': {} }),
    '../i18n': {},
    electron: {}, './note-window': { createNoteWindow(options) { created.push(options); const win = {
      isDestroyed: () => false, focus() { focusCount++; }, once() {}, on() {}, webContents: { id: noteWindows.length + 1 },
    }; noteWindows.push(win); return win; } },
    './quick-capture': {}, './main-window': {}, './group-manager': { GroupManager: class {
      async load() {} restackOf() {} } },
    '../settings': { getOpenNotes: () => openIds, setOpenNotes() {}, getAdvanced: () => ({ notePlacement: 'cascade' }) },
    '../../shared/ipc-channels': {},
  });
  const manager = new WindowManager({}); manager.fetchPinState = async () => true;
  await manager.restoreNoteWindows();
  assert.equal(created.length, 2); assert(created.every((options) => options.showInactive));
  await manager.restoreNoteWindows(); assert.equal(focusCount, 0, 'Repeated restoration must not focus existing notes');
  await manager.createNoteWindow('one'); assert.equal(focusCount, 1);
  await manager.createNoteWindow('manual'); assert.equal(created.at(-1).showInactive, false);
  console.log('PASS window manager restoration routes; manual opening remains active');
  console.log('PASS startup: 7 lifecycle scenarios; autostart: Windows migration/args/disabled/dev, Linux Exec, macOS login');
})().catch((error) => { console.error(error); process.exitCode = 1; });

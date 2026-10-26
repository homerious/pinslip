#!/usr/bin/env node
// 执行真实快捷键/设置/窗口池代码，剪贴板与磁盘均为隔离替身。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const ts = require('../apps/desktop/node_modules/typescript');
function load(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../apps/desktop/src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => id in mocks ? mocks[id] : require(id), process,
    console, crypto, setTimeout, clearTimeout });
  return exports;
}
const shared = load('shared/shortcuts.ts');
const { IPC } = load('shared/ipc-channels.ts');
const toolbar = load('shared/toolbar.ts');
async function main() {
  const bindings = new Map(); const creations = []; const focuses = []; const logs = [];
  let advanced = { blankNoteShortcut: 'off', blankNoteClipboard: false, quickCaptureShortcut: 'ctrl+shift+n' };
  let text = ''; let clipboardFailure = false; let reads = 0; let quick = 0;
  const shortcuts = load('main/shortcuts.ts', {
    electron: { clipboard: { readText() { reads++; if (clipboardFailure) throw new Error('unavailable'); return text; } },
      globalShortcut: { register: (key, cb) => { if (bindings.has(key)) return false; bindings.set(key, cb); return true; },
        unregister: key => bindings.delete(key), unregisterAll: () => bindings.clear() } },
    './settings': { getAdvanced: () => advanced }, '../shared/shortcuts': shared,
  });
  const manager = { async createNoteWindow(...args) { creations.push(args); return String(creations.length); },
    focusNoteWindow(id) { focuses.push(id); }, showQuickCapture() { quick++; } };
  shortcuts.registerShortcuts(manager);
  assert.equal(bindings.size, 1); assert.equal(reads, 0);
  advanced.blankNoteShortcut = 'ctrl+alt+n'; shortcuts.rebindBlankNoteShortcut('ctrl+alt+n');
  const fire = bindings.get(shared.GLOBAL_SHORTCUT_ACCELERATORS['ctrl+alt+n']);
  text = 'private clipboard'; fire(); await Promise.resolve();
  assert.equal(reads, 0); assert.equal(creations.at(-1)[3], undefined);
  advanced.blankNoteClipboard = true; text = '  # Clipboard\n\n正文\n'; fire(); text = 'changed later'; await Promise.resolve();
  assert.equal(creations.at(-1)[3], '  # Clipboard\n\n正文\n');
  for (const empty of ['', ' \n\t']) { text = empty; fire(); assert.equal(creations.at(-1)[3], undefined); }
  clipboardFailure = true; fire(); assert.equal(creations.at(-1)[3], undefined); clipboardFailure = false;
  const previousReads = reads; const previousCreates = creations.length;
  advanced.blankNoteShortcut = 'off'; fire();
  assert.equal(reads, previousReads); assert.equal(creations.length, previousCreates, 'Queued callback after disable is inert');
  advanced.blankNoteShortcut = 'ctrl+alt+n'; advanced.blankNoteClipboard = false; fire();
  assert.equal(reads, previousReads, 'Preference updates apply without rebinding');
  bindings.get(shared.GLOBAL_SHORTCUT_ACCELERATORS['ctrl+shift+n'])(); assert.equal(quick, 1); assert.equal(reads, previousReads);
  bindings.set(shared.GLOBAL_SHORTCUT_ACCELERATORS['ctrl+alt+q'], () => {});
  assert.throws(() => shortcuts.rebindBlankNoteShortcut('ctrl+alt+q'), /register failed/);
  assert.equal(bindings.get(shared.GLOBAL_SHORTCUT_ACCELERATORS['ctrl+alt+n']), fire, 'Occupied binding restores original shortcut');
  await Promise.resolve(); assert.equal(focuses.length, creations.length);
  shortcuts.unregisterShortcuts(); assert.equal(bindings.size, 0);
  logs.push('Shortcut: default off, hot preference, trigger snapshot, empty/error fallback, disabled parent, focus and quick capture isolation');

  let json = '{}'; let failWrite = false;
  const settings = load('main/settings.ts', { electron: { app: { getPath: () => '/isolated' } },
    'node:fs': { readFileSync: () => json, writeFileSync: (_, value) => { if (failWrite) throw new Error('disk full'); json = value; } },
    '../shared/toolbar': toolbar });
  assert.equal(settings.getAdvanced().blankNoteClipboard, false);
  assert.equal(settings.getAdvanced().copyAllFormat, 'markdown');
  settings.setAdvanced({ copyAllFormat: 'plain' });
  failWrite = true; assert.throws(() => settings.setAdvanced({ copyAllFormat: 'markdown' }), /disk full/);
  assert.equal(settings.getAdvanced().copyAllFormat, 'plain'); failWrite = false;
  settings.setAdvanced({ blankNoteClipboard: true }); assert.equal(settings.getAdvanced().blankNoteClipboard, true);
  failWrite = true; assert.throws(() => settings.setAdvanced({ blankNoteClipboard: false }), /disk full/);
  assert.equal(settings.getAdvanced().blankNoteClipboard, true, 'Disk failure rolls back memory too'); failWrite = false;
  const tampered = load('main/settings.ts', { electron: { app: { getPath: () => '/isolated' } },
    'node:fs': { readFileSync: () => '{"advanced":{"blankNoteClipboard":"true","copyAllFormat":"invalid"}}' }, '../shared/toolbar': toolbar });
  assert.equal(tampered.getAdvanced().blankNoteClipboard, false);
  assert.equal(tampered.getAdvanced().copyAllFormat, 'markdown');
  const handlers = new Map(); const rebinds = []; let failRebind = false;
  const ipc = load('main/ipc/index.ts', { electron: { ipcMain: { handle: (key, cb) => handlers.set(key, cb), on() {} },
    BrowserWindow: { getAllWindows: () => [] } }, '../../shared/ipc-channels': { IPC }, '../../shared/shortcuts': shared,
    '../settings': settings, '../autostart': {}, '../i18n': {}, '../tray': {}, '../../shared/languages': {},
    '../services/vault-watch': {}, '../updater': {}, '../windows/export-window': {},
    '../shortcuts': { rebindBlankNoteShortcut: key => { if (failRebind) throw new Error('register failed'); rebinds.push(key); } } });
  ipc.registerIpcHandlers({ windowManager: { takeInitialNoteContent: id => id }, goProcess: {} });
  const set = handlers.get(IPC.SettingsSetAdvanced);
  assert.throws(() => set({}, { copyAllFormat: 'invalid' }), /Invalid copyAllFormat/);
  assert.throws(() => set({}, { copyAllFormat: true }), /Invalid copyAllFormat/);
  assert.equal(set({}, { copyAllFormat: 'markdown' }).copyAllFormat, 'markdown');
  assert.throws(() => set({}, { blankNoteClipboard: 'true' }), /must be boolean/);
  assert.throws(() => set({}, { blankNoteClipboard: true }), /Enable the new note shortcut/);
  assert.throws(() => set({}, { blankNoteShortcut: 'invalid', blankNoteClipboard: true }), /Enable the new note shortcut/);
  set({}, { blankNoteShortcut: 'ctrl+alt+n', blankNoteClipboard: true });
  assert.equal(settings.getAdvanced().blankNoteClipboard, true);
  set({}, { blankNoteShortcut: 'off' }); assert.equal(settings.getAdvanced().blankNoteClipboard, true);
  set({}, { blankNoteClipboard: false }); assert.equal(settings.getAdvanced().blankNoteClipboard, false);
  failWrite = true;
  assert.throws(() => set({}, { blankNoteShortcut: 'ctrl+alt+n', blankNoteClipboard: true }), /disk full/);
  assert.equal(rebinds.slice(-2).join(','), 'ctrl+alt+n,off', 'Failed combined save restores old binding');
  assert.equal(settings.getAdvanced().blankNoteShortcut, 'off'); assert.equal(settings.getAdvanced().blankNoteClipboard, false);
  failWrite = false; failRebind = true;
  assert.throws(() => set({}, { blankNoteShortcut: 'ctrl+alt+n', blankNoteClipboard: true }), /register failed/);
  assert.equal(settings.getAdvanced().blankNoteClipboard, false, 'Rejected parent binding cannot enable child'); failRebind = false;
  assert.equal(handlers.get(IPC.NoteTakeInitialContent)({ sender: { id: 987 } }, 'untrusted-note-id'), 987);
  logs.push('Settings and IPC: legacy default, strict boolean, parent validation, retained preference, disk failure rollback, sender-only bootstrap');

  const options = []; const windows = []; let wcId = 0;
  const { WindowManager } = load('main/windows/window-manager.ts', { electron: {},
    './note-close-guard': load('main/windows/note-close-guard.ts', { '../../shared/ipc-channels': { IPC } }), '../i18n': {},
    './note-window': { createNoteWindow(opts) {
      options.push(opts); const win = new EventEmitter(); win.webContents = { id: ++wcId };
      win.isDestroyed = () => false; win.focus = () => {}; windows.push(win); return win;
    } }, './quick-capture': {}, './main-window': {},
    './group-manager': { GroupManager: class { async load() {} restackOf() {} handleWindowClosed() {} } },
    '../settings': { getAdvanced: () => ({ notePlacement: 'cascade' }), setOpenNotes() {} }, '../../shared/ipc-channels': { IPC } });
  const wm = new WindowManager({}); wm.fetchPinState = async () => true;
  const first = await wm.createNoteWindow(undefined, undefined, false, 'first');
  await wm.createNoteWindow(undefined, undefined, false, 'second');
  assert.equal(wm.takeInitialNoteContent(999), null); assert.equal(wm.takeInitialNoteContent(2), 'second');
  assert.equal(wm.takeInitialNoteContent(2), null); assert.equal(wm.takeInitialNoteContent(1), 'first');
  assert.equal(wm.takeInitialNoteContent(1), null);
  await wm.createNoteWindow(undefined, undefined, false, 'closed'); windows[2].emit('closed');
  assert.equal(wm.initialNoteContents.size, 0, 'Unclaimed content cleaned on close');
  await wm.createNoteWindow(); assert.equal(wm.takeInitialNoteContent(4), null);
  await wm.createNoteWindow('existing', undefined, false, 'must not overwrite'); assert.equal(wm.takeInitialNoteContent(5), null);
  await wm.createNoteWindow(first, undefined, false, 'must not overwrite'); assert.equal(wm.takeInitialNoteContent(1), null);
  assert(options.every(o => !Object.hasOwn(o, 'initialContent')), 'No text in native window route options');
  logs.push('Window lifecycle: distinct snapshots, one-shot consume, foreign sender rejection, close cleanup, blank/existing paths untouched');
  logs.forEach(log => console.log('PASS ' + log));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

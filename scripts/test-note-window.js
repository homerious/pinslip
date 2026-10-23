#!/usr/bin/env node
// 使用真实 Electron 窗口和便签生命周期验证尺寸约束；不加载编辑器，不读取用户数据。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const TEMP_PREFIX = 'pinslip-note-window-test-';

function launchElectron() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    const env = { ...process.env, PINSLIP_NOTE_WINDOW_TEST_DIR: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = require(path.join(DESKTOP, 'node_modules', 'electron'));
    const result = spawnSync(electron, [__filename], {
      env,
      stdio: 'inherit',
      windowsHide: true,
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    const resolved = fs.realpathSync(temp);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert(path.basename(resolved).startsWith(TEMP_PREFIX));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function run() {
  const { app, screen, BrowserWindow } = require('electron');
  const temp = process.env.PINSLIP_NOTE_WINDOW_TEST_DIR;
  assert(temp && path.basename(temp).startsWith(TEMP_PREFIX), 'Run through pnpm test:note-window');
  app.setPath('userData', temp);
  app.disableHardwareAcceleration();
  // 各用例之间会销毁全部窗口，不能因此提前退出而跳过后续用例。
  app.on('window-all-closed', () => {});
  await app.whenReady();

  const ts = require(path.join(DESKTOP, 'node_modules', 'typescript'));
  Module._extensions['.ts'] = (module, filename) => {
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    module._compile(result.outputText, filename);
  };

  const noteWindowFile = path.join(DESKTOP, 'src', 'main', 'windows', 'note-window.ts');
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === noteWindowFile && request === './view-helper') {
      // 仅替换页面加载：其余建窗、状态记忆、吸附及折叠/展开均运行实际代码。
      return {
        loadView() {},
        viewWebPreferences: () => ({ contextIsolation: true, nodeIntegration: false, sandbox: false }),
      };
    }
    return load.call(this, request, parent, isMain);
  };

  const area = screen.getPrimaryDisplay().workArea;
  const expanded = { x: area.x + 100, y: area.y + 100, width: 340, height: 420 };
  fs.writeFileSync(path.join(temp, 'window-state.json'), JSON.stringify({
    'note:restored': { ...expanded, height: 64, collapsed: true, expanded },
  }));

  const { createNoteWindow, setNoteWindowCollapsed } = require(noteWindowFile);
  const { COLLAPSE_ANIM_MS } = require(path.join(DESKTOP, 'src', 'shared', 'anim.ts'));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let failures = 0;
  for (const mode of ['fresh', 'collapse-expand', 'restore-collapsed-expand']) {
    const id = mode === 'restore-collapsed-expand' ? 'restored' : mode;
    let win;
    try {
      win = createNoteWindow({ noteId: id, index: 0, alwaysOnTop: false });
      await wait(100);
      // 隐藏测试不加载页面，先触发一次真实移动，让尺寸记忆/自校准完成初始化。
      const initial = win.getBounds();
      win.setPosition(initial.x + 1, initial.y);
      await wait(100);
      if (mode === 'collapse-expand') {
        setNoteWindowCollapsed(win, id, true);
        await wait(COLLAPSE_ANIM_MS + 100);
        assert.equal(win.isResizable(), false, 'Collapsed note must not be resizable');
      }
      if (mode !== 'fresh') {
        setNoteWindowCollapsed(win, id, false);
        await wait(COLLAPSE_ANIM_MS + 100);
      }
      const minimum = win.getMinimumSize();
      win.setSize(100, 64);
      await wait(100);
      const bounds = win.getBounds();
      console.log(`${mode}: minimum=${minimum.join('x')}, undersized request -> ${bounds.width}x${bounds.height}`);
      assert.equal(win.isResizable(), true, 'Expanded note must be resizable');
      assert.deepEqual(minimum, [220, 160], 'Expanded note minimum must be restored');
      assert(bounds.width >= 220 && bounds.height >= 160, 'Expanded note must reject undersized requests');
      console.log(`PASS ${mode}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${mode}: ${error.message}`);
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
  }
  console.log(`Note window lifecycle: ${3 - failures}/3 passed (Electron ${process.versions.electron}, ${process.platform})`);
  // 真实 Electron 焦点验证：页面加载替身仅隔离编辑器，显示路径运行实际便签工厂。
  const foreground = new BrowserWindow({ width: 240, height: 180, show: false });
  let note;
  try {
    await foreground.loadURL('data:text/html,<p>focus anchor</p>');
    foreground.show(); foreground.focus();
    await wait(200);
    assert(foreground.isFocused(), 'Foreground anchor must be focused before restore');
    note = createNoteWindow({ noteId: 'inactive-focus', index: 0, alwaysOnTop: true, showInactive: true });
    let focusEvents = 0;
    note.on('focus', () => focusEvents++);
    note.emit('ready-to-show');
    await wait(300);
    assert(note.isVisible(), 'Restored note must be visible');
    assert.equal(focusEvents, 0, 'Restored note must not request focus');
    assert(foreground.isFocused(), 'Restore must preserve foreground focus');
    note.destroy();
    note = createNoteWindow({ noteId: 'manual-focus', index: 0, alwaysOnTop: true });
    note.emit('ready-to-show');
    await wait(300);
    assert(note.isFocused(), 'Manual note must still become focused');
    console.log('PASS real Electron restore keeps foreground focus; manual open gets focus');
  } catch (error) {
    failures++;
    console.error('FAIL note focus:', error);
  } finally {
    if (note && !note.isDestroyed()) note.destroy();
    foreground.destroy();
  }
  app.exit(failures ? 1 : 0);
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  run().catch((error) => {
    console.error(error);
    require('electron').app.exit(1);
  });
} else {
  launchElectron();
}

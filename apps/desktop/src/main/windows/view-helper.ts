import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { is } from '@electron-toolkit/utils';

/** 统一的窗口加载逻辑：开发模式走 vite dev server，生产模式加载打包后的 html */
export function loadView(win: BrowserWindow, hash: string): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }
}

/** 便签类窗口的通用 webPreferences */
export function viewWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  };
}

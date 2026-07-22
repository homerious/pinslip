import { BrowserWindow, screen } from 'electron';
import { loadView, viewWebPreferences } from './view-helper';

/** 创建速记浮窗：居中偏上、失焦自动关闭 */
export function createQuickCaptureWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: 520,
    height: 220,
    x: Math.round((width - 520) / 2),
    y: Math.round((height - 220) / 3),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: viewWebPreferences(),
  });

  loadView(win, '/quick-capture');

  win.once('ready-to-show', () => win.show());
  win.on('blur', () => {
    if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) {
      win.close();
    }
  });
  return win;
}

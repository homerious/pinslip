import { BrowserWindow, screen } from 'electron';
import { loadView, viewWebPreferences } from './view-helper';

/** 创建速记浮窗：出现在鼠标所在屏幕（多屏跟随）、居中偏上。
 *  失焦关闭在渲染层处理（关窗前要先自动保存未落盘内容，main 抢关会来不及存），
 *  主进程不再监听 blur */
export function createQuickCaptureWindow(): BrowserWindow {
  // 鼠标所在屏（不是固定主屏）：全局快捷键呼出时窗口跟着注意力走
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;

  const win = new BrowserWindow({
    width: 520,
    height: 220,
    x: Math.round(x + (width - 520) / 2),
    y: Math.round(y + (height - 220) / 3),
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
  return win;
}

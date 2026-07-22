import { BrowserWindow, screen } from 'electron';
import { loadView, viewWebPreferences } from './view-helper';

/** 主窗口默认宽度/高度：窄条便签列表，停靠桌面右下角 */
const MAIN_WIDTH = 320;
const MAIN_HEIGHT = 600;

/** 创建主窗口：笔记列表、搜索、管理入口（窄条面板）。
 *  固定 320×600 不可调大小——避免高分屏缩放下 bounds 往返存储漂移越变越小。
 *  不做位置记忆：永远停靠主屏幕右下角——用户预期它在同一个可预测的位置，
 *  记忆漂移后反而找不到（2026-07-21 评审结论） */
export function createMainWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    x: workArea.x + workArea.width - MAIN_WIDTH - 12, // 离屏幕工作区边缘留 12px
    y: workArea.y + workArea.height - MAIN_HEIGHT - 12,
    title: 'PinSlip',
    resizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: viewWebPreferences(),
  });

  loadView(win, '/');

  win.once('ready-to-show', () => win.show());
  return win;
}

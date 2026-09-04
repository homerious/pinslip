import { BrowserWindow, screen } from 'electron';
import { loadView, viewWebPreferences } from './view-helper';

/** 主窗口默认宽度/高度：双栏管理器，仍停靠桌面右下角。 */
const MAIN_WIDTH = 900;
const MAIN_HEIGHT = 650;

/** 创建主窗口：笔记导航 + 即时 Markdown 预览。
 *  不做位置记忆：永远停靠主屏幕右下角——用户预期它在同一个可预测的位置，
 *  记忆漂移后反而找不到（2026-07-21 评审结论） */
export function createMainWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(MAIN_WIDTH, Math.max(620, workArea.width - 24));
  const height = Math.min(MAIN_HEIGHT, Math.max(420, workArea.height - 24));
  const win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 12, // 离屏幕工作区边缘留 12px
    y: workArea.y + workArea.height - height - 12,
    title: 'PinSlip',
    minWidth: 620,
    minHeight: 420,
    resizable: true,
    maximizable: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: viewWebPreferences(),
  });

  loadView(win, '/');

  win.once('ready-to-show', () => win.show());
  return win;
}

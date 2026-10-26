import { BrowserWindow, nativeImage } from 'electron';
import path from 'node:path';
import { loadView, viewWebPreferences } from './view-helper';
import { getAdvanced } from '../settings';
import { clearMainWindowLayout, MainWindowLayout } from './main-window-layout';

const layouts = new WeakMap<BrowserWindow, MainWindowLayout>();

export function setMainWindowLayoutEnabled(win: BrowserWindow | null, enabled: boolean): void {
  if (win && !win.isDestroyed()) layouts.get(win)?.setEnabled(enabled);
  if (!enabled) clearMainWindowLayout();
}

export function flushMainWindowLayout(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) layouts.get(win)?.flush();
}

export async function resetMainWindowLayout(win: BrowserWindow | null): Promise<void> {
  if (win && !win.isDestroyed()) await layouts.get(win)?.reset();
  else clearMainWindowLayout();
}

/** 创建主窗口：笔记列表、搜索、管理入口（窄条面板）。
 *  默认主屏右下角 320×600；可选记忆由独立控制器持有权威尺寸，避免 DPI 回读漂移。 */
export function createMainWindow(): BrowserWindow {
  const layout = new MainWindowLayout(getAdvanced().rememberManagerLayout);
  const win = new BrowserWindow({
    // X11 下窗口/任务栏图标(Windows 无边框窗不显示、macOS 忽略,均无害)
    icon: nativeImage.createFromPath(path.join(__dirname, '../../../resources/icon.png')),
    ...layout.initialBounds,
    // 最小尺寸在显示前校准后设置，避免 OS 的最小值钳制污染校准比例。
    title: 'PinSlip',
    resizable: true,
    maximizable: false,
    show: false,
    // 任务栏图标显隐（高级设置，缺省开）；仅主窗口，便签任务栏入口不受影响
    skipTaskbar: !getAdvanced().taskbarIcon,
    autoHideMenuBar: true,
    webPreferences: viewWebPreferences(),
  });

  layouts.set(win, layout);
  layout.bind(win);
  loadView(win, '/');

  win.once('ready-to-show', () => {
    layout.initialize();
    win.show();
  });
  return win;
}

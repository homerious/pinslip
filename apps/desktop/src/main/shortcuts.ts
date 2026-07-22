import { globalShortcut } from 'electron';
import type { WindowManager } from './windows/window-manager';

/** 注册全局快捷键。 */
export function registerShortcuts(windowManager: WindowManager): void {
  // 速记浮窗：即使应用没有窗口打开也能呼出
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    windowManager.showQuickCapture();
  });
}

/** 注销全部全局快捷键（退出前调用）。 */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}

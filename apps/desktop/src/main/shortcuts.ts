import { globalShortcut } from 'electron';
import type { WindowManager } from './windows/window-manager';
import { getBlankNoteCreationSettings } from './settings';

const QUICK_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+N';
let registeredBlankNoteShortcut = '';

function registerBlankNoteShortcut(shortcut: string, windowManager: WindowManager): boolean {
  if (!shortcut || shortcut === QUICK_CAPTURE_SHORTCUT) return shortcut === '';
  try {
    const ok = globalShortcut.register(shortcut, () => {
      void windowManager.createBlankNote();
    });
    if (ok) registeredBlankNoteShortcut = shortcut;
    return ok;
  } catch {
    return false;
  }
}

/** 注册全局快捷键。 */
export function registerShortcuts(windowManager: WindowManager): void {
  // 速记浮窗：即使应用没有窗口打开也能呼出
  globalShortcut.register(QUICK_CAPTURE_SHORTCUT, () => {
    windowManager.showQuickCapture();
  });
  const { shortcut } = getBlankNoteCreationSettings();
  if (!registerBlankNoteShortcut(shortcut, windowManager)) {
    console.warn(`[shortcuts] unable to register blank-note shortcut: ${shortcut}`);
  }
}

/** 原子式重绑：新快捷键注册失败时恢复旧绑定。 */
export function rebindBlankNoteShortcut(shortcut: string, windowManager: WindowManager): boolean {
  const previous = registeredBlankNoteShortcut;
  if (previous) globalShortcut.unregister(previous);
  registeredBlankNoteShortcut = '';
  if (registerBlankNoteShortcut(shortcut, windowManager)) return true;
  if (previous) registerBlankNoteShortcut(previous, windowManager);
  return false;
}

/** 注销全部全局快捷键（退出前调用）。 */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
  registeredBlankNoteShortcut = '';
}

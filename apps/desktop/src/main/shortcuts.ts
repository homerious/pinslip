import { globalShortcut } from 'electron';
import type { WindowManager } from './windows/window-manager';
import { getAdvanced } from './settings';
import type { GlobalShortcutKey } from '../shared/types';
import { GLOBAL_SHORTCUT_ACCELERATORS } from '../shared/shortcuts';

/** 预设键位全局快捷键的原子重绑器：白名单映射 + 当前绑定追踪 + 失败回滚 */
interface ShortcutRebinder {
  /** 原子重绑：新键注册失败（被他应用占用）→ 回滚旧绑定 → 抛错，不静默丢键；
   *  'off' 或非法值（settings.json 手改/渲染层注入）= 注销不注册 */
  rebind(key: string): void;
  /** 绑定态复位（unregisterAll 后调用，保持内部簿记一致） */
  reset(): void;
}

function createShortcutRebinder(
  label: string,
  accelerators: Record<string, string>,
  onFire: () => void,
): ShortcutRebinder {
  /** 当前已注册键位（'off' = 未注册）；原子重绑的回滚依据 */
  let binding = 'off';
  const acceleratorFor = (key: string | undefined): string | null => {
    if (!key || key === 'off') return null;
    return accelerators[key] ?? null;
  };
  return {
    rebind(key: string): void {
      const prevKey = binding;
      const prevAcc = acceleratorFor(prevKey);
      const nextAcc = acceleratorFor(key);
      if (nextAcc === prevAcc) return;
      if (prevAcc) globalShortcut.unregister(prevAcc);
      binding = 'off';
      if (!nextAcc) return;
      if (globalShortcut.register(nextAcc, onFire)) {
        binding = key;
        return;
      }
      // 新键被占用：回滚旧绑定（回滚也失败则保持未注册，错误照常上报）
      if (prevAcc && globalShortcut.register(prevAcc, onFire)) {
        binding = prevKey;
      }
      throw new Error(`${label} shortcut register failed: ${nextAcc}`);
    },
    reset(): void {
      binding = 'off';
    },
  };
}

/** 两个 rebinder 在 registerShortcuts 时创建（handler 复用启动时登记的那份） */
let blankNoteRebinder: ShortcutRebinder | null = null;
let quickCaptureRebinder: ShortcutRebinder | null = null;

/** set-advanced 联动：按新键位原子重绑（共用池：两功能选同一键时后注册者失败回滚） */
export function rebindBlankNoteShortcut(key: GlobalShortcutKey): void {
  blankNoteRebinder?.rebind(key);
}

export function rebindQuickCaptureShortcut(key: GlobalShortcutKey): void {
  quickCaptureRebinder?.rebind(key);
}

/** 注册全局快捷键。 */
export function registerShortcuts(windowManager: WindowManager): void {
  // 速记浮窗：即使应用没有窗口打开也能呼出；键位按设置注册（缺省 Ctrl+Shift+N 现状）
  quickCaptureRebinder = createShortcutRebinder('quick capture', GLOBAL_SHORTCUT_ACCELERATORS, () => {
    windowManager.showQuickCapture();
  });
  try {
    quickCaptureRebinder.rebind(getAdvanced().quickCaptureShortcut);
  } catch (err) {
    console.error('[shortcut] quick capture shortcut register failed at startup:', err);
  }

  // 空白便签快捷键（缺省 off 不注册）：按下在根目录新建空白便签并聚焦——
  // 仅快捷键路径 focus，会话恢复/列表打开等建窗路径不抢焦点
  blankNoteRebinder = createShortcutRebinder('blank note', GLOBAL_SHORTCUT_ACCELERATORS, () => {
    windowManager
      .createNoteWindow()
      .then((id) => windowManager.focusNoteWindow(id))
      .catch((err) => console.error('[shortcut] blank note create failed:', err));
  });
  try {
    blankNoteRebinder.rebind(getAdvanced().blankNoteShortcut);
  } catch (err) {
    console.error('[shortcut] blank note shortcut register failed at startup:', err);
  }
}

/** 注销全部全局快捷键（退出前调用）。unregisterAll 天然覆盖两个白名单快捷键。 */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
  blankNoteRebinder?.reset();
  quickCaptureRebinder?.reset();
}

import type { GlobalShortcutKey } from './types';

/** 全局快捷键预设键位池（速记/空白便签共用）的单一来源：
 *  有序键位列表（渲染层下拉选项顺序）、electron accelerator 映射（main 注册用）、
 *  本地化键名的 i18n 键（渲染层选项与托盘菜单共用）。
 *  新增键位在此登记三处映射即完成接入。 */
export const GLOBAL_SHORTCUT_KEYS: readonly Exclude<GlobalShortcutKey, 'off'>[] = [
  'ctrl+shift+n',
  'ctrl+alt+q',
  'ctrl+shift+q',
  'ctrl+alt+n',
  'ctrl+shift+alt+n',
  'ctrl+alt+insert',
];

export const GLOBAL_SHORTCUT_ACCELERATORS: Record<Exclude<GlobalShortcutKey, 'off'>, string> = {
  'ctrl+shift+n': 'CommandOrControl+Shift+N',
  'ctrl+alt+q': 'CommandOrControl+Alt+Q',
  'ctrl+shift+q': 'CommandOrControl+Shift+Q',
  'ctrl+alt+n': 'CommandOrControl+Alt+N',
  'ctrl+shift+alt+n': 'CommandOrControl+Shift+Alt+N',
  'ctrl+alt+insert': 'CommandOrControl+Alt+Insert',
};

export const GLOBAL_SHORTCUT_LABEL_KEYS: Record<Exclude<GlobalShortcutKey, 'off'>, string> = {
  'ctrl+shift+n': 'settings.shortcutCtrlShiftN',
  'ctrl+alt+q': 'settings.shortcutCtrlAltQ',
  'ctrl+shift+q': 'settings.shortcutCtrlShiftQ',
  'ctrl+alt+n': 'settings.shortcutCtrlAltN',
  'ctrl+shift+alt+n': 'settings.shortcutCtrlShiftAltN',
  'ctrl+alt+insert': 'settings.shortcutCtrlAltInsert',
};

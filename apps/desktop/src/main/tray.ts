import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { app, Menu, nativeImage, Tray } from 'electron';
import { tMain } from './i18n';
import { getAdvanced } from './settings';
import type { GlobalShortcutKey } from '../shared/types';
import { GLOBAL_SHORTCUT_LABEL_KEYS } from '../shared/shortcuts';
import type { WindowManager } from './windows/window-manager';

// 16x16 黄色方块 PNG 的兜底图标（resources/icon.png 缺失时保证托盘不崩）
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4' +
  'AWMYWuA/GsZfAgOMhkbDaGg0DIZGw2hoNIyGRsNoaDSMhkYDAGs2F9F3oTlVAAAAAElFTkSuQmCC';

let trayRef: Tray | null = null;
let windowManagerRef: WindowManager | null = null;

function loadTrayIcon(): Electron.NativeImage {
  // macOS 菜单栏惯例是 template 黑白图标（随深浅菜单栏自动反色）：
  // 优先用 iconTemplate.png（icon.png 的黑色剪影版），彩色原图仅作回退
  const isTemplate = process.platform === 'darwin' && existsSync(join(app.getAppPath(), 'resources', 'iconTemplate.png'));
  const iconPath = isTemplate
    ? join(app.getAppPath(), 'resources', 'iconTemplate.png')
    : join(app.getAppPath(), 'resources', 'icon.png');
  let img: Electron.NativeImage | null = null;
  if (existsSync(iconPath)) {
    const loaded = nativeImage.createFromPath(iconPath);
    if (!loaded.isEmpty()) img = loaded;
  }
  if (!img) img = nativeImage.createFromDataURL(FALLBACK_ICON);
  // macOS 菜单栏托盘不会像 Windows 那样自动缩放：
  // 直接给 1024px 原图会把整个菜单栏撑爆（巨型横带）。
  // 菜单栏图标固定 18pt，附带 @2x 适配 Retina。
  if (process.platform === 'darwin') {
    const small = img.resize({ width: 18, height: 18, quality: 'best' });
    small.addRepresentation({
      scaleFactor: 2,
      buffer: img.resize({ width: 36, height: 36, quality: 'best' }).toPNG(),
    });
    if (isTemplate) small.setTemplateImage(true); // 声明为模板图：系统按菜单栏深浅自动反白/反黑
    return small;
  }
  return img;
}

/** 按当前语言重建托盘菜单（语言切换时由 IPC handler 触发） */
export function refreshTrayMenu(): void {
  if (!trayRef || !windowManagerRef) return;
  const windowManager = windowManagerRef;
  // 速记项跟随高级设置显示当前键位；off 或非法值（settings.json 手改）只显示名称
  const qcKey = getAdvanced().quickCaptureShortcut;
  const qcLabelKey = GLOBAL_SHORTCUT_LABEL_KEYS[qcKey as Exclude<GlobalShortcutKey, 'off'>];
  const quickLabel =
    qcKey !== 'off' && qcLabelKey
      ? tMain('tray.quickWithKey', { key: tMain(qcLabelKey) })
      : tMain('tray.quick');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: tMain('header.create'),
      click: () => {
        windowManager.createNoteWindow().catch((err) =>
          console.error('[tray] 新建便签失败:', err),
        );
      },
    },
    { label: quickLabel, click: () => windowManager.showQuickCapture() },
    { type: 'separator' },
    { label: tMain('tray.openMain'), click: () => windowManager.showMainWindow() },
    { type: 'separator' },
    { label: tMain('tray.quit'), click: () => app.quit() },
  ]);
  trayRef.setContextMenu(contextMenu);
}

/** 创建系统托盘：左键切换主窗口，右键菜单管理便签。
 *  幂等：已存在托盘时先销毁再建（高级设置关闭→重开、语言重建菜单等场景安全重入）。 */
export function createTray(windowManager: WindowManager): Tray {
  if (trayRef) destroyTray();
  trayRef = new Tray(loadTrayIcon());
  windowManagerRef = windowManager;
  refreshTrayMenu();
  trayRef.setToolTip('PinSlip');
  trayRef.on('click', () => windowManager.toggleMainWindow());
  return trayRef;
}

/** 销毁系统托盘并清空引用（高级设置关闭托盘图标时调用）；无托盘时 no-op。 */
export function destroyTray(): void {
  trayRef?.destroy();
  trayRef = null;
  windowManagerRef = null;
}

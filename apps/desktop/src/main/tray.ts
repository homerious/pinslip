import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { app, Menu, nativeImage, Tray } from 'electron';
import { tMain } from './i18n';
import type { WindowManager } from './windows/window-manager';

// 16x16 黄色方块 PNG 的兜底图标（resources/icon.png 缺失时保证托盘不崩）
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4' +
  'AWMYWuA/GsZfAgOMhkbDaGg0DIZGw2hoNIyGRsNoaDSMhkYDAGs2F9F3oTlVAAAAAElFTkSuQmCC';

let trayRef: Tray | null = null;
let windowManagerRef: WindowManager | null = null;

function loadTrayIcon(): Electron.NativeImage {
  const iconPath = join(app.getAppPath(), 'resources', 'icon.png');
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
    return small;
  }
  return img;
}

/** 按当前语言重建托盘菜单（语言切换时由 IPC handler 触发） */
export function refreshTrayMenu(): void {
  if (!trayRef || !windowManagerRef) return;
  const windowManager = windowManagerRef;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: tMain('header.create'),
      click: () => {
        windowManager.createNoteWindow().catch((err) =>
          console.error('[tray] 新建便签失败:', err),
        );
      },
    },
    { label: tMain('tray.quick'), click: () => windowManager.showQuickCapture() },
    { type: 'separator' },
    { label: tMain('tray.openMain'), click: () => windowManager.showMainWindow() },
    { type: 'separator' },
    { label: tMain('tray.quit'), click: () => app.quit() },
  ]);
  trayRef.setContextMenu(contextMenu);
}

/** 创建系统托盘：左键切换主窗口，右键菜单管理便签。 */
export function createTray(windowManager: WindowManager): Tray {
  trayRef = new Tray(loadTrayIcon());
  windowManagerRef = windowManager;
  refreshTrayMenu();
  trayRef.setToolTip('PinSlip');
  trayRef.on('click', () => windowManager.toggleMainWindow());
  return trayRef;
}

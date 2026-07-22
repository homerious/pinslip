import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { app, Menu, nativeImage, Tray } from 'electron';
import type { WindowManager } from './windows/window-manager';

// 16x16 黄色方块 PNG 的兜底图标（resources/icon.png 缺失时保证托盘不崩）
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4' +
  'AWMYWuA/GsZfAgOMhkbDaGg0DIZGw2hoNIyGRsNoaDSMhkYDAGs2F9F3oTlVAAAAAElFTkSuQmCC';

function loadTrayIcon(): Electron.NativeImage {
  const iconPath = join(app.getAppPath(), 'resources', 'icon.png');
  if (existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createFromDataURL(FALLBACK_ICON);
}

/** 创建系统托盘：左键切换主窗口，右键菜单管理便签。 */
export function createTray(windowManager: WindowManager): Tray {
  const tray = new Tray(loadTrayIcon());

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '新建便签',
      click: () => {
        windowManager.createNoteWindow().catch((err) =>
          console.error('[tray] 新建便签失败:', err),
        );
      },
    },
    { label: '速记（Ctrl+Shift+N）', click: () => windowManager.showQuickCapture() },
    { type: 'separator' },
    { label: '打开主窗口', click: () => windowManager.showMainWindow() },
    { type: 'separator' },
    { label: '退出 PinSlip', click: () => app.quit() },
  ]);

  tray.setToolTip('PinSlip');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => windowManager.toggleMainWindow());
  return tray;
}

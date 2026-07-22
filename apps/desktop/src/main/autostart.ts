import { app } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 开机自启（Windows 注册表 Run 键，由 Electron 维护）。
 * 仅打包后生效：dev 模式会指向 electron.exe 本体，写了也是垃圾项，故跳过。
 */

export function getAutoStart(): boolean {
  return app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
}

export function setAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/** 打包后首次运行默认开启自启；marker 文件保证只初始化一次，之后尊重用户选择 */
export function initAutoStart(): void {
  if (!app.isPackaged) return;
  const marker = join(app.getPath('userData'), '.autostart-init');
  if (existsSync(marker)) return;
  app.setLoginItemSettings({ openAtLogin: true });
  try {
    writeFileSync(marker, '1');
  } catch {
    /* marker 写失败最多下次再设一次，无妨 */
  }
}

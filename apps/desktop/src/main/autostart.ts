import { app } from 'electron';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 开机自启：
 * - Windows / macOS：app.setLoginItemSettings（注册表 Run 键 / 登录项，由 Electron 维护）
 * - Linux：setLoginItemSettings 不支持该平台，按 XDG Autostart 规范写
 *   ~/.config/autostart/pinslip.desktop，桌面环境（GNOME/KDE 等）登录时读取
 * 仅打包后生效：dev 模式会指向 electron 本体，写了也是垃圾项，故跳过。
 */

const isLinux = process.platform === 'linux';

function linuxAutostartFile(): string {
  return join(app.getPath('home'), '.config', 'autostart', 'pinslip.desktop');
}

/** Exec 直接用当前可执行文件路径：deb 安装后是 /opt/PinSlip/...，AppImage 是其本体路径 */
function linuxDesktopEntry(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=PinSlip',
    `Exec=${app.getPath('exe')}`,
    'X-GNOME-Autostart-enabled=true',
    'Comment=贴在桌面上的 Markdown 便利贴',
    '',
  ].join('\n');
}

function setLinuxAutoStart(enabled: boolean): void {
  const file = linuxAutostartFile();
  try {
    if (enabled) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, linuxDesktopEntry());
    } else if (existsSync(file)) {
      unlinkSync(file);
    }
  } catch {
    /* 自启文件读写失败不致命：设置项按文件实际状态回显，下次操作重试即可 */
  }
}

export function getAutoStart(): boolean {
  if (!app.isPackaged) return false;
  if (isLinux) return existsSync(linuxAutostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

export function setAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (isLinux) {
    setLinuxAutoStart(enabled);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/** 打包后首次运行默认开启自启；marker 文件保证只初始化一次，之后尊重用户选择 */
export function initAutoStart(): void {
  if (!app.isPackaged) return;
  const marker = join(app.getPath('userData'), '.autostart-init');
  if (existsSync(marker)) return;
  setAutoStart(true);
  try {
    writeFileSync(marker, '1');
  } catch {
    /* marker 写失败最多下次再设一次，无妨 */
  }
}

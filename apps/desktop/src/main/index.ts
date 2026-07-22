import { app, BrowserWindow, net, protocol } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WindowManager } from './windows/window-manager';
import { GoProcess, VAULT_NOT_SET } from './services/go-process';
import { registerIpcHandlers } from './ipc';
import { createTray } from './tray';
import { initAutoStart } from './autostart';
import { getVaultPath } from './settings';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { startVaultWatch, stopVaultWatch } from './services/vault-watch';
import { initAutoUpdater } from './updater';

// 只做装配：app 生命周期 + 各模块注册，业务逻辑分散到各模块
const goProcess = new GoProcess();
let windowManager: WindowManager;

app.whenReady().then(() => {
  electronApp.setAppUserModelId('app.pinslip');

  windowManager = new WindowManager(goProcess);

  // pinslip-img://attachments/<name> → vault 内图片（渲染端 img src 专用）。
  // 选自定义协议而非 http://127.0.0.1:<port>：Go 端口每次启动随机，
  // 写进 markdown 会过期；协议由主进程直接从 vault 读文件，与端口无关。
  // 只允许 attachments/ 前缀且拒绝 ..，防目录穿越。
  protocol.handle('pinslip-img', (req) => {
    const vault = getVaultPath();
    const rel = decodeURIComponent(req.url.slice('pinslip-img://'.length));
    if (!vault || !rel.startsWith('attachments/') || rel.includes('..')) {
      return new Response('forbidden', { status: 403 });
    }
    return net
      .fetch(pathToFileURL(path.join(vault, rel)).toString())
      .catch(() => new Response('not found', { status: 404 }));
  });

  // 拉起 Go 本地服务（未设置保险库时静默跳过，等用户选择后启动；
  // 其他失败不阻塞 UI，渲染层会提示服务不可用）
  goProcess.ensureStarted().catch((err) => {
    if (err.message !== VAULT_NOT_SET) {
      console.error('[main] Go 服务启动失败:', err);
    }
  });

  registerIpcHandlers({ windowManager, goProcess });
  createTray(windowManager);
  registerShortcuts(windowManager);
  initAutoStart(); // 打包后首次运行默认开启开机自启
  initAutoUpdater(); // 打包后启动 15s 静默检查更新（dev 短路）

  // 外部文件变更监听：同步盘/手动改 vault 时主界面列表自动刷新（未设保险库时为 no-op）
  startVaultWatch(() => windowManager.broadcastNotesChanged());

  windowManager.showMainWindow();
  // 会话恢复：已设保险库时，重新打开上次退出时开着的便签
  if (getVaultPath()) {
    windowManager.restoreNoteWindows().catch((err) =>
      console.error('[main] 会话恢复失败:', err),
    );
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });
});

// 托盘常驻应用：所有窗口关闭时不退出
app.on('window-all-closed', () => {
  // 保持运行，由托盘菜单退出
});

app.on('before-quit', () => {
  if (windowManager) windowManager.quitting = true; // 放行主窗口的 close 拦截，确保能真正退出
  unregisterShortcuts();
  stopVaultWatch();
  goProcess.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    windowManager.showMainWindow();
  }
});

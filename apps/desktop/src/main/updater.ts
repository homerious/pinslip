import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC } from '../shared/ipc-channels';
import type { UpdateState } from '../shared/types';

// 自动更新（electron-updater + GitHub Releases）：
// 主进程是唯一状态权威，渲染层通过 UpdateState 广播被动展示。
// 发布链路：electron-builder publish=github 构建时把 latest.yml/latest-mac.yml
// 与 blockmap 一起传 Release；运行期 autoUpdater 读 yml 比对版本、增量下载。
// 注意：仅打包环境生效——dev 下没有 yml 元信息且 app 路径不可写，直接短路。

const { autoUpdater } = electronUpdater;

let lastState: UpdateState = { status: 'idle' };
let initialized = false;

/** 状态落账 + 广播到全部窗口（主窗口设置页、便签都不主动弹，只更新设置页 UI） */
function setState(state: UpdateState): void {
  lastState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.UpdateState, state);
  }
}

/** 触发一次检查。dev 环境没有更新元信息，返回提示性错误态而非静默 */
export function checkForUpdate(): void {
  if (!app.isPackaged) {
    setState({ status: 'error', message: '开发模式不支持更新检查' });
    return;
  }
  setState({ status: 'checking' });
  autoUpdater.checkForUpdates().catch((err: Error) => {
    setState({ status: 'error', message: err.message || '检查更新失败' });
  });
}

/** 退出并安装。仅 downloaded 态有意义；autoInstallOnAppQuit 默认 true，直接退出 */
export function quitAndInstall(): void {
  if (!app.isPackaged) return;
  autoUpdater.quitAndInstall();
}

export function getUpdateState(): UpdateState {
  return lastState;
}

/** 装配：注册事件监听 + 启动后静默检查一次（延迟 15s，避开启动竞速与首屏加载） */
export function initAutoUpdater(): void {
  if (!app.isPackaged || initialized) return;
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // 中文错误信息兜底由渲染层展示 message；这里只透传
  autoUpdater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    setState({ status: 'latest', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    setState({ status: 'downloading', percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    setState({ status: 'error', message: err.message || '更新出错' });
  });

  setTimeout(() => {
    // 静默检查：结果只落状态，不打扰用户；设置页可看到「有新版本」
    autoUpdater.checkForUpdates().catch(() => {
      /* 启动静默检查失败不提示，用户可手动重试 */
    });
  }, 15_000);
}

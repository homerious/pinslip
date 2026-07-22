import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC } from '../shared/ipc-channels';
import type { UpdateState } from '../shared/types';

// 自动更新（electron-updater + GitHub Releases 主源 + OSS 镜像兜底）：
// 主进程是唯一状态权威，渲染层通过 UpdateState 广播被动展示。
// 发布链路：electron-builder publish=github 构建时把 latest.yml/latest-mac.yml
// 与 blockmap 一起传 Release（CI 同时同步到 OSS 镜像）；运行期 autoUpdater
// 读 yml 比对版本、增量下载。
// 回退策略：每次检查先回 GitHub 主源，失败且配置了镜像时切 generic 镜像重试一次，
// 再失败才进入 error 态。启动静默检查失败不打扰（保持 idle），手动检查失败才提示。
// 注意：仅打包环境生效——dev 下没有 yml 元信息且 app 路径不可写，直接短路。

const { autoUpdater } = electronUpdater;

/** GitHub 主源（与 electron-builder.yml 的 publish 配置一致，每次检查前重置） */
const GITHUB_FEED = { provider: 'github' as const, owner: 'homerious', repo: 'pinslip' };

/**
 * OSS 更新镜像（国内兜底，见 docs/ops-update-mirror.md）。
 * 开桶后填入固定地址，形如 'https://<bucket>.<endpoint>/pinslip/'，
 * 随下一个版本发布生效；空串 = 未配置镜像，GitHub 失败直接报 error。
 */
const MIRROR_URL = '';
const MIRROR_FEED = MIRROR_URL ? { provider: 'generic' as const, url: MIRROR_URL } : null;

let lastState: UpdateState = { status: 'idle' };
let initialized = false;
/** 本次检查是否已试过镜像（每次检查重置，最多回退一次） */
let triedMirror = false;
/** 启动静默检查期间不落地 error 态（网络不好不打扰；手动检查才提示） */
let silentCheck = false;

/** 状态落账 + 广播到全部窗口（主窗口设置页、便签都不主动弹，只更新设置页 UI） */
function setState(state: UpdateState): void {
  lastState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.UpdateState, state);
  }
}

/** 触发一次检查。silent=true 用于启动静默检查：失败不落地错误态 */
function doCheck(silent: boolean): void {
  triedMirror = false;
  silentCheck = silent;
  // 每次检查先回主源：上次若切过镜像，这次重新给 GitHub 机会（镜像只是兜底）
  autoUpdater.setFeedURL(GITHUB_FEED);
  if (!silent) setState({ status: 'checking' });
  autoUpdater.checkForUpdates().catch(() => {
    /* 错误统一走 error 事件处理（含镜像回退） */
  });
}

/** 手动检查更新（设置页按钮）。dev 环境没有更新元信息，返回提示性错误态而非静默 */
export function checkForUpdate(): void {
  if (!app.isPackaged) {
    setState({ status: 'error', message: '开发模式不支持更新检查' });
    return;
  }
  doCheck(false);
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
    // 镜像回退：主源失败且配置了镜像时切过去重试一次（对静默/手动检查一视同仁）
    if (MIRROR_FEED && !triedMirror) {
      triedMirror = true;
      autoUpdater.setFeedURL(MIRROR_FEED);
      autoUpdater.checkForUpdates().catch(() => {
        /* 再失败会重新进入本事件，triedMirror 已置位，落到 error 态 */
      });
      return;
    }
    if (silentCheck) return; // 启动静默检查失败不打扰，用户可手动重试
    setState({ status: 'error', message: err.message || '更新出错' });
  });

  setTimeout(() => {
    doCheck(true);
  }, 15_000);
}

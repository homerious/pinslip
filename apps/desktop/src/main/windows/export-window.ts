import { BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { IPC } from '../../shared/ipc-channels';
import type { ExportImagePayload, ExportImageResult } from '../../shared/types';
import { loadView, viewWebPreferences } from './view-helper';
import { tMain } from '../i18n';

/** 兜底宽度（调用方窗口不可用时）：840 CSS px；实际分辨率 = 所在屏 scaleFactor × 宽度 */
const FALLBACK_WIDTH = 840;
/** 便签透明窗的阴影边距（16px×2）：窗口内容宽 − 此值 = 便签卡片实际宽（与 global.css --note-margin 同源） */
const NOTE_MARGIN_X = 32;
/** 导出舞台左右 padding（64px×2，global.css .export-stage）：卡片宽 + 此值 = 导出窗宽 */
const STAGE_PADDING_X = 128;
/** 卡片宽合法区间：过窄便签保底、超宽便签封顶（分享图观感） */
const CARD_MIN_WIDTH = 240;
const CARD_MAX_WIDTH = 1200;
/** 上报高度的合法区间：低于下限按下限、超出上限裁切（不做长图分页） */
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 5000;
/** 等 ExportReady 的超时：超时按当前窗口内容直接截图兜底，不整单失败 */
const READY_TIMEOUT_MS = 10_000;
/** setContentSize 后的重排/重绘稳定延时（隐藏窗 capturePage 空白帧规避） */
const SETTLE_DELAY_MS = 80;

/** 并发纪律：同一时间只允许一次导出（隐藏窗/IPC 匹配都是单例假设） */
let exporting = false;

/** 保存对话框默认文件名：去 Windows 非法字符、截 50 字，空标题回退 note */
function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 50);
  return cleaned || 'note';
}

/** 文件名时间戳（本地时区 yyyymmdd-hhmmss）：避免同名便签重复导出互相覆盖 */
function fileTimestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 导出窗宽 = 便签卡片实际宽（窗口内容宽 − 阴影边距，clamp 后）+ 舞台 padding；
 *  宽度建窗时一次定稿——宽度决定文字换行进而决定高度，不能等 ExportReady 后再改 */
function exportWidthOf(caller: BrowserWindow | null): number {
  try {
    const cw = caller && !caller.isDestroyed() ? caller.getContentSize()[0] : 0;
    if (cw > 0) {
      const card = Math.min(Math.max(cw - NOTE_MARGIN_X, CARD_MIN_WIDTH), CARD_MAX_WIDTH);
      return card + STAGE_PADDING_X;
    }
  } catch {
    // 调用方窗口状态不可读时落兜底宽
  }
  return FALLBACK_WIDTH;
}

/** 导出全流程：隐藏离屏窗渲染 ExportView → 就绪后定稿高度 → capturePage →
 *  copy 写剪贴板 / save 弹保存对话框写盘。任何一步出错都清理现场并返回
 *  { ok:false, error }；取消保存对话框返回 { ok:true, canceled:true } */
export async function runExport(
  payload: ExportImagePayload,
  event: Electron.IpcMainInvokeEvent,
): Promise<ExportImageResult> {
  if (exporting) return { ok: false, error: 'export already in progress' };
  exporting = true;
  const caller = BrowserWindow.fromWebContents(event.sender);
  const exportWidth = exportWidthOf(caller);
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false, // 隐藏窗；paintWhenInitiallyHidden 缺省 true，离屏可绘制
      frame: false,
      width: exportWidth, // 跟随便签实际卡片宽（建窗即定稿，见 exportWidthOf）
      height: 600, // 初始高度占位，ExportReady 后按内容定稿
      enableLargerThanScreen: true, // 超高内容（上限 5000）可超出屏幕
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        ...viewWebPreferences(),
        backgroundThrottling: false, // 隐藏窗也要正常出帧，capturePage 才不拿空白
      },
    });
    const contents = win.webContents;
    // 握手监听先挂（可能早于 did-finish-load 到达）：ExportView 挂载订阅后上报，
    // 每次握手重发一次 payload（幂等，StrictMode 双挂载兜底）
    const onViewReady = (e: Electron.IpcMainEvent): void => {
      if (e.sender.id === contents.id) contents.send(IPC.ExportPayload, payload);
    };
    ipcMain.on(IPC.ExportViewReady, onViewReady);
    try {
      loadView(win, '/export');
      await new Promise<void>((resolve, reject) => {
        contents.once('did-finish-load', () => resolve());
        contents.once('did-fail-load', (_e, code, desc) =>
          reject(new Error(`export view load failed (${code}): ${desc}`)),
        );
      });

      // 等 ExportView 上报内容高度；按 sender.id 匹配导出窗，避免频道多窗口串扰
      const reported = await new Promise<number>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          ipcMain.removeListener(IPC.ExportReady, listener);
        };
        const listener = (e: Electron.IpcMainEvent, height: number) => {
          if (e.sender.id !== contents.id) return;
          cleanup();
          resolve(typeof height === 'number' && height > 0 ? height : 0);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(0); // 超时兜底：保留初始高度直接截图
        }, READY_TIMEOUT_MS);
        ipcMain.on(IPC.ExportReady, listener);
      });
      if (reported > 0) {
        win.setContentSize(exportWidth, Math.min(Math.max(Math.ceil(reported), MIN_HEIGHT), MAX_HEIGHT));
      }
      await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS));
      const image = await contents.capturePage();

      if (payload.action === 'copy') {
        const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' });
        await clipboard.write([new ClipboardItem({ 'image/png': png })]);
        return { ok: true };
      }
      const res = await dialog.showSaveDialog(caller ?? win, {
        title: tMain('dialog.exportSaveTitle'),
        buttonLabel: tMain('dialog.exportSaveButton'),
        defaultPath: `${sanitizeFileName(payload.title)}-${fileTimestamp()}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      await writeFile(res.filePath, image.toPNG());
      return { ok: true };
    } finally {
      ipcMain.removeListener(IPC.ExportViewReady, onViewReady);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    exporting = false;
    win?.destroy();
  }
}

import { app, dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { IPC } from '../../shared/ipc-channels';
import type { RuntimeInfo } from '../../shared/types';
import type { WindowManager } from '../windows/window-manager';
import type { GoProcess } from '../services/go-process';
import { getVaultPath, setVaultPath } from '../settings';
import { getAutoStart, setAutoStart } from '../autostart';
import { startVaultWatch } from '../services/vault-watch';
import { checkForUpdate, getUpdateState, quitAndInstall } from '../updater';

interface IpcContext {
  windowManager: WindowManager;
  goProcess: GoProcess;
}

/** 统一注册全部 IPC handler。 */
export function registerIpcHandlers({ windowManager, goProcess }: IpcContext): void {
  // 运行时信息：未设置保险库时 vaultPath=null（渲染层引导选择，服务不启动）
  ipcMain.handle(IPC.RuntimeInfo, async (): Promise<RuntimeInfo> => {
    const version = app.getVersion();
    const vaultPath = getVaultPath();
    if (!vaultPath) {
      return {
        goPort: 0,
        platform: process.platform,
        vaultPath: null,
        isPackaged: app.isPackaged,
        version,
      };
    }
    const goPort = await goProcess.ensureStarted();
    return { goPort, platform: process.platform, vaultPath, isPackaged: app.isPackaged, version };
  });

  ipcMain.handle(IPC.WindowCreate, async (_event, noteId?: string, folder?: string) => {
    await windowManager.createNoteWindow(noteId, folder);
  });

  ipcMain.handle(IPC.WindowClose, (_event, noteId: string) => {
    windowManager.closeNoteWindow(noteId);
  });

  ipcMain.handle(IPC.WindowSetPin, (_event, noteId: string, pinned: boolean) => {
    windowManager.setNotePin(noteId, pinned);
  });

  // 便签当前组态查询（渲染层挂载时主动拉取：关窗保留组成员，重开回归）
  ipcMain.handle(IPC.GroupGetState, (_event, noteId: string) => {
    return windowManager.getGroupState(noteId);
  });

  // 整组拖动（组手柄）：begin 记起始矩形 + 抑制成员吸附并启动光标轮询；
  // end 停轮询并对组包围盒做屏幕边缘吸附（位移不再经渲染层转发——
  // clientX 相对窗口，窗口一动会回流成自我振荡）
  ipcMain.handle(IPC.GroupDragBegin, (_event, noteId: string) => {
    windowManager.beginGroupDrag(noteId);
  });
  ipcMain.handle(IPC.GroupDragEnd, (_event, noteId: string) => {
    windowManager.endGroupDrag(noteId);
  });
  // 组重命名（组标签手柄双击改名提交）
  ipcMain.handle(IPC.GroupRename, (_event, noteId: string, name: string) => {
    windowManager.renameGroup(noteId, name);
  });
  // 解散组（组手柄右键菜单）：全员退组、位置原地不动
  ipcMain.handle(IPC.GroupDissolve, (_event, noteId: string) => {
    windowManager.dissolveGroup(noteId);
  });

  // 折叠/展开便签窗口（窗口变形与展开尺寸记忆；collapsed 持久化由渲染进程走笔记 API）
  ipcMain.handle(IPC.NoteSetCollapsed, (_event, noteId: string, collapsed: boolean) => {
    windowManager.setNoteCollapsed(noteId, collapsed);
  });

  ipcMain.handle(IPC.WindowList, () => {
    return windowManager.listNoteWindows();
  });

  ipcMain.handle(IPC.MainWindowShow, () => {
    windowManager.showMainWindow();
  });

  ipcMain.handle(IPC.NoteResizeBegin, (_event, noteId: string) => {
    windowManager.beginNoteResize(noteId);
  });

  ipcMain.handle(IPC.NoteResize, (_event, noteId: string, dx: number, dy: number) => {
    windowManager.resizeNote(noteId, dx, dy);
  });

  // 自制缩放手柄不走 OS 模态循环（无 WM_EXITSIZEMOVE），组内几何收敛挂在这里
  ipcMain.handle(IPC.NoteResizeEnd, (_event, noteId: string) => {
    windowManager.endNoteResize(noteId);
  });

  // 选择保险库：系统目录选择框 → 保存设置 → 关闭便签窗口 → 按新目录重启 Go 服务
  ipcMain.handle(IPC.SettingsChooseVault, async () => {
    const res = await dialog.showOpenDialog({
      title: '选择便签存储位置',
      buttonLabel: '选择此文件夹',
      defaultPath: getVaultPath() ?? path.join(app.getPath('documents'), 'PinSlip'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;

    const dir = res.filePaths[0];
    setVaultPath(dir);
    windowManager.closeAllNoteWindows(); // 旧 vault 的便签窗口全部失效
    const goPort = await goProcess.restart();
    // 组注册表切到新 vault（旧 vault 的组关系对新数据无意义）
    await windowManager.reloadGroups().catch((err) => console.error('[group] reload failed:', err));
    startVaultWatch(() => windowManager.broadcastNotesChanged()); // 监听切到新 vault
    return { vaultPath: dir, goPort };
  });

  // 在系统文件管理器中打开保险库的 notes 目录（便签文件实际所在）
  ipcMain.handle(IPC.SettingsOpenVault, async () => {
    const vault = getVaultPath();
    if (!vault) return;
    const notesDir = path.join(vault, 'notes');
    await shell.openPath(existsSync(notesDir) ? notesDir : vault);
  });

  // 在系统文件管理器中打开回收区（<vault>/.trash）。
  // 用户从这里把误删的文件夹拖回 notes/ 即可找回（watcher 会自动重建索引）；
  // 目录可能尚不存在（从未 trash 过），先创建再打开，避免 openPath 报错
  ipcMain.handle(IPC.SettingsOpenTrash, async () => {
    const vault = getVaultPath();
    if (!vault) return;
    const trashDir = path.join(vault, '.trash');
    mkdirSync(trashDir, { recursive: true });
    await shell.openPath(trashDir);
  });

  // 在系统文件管理器中打开 notes/ 下指定子文件夹（便签「打开目录」）。
  // 防目录穿越：拒绝 .. 段，拼接后强制仍在 notesDir 内。
  ipcMain.handle(IPC.NoteOpenFolder, async (_event, folder: string) => {
    const vault = getVaultPath();
    if (!vault) return;
    const notesDir = path.join(vault, 'notes');
    const rel = String(folder ?? '');
    if (rel.split('/').some((seg) => seg === '..' || seg === '')) return;
    const target = path.resolve(notesDir, rel);
    if (target !== notesDir && !target.startsWith(notesDir + path.sep)) return;
    await shell.openPath(existsSync(target) ? target : notesDir);
  });

  // 开机自启：仅打包环境真实读写（dev 下 get 恒 false / set 为 no-op，见 autostart.ts）
  ipcMain.handle(IPC.SettingsGetAutoStart, () => getAutoStart());
  ipcMain.handle(IPC.SettingsSetAutoStart, (_event, enabled: boolean) => {
    setAutoStart(enabled);
  });

  // 笔记变更广播：任一渲染进程上报 → 转发主窗口刷新列表
  ipcMain.on(IPC.NotesChanged, () => {
    windowManager.broadcastNotesChanged();
  });

  // 自动更新：主进程 updater 模块是唯一状态权威，这里只做转发
  ipcMain.handle(IPC.UpdateCheck, () => {
    checkForUpdate();
  });
  ipcMain.handle(IPC.UpdateInstall, () => {
    quitAndInstall();
  });
  ipcMain.handle(IPC.UpdateGetState, () => getUpdateState());
}

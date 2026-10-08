import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { IPC } from '../../shared/ipc-channels';
import type { AdvancedSettings, ExportImagePayload, RuntimeInfo } from '../../shared/types';
import type { WindowManager } from '../windows/window-manager';
import type { GoProcess } from '../services/go-process';
import { runExport } from '../windows/export-window';
import { getVaultPath, setVaultPath, getLanguage, setLanguage, getAdvanced, setAdvanced } from '../settings';
import { getAutoStart, setAutoStart } from '../autostart';
import { setMainLanguage, tMain } from '../i18n';
import { createTray, destroyTray, refreshTrayMenu } from '../tray';
import { resolveSystemLanguage } from '../../shared/languages';
import { startVaultWatch } from '../services/vault-watch';
import { checkForUpdate, getUpdateState, quitAndInstall } from '../updater';
import { rebindBlankNoteShortcut, rebindQuickCaptureShortcut } from '../shortcuts';

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

  // 速记窗失焦豁免判定：渲染层 blur 时查询 DevTools 是否开着（开着则不关窗）
  ipcMain.handle(IPC.WindowDevToolsOpen, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.webContents.isDevToolsOpened() : false;
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

  ipcMain.handle(IPC.NoteResize, (_event, noteId: string, dx: number, dy: number, edge?: 'left') => {
    windowManager.resizeNote(noteId, dx, dy, edge);
  });

  // 自制缩放手柄不走 OS 模态循环（无 WM_EXITSIZEMOVE），组内几何收敛挂在这里
  ipcMain.handle(IPC.NoteResizeEnd, (_event, noteId: string) => {
    windowManager.endNoteResize(noteId);
  });

  // 选择保险库：系统目录选择框 → 保存设置 → 关闭便签窗口 → 按新目录重启 Go 服务
  ipcMain.handle(IPC.SettingsChooseVault, async () => {
    const res = await dialog.showOpenDialog({
      // 文案走主进程 i18n（跟随界面语言，默认跟随系统）：buttonLabel 会覆盖
      // 系统对话框的确认按钮，硬编码中文会让外文系统用户看到「确定/选择此文件夹」
      title: tMain('dialog.chooseVaultTitle'),
      buttonLabel: tMain('dialog.chooseVaultButton'),
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
    if (rel !== '' && rel.split('/').some((seg) => seg === '..' || seg === '')) return;
    const target = path.resolve(notesDir, rel);
    if (target !== notesDir && !target.startsWith(notesDir + path.sep)) return;
    const openError = await shell.openPath(existsSync(target) ? target : notesDir);
    if (openError) console.error('[open-folder] shell.openPath failed:', openError);
  });

  // 开机自启：仅打包环境真实读写（dev 下 get 恒 false / set 为 no-op，见 autostart.ts）
  ipcMain.handle(IPC.SettingsGetAutoStart, () => getAutoStart());
  ipcMain.handle(IPC.SettingsSetAutoStart, (_event, enabled: boolean) => {
    setAutoStart(enabled);
  });

  // 界面语言：偏好存 userData/settings.json；systemLocale 给渲染层解析「跟随系统」
  ipcMain.handle(IPC.SettingsGetLanguage, () => ({
    preference: getLanguage(),
    systemLocale: app.getLocale(),
  }));
  ipcMain.handle(IPC.SettingsSetLanguage, (_event, lang: string) => {
    setLanguage(lang);
    setMainLanguage(lang); // main 侧（托盘/更新文案）即时跟进
    refreshTrayMenu();
    // 广播给所有已开窗口：各 renderer 的 i18n 实例即时切换（语言偏好已持久化，
    // 广播只发生效语言码，'system' 由各端按自己的系统 locale 解析——同一机器结果一致）
    const effective = lang === 'system' ? resolveSystemLanguage(app.getLocale()) : lang;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.LanguageChanged, effective);
    }
  });

  // OS 深色模式事实：managerTheme='system' 时渲染层合成生效主题的输入之一
  ipcMain.handle(IPC.SettingsGetOsDark, () => nativeTheme.shouldUseDarkColors);

  // 高级设置：整对象读取（缺省已补）；按键部分更新。trayIcon 变化立即
  // 应用（销毁/重建托盘），taskbarIcon 变化立即应用（主窗口 setSkipTaskbar，
  // 窗口未创建时由建窗读取补齐），blankNoteShortcut/quickCaptureShortcut 变化原子重绑
  // 全局快捷键（重绑失败抛错回渲染层，设置不持久化、旧绑定不丢），其余字段持久化即生效，
  // 返回补齐后的完整对象
  ipcMain.handle(IPC.SettingsGetAdvanced, () => getAdvanced());
  ipcMain.handle(IPC.SettingsSetAdvanced, (_event, patch: AdvancedSettings) => {
    const before = getAdvanced();
    // 空白便签/速记快捷键：原子重绑先行——新键注册失败则整体不生效（不持久化、不丢旧绑定）
    if (patch.blankNoteShortcut !== undefined && patch.blankNoteShortcut !== before.blankNoteShortcut) {
      rebindBlankNoteShortcut(patch.blankNoteShortcut);
    }
    if (
      patch.quickCaptureShortcut !== undefined &&
      patch.quickCaptureShortcut !== before.quickCaptureShortcut
    ) {
      rebindQuickCaptureShortcut(patch.quickCaptureShortcut);
      // 托盘菜单速记项显示当前键位：重绑成功后即时重建（无托盘时 no-op）
      refreshTrayMenu();
    }
    setAdvanced(patch);
    const after = getAdvanced();
    if (before.trayIcon !== after.trayIcon) {
      if (after.trayIcon) createTray(windowManager);
      else destroyTray();
    }
    if (before.taskbarIcon !== after.taskbarIcon) {
      windowManager.setAllWindowsSkipTaskbar(!after.taskbarIcon);
    }
    // 广播给所有已开窗口（仿语言切换先例）：便签窗口据此即时重排工具栏按钮，
    // 无需重开；参数为补齐后的完整对象，渲染层直接取用 toolbarButtons
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.AdvancedChanged, after);
    }
    return after;
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
  // 手动下载兜底：URL 固定在主进程，渲染层不能传参，避免 openExternal 被滥用成开放跳转
  ipcMain.handle(IPC.UpdateOpenDownload, async () => {
    await shell.openExternal('https://github.com/homerious/pinslip/releases/latest');
  });

  // 导出便签为图片：主进程开隐藏离屏窗渲染 ExportView 后截图
  // （copy 写剪贴板 / save 弹保存对话框写盘），全程不触碰真实便签窗口
  ipcMain.handle(IPC.ExportImage, (event, payload: ExportImagePayload) =>
    runExport(payload, event),
  );
}

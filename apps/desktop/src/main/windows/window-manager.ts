import { BrowserWindow } from 'electron';
import { createNoteWindow, NOTE_COLLAPSED_HEIGHT, setNoteWindowCollapsed } from './note-window';
import { createQuickCaptureWindow } from './quick-capture';
import { createMainWindow } from './main-window';
import { GroupManager } from './group-manager';
import { getOpenNotes, setOpenNotes } from '../settings';
import { IPC } from '../../shared/ipc-channels';
import type { GroupState } from '../../shared/types';
import type { GoProcess } from '../services/go-process';

/**
 * 窗口池：管理所有便签窗口、速记浮窗与主窗口的生命周期。
 */
export class WindowManager {
  private noteWindows = new Map<string, BrowserWindow>();
  private quickCaptureWindow: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  /** 应用退出中：before-quit 置位，主窗口的 close 不再拦截为隐藏 */
  quitting = false;
  /** 便签拖拽缩放的起始尺寸（begin 时记录，resize 按累计位移计算） */
  private resizeStartSize = new Map<string, [number, number]>();
  /** 切换保险库中：此期间的关窗不退组（系统行为，不是用户意图） */
  private vaultSwitching = false;
  /** 便签组管理：成组/退组/restack/组态推送（启动时 load 拉注册表） */
  private readonly groupManager: GroupManager;
  /** 成组预告高亮映射：拖动方 noteId → 当前高亮目标 noteId（去重/清残用） */
  private stackHoverTargets = new Map<string, string>();

  constructor(private readonly goProcess: GoProcess) {
    this.groupManager = new GroupManager({
      goProcess,
      getWindow: (noteId) => this.noteWindows.get(noteId),
    });
    // 启动加载注册表 + frontmatter reconcile；失败只打日志，组功能降级
    this.groupManager.load().catch((err) => console.error('[group] load failed:', err));
  }

  /** 新建便签窗口；已有同 id 窗口则聚焦。noteId 为空时创建新 id。
   *  folder 仅新建时有效：随窗口路由下发，首次保存落盘到该文件夹 */
  async createNoteWindow(noteId?: string, folder?: string): Promise<string> {
    const id = noteId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

    const existing = this.noteWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return id;
    }

    // 已有笔记按持久化的 pin 恢复置顶状态；新便签默认置顶
    const alwaysOnTop = noteId ? await this.fetchPinState(noteId) : true;

    const win = createNoteWindow({
      noteId: id,
      index: this.noteWindows.size,
      alwaysOnTop,
      folder,
      // 便签间磁铁/成组判定：实时取除自己外的其他置顶便签（仅置顶便签参与）。
      // 自己在组内 → 空池（组成员不触发磁铁/成组，v1 组不合并）；
      // 目标在组内 → 带 grouped 标记：退出磁铁层但保留 stack-zone
      // （自由便签压上组成员 ≥50% = 加入该组）
      getOthers: () => {
        if (this.groupManager.isInGroup(id)) return [];
        return [...this.noteWindows]
          .filter(([otherId, w]) => otherId !== id && !w.isDestroyed() && w.isAlwaysOnTop())
          .map(([otherId, w]) => ({
            id: otherId,
            rect: w.getBounds(),
            grouped: this.groupManager.isInGroup(otherId),
          }));
      },
      // 成组手势：重叠 ≥50% 高亮预告（目标在组内时整组点亮，拖开即消）；
      // 松手结算：目标不在组 → 两两建组；目标在组 → 加入该组（插到被压成员下方）
      snapHooks: {
        onStackHover: (targetId) => {
          const prev = this.stackHoverTargets.get(id) ?? null;
          if (prev === targetId) return;
          if (prev) this.lightStackTarget(prev, false);
          if (targetId) {
            this.stackHoverTargets.set(id, targetId);
            this.lightStackTarget(targetId, true);
          } else {
            this.stackHoverTargets.delete(id);
          }
          this.groupManager.pushHover(id, targetId !== null);
        },
        onStackDrop: (targetId) => {
          // 松手结算：先清双方/整组高亮，再建组或加入已有组
          this.lightStackTarget(id, false);
          this.lightStackTarget(targetId, false);
          this.stackHoverTargets.delete(id);
          const gid = this.groupManager.groupOf(targetId);
          if (gid) this.groupManager.addMember(id, gid, targetId);
          else this.groupManager.createGroup(id, targetId);
        },
        // 真实松手：组内几何收敛出口（拖出 40px 解组 / 未拖出归位 +
        // 宽度统一 + 高度联动）；非组成员 no-op
        onReleased: () => {
          this.groupManager.handleMemberReleased(id);
        },
      },
    });
    this.noteWindows.set(id, win);
    this.syncOpenNotes();
    // 几何校正：组成员重开/会话恢复后瞬移归位（非成员 no-op；位置已正确时
    // restack 早退）。instant：启动/重开不该看到便签滑动
    this.groupManager.restackOf(id, undefined, { instant: true });
    // 最小化恢复归位：最小化不收拢（组留空位），恢复时滑回槽位
    win.on('restore', () => this.groupManager.restackOf(id));
    win.on('closed', () => {
      this.noteWindows.delete(id);
      // 成组预告残影清理：拖动方中途关窗，目标的高亮要收掉
      const hoverTarget = this.stackHoverTargets.get(id);
      if (hoverTarget) this.groupManager.pushHover(hoverTarget, false);
      this.stackHoverTargets.delete(id);
      // 关窗即退组（2026-07-21 评审改判）：内存剔除 + 其余成员收拢；
      // frontmatter 是否回写由 handleWindowClosed 核对笔记存在性决定。
      // 两种系统关闭除外——应用退出（组留给会话恢复）与切换保险库
      // （旧 vault 的组 frontmatter 原样保留）
      if (!this.quitting && !this.vaultSwitching) void this.groupManager.handleWindowClosed(id);
      // 应用退出过程中不同步——退出时开着的便签要留给下次启动恢复
      if (!this.quitting) this.syncOpenNotes();
    });
    return id;
  }

  /** 成组预告点亮/熄灭：目标在组内时整组一起亮（加入预览 = 你将成为这个
   *  整体的一员）；目标不在组内只亮自己 */
  private lightStackTarget(targetId: string, active: boolean): void {
    const members = this.groupManager.membersOf(targetId);
    if (members) {
      for (const m of members) this.groupManager.pushHover(m, active);
    } else {
      this.groupManager.pushHover(targetId, active);
    }
  }

  /** 启动时恢复上次退出时开着的便签（会话恢复）。 */
  async restoreNoteWindows(): Promise<void> {
    for (const id of getOpenNotes()) {
      await this.createNoteWindow(id).catch((err) =>
        console.error(`[main] 恢复便签窗口失败 ${id}:`, err),
      );
    }
  }

  /** 把当前打开的便签 id 列表写入设置（供会话恢复）。 */
  private syncOpenNotes(): void {
    setOpenNotes([...this.noteWindows.keys()]);
  }

  /** 从本地服务读取笔记的 pin 状态（失败时默认置顶，宁可打扰不可丢失） */
  private async fetchPinState(noteId: string): Promise<boolean> {
    try {
      const port = await this.goProcess.ensureStarted();
      const res = await fetch(`http://127.0.0.1:${port}/api/notes/${noteId}`);
      if (!res.ok) return true;
      const note = (await res.json()) as { pin?: boolean };
      return note.pin === true;
    } catch {
      return true;
    }
  }

  /** 切换便签窗口置顶状态（渲染进程发起，pin 持久化由渲染进程经 API 完成） */
  setNotePin(noteId: string, pinned: boolean): void {
    const win = this.noteWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(pinned);
    }
    // 取消置顶 = 自动退组（组是置顶层概念）；removeMember 内存态即时生效，
    // 持久化后台 fire-and-forget
    if (!pinned) this.groupManager.removeMember(noteId);
  }

  /** 便签当前组态（渲染层挂载时主动拉取：关窗保留组成员，重开回归恢复拼框） */
  getGroupState(noteId: string): GroupState | null {
    return this.groupManager.getState(noteId);
  }

  /** 重命名组（组标签手柄双击改名提交）：内存先行，注册表后台持久化 */
  renameGroup(noteId: string, name: string): void {
    this.groupManager.renameGroup(noteId, name);
  }

  /** 解散组（组手柄右键菜单）：全员退组、位置原地不动 */
  dissolveGroup(noteId: string): void {
    this.groupManager.dissolveGroup(noteId);
  }

  /** 切换保险库后重载组注册表（旧 vault 的组关系全部失效，窗口已全关）。
   *  reload 清空内存态后复位 vaultSwitching：此后迟到的 closed 事件在
   *  空表里找不到成员关系，handleWindowClosed 自然早退（双保险） */
  async reloadGroups(): Promise<void> {
    await this.groupManager.reload();
    this.vaultSwitching = false;
  }

  /** 整组拖动开始（组手柄 pointerdown）：记录全员起始矩形 + 抑制各自吸附，
   *  随后主进程 60fps 轮询光标跟随（不再经渲染层转发位移） */
  beginGroupDrag(noteId: string): void {
    this.groupManager.beginDrag(noteId);
  }

  /** 整组拖动结束：对组包围盒做屏幕边缘吸附，命中则全员同步滑动落位 */
  endGroupDrag(noteId: string): void {
    this.groupManager.endDrag(noteId);
  }

  /** 折叠/展开便签窗口（渲染进程发起，collapsed 持久化由渲染进程经 API 完成）。
   *  几何提交完成后联动所在组 restack：兄弟自动贴上（折叠）/下移让位（展开）。
   *  折叠额外做起步预告式重排：窗口几何要等 180ms 卷起动画末才提交，等提交
   *  兄弟才动会明显慢半拍——起步即按预告高度(64)重排，兄弟滑动(160ms)与
   *  卷起(180ms)同步收尾；提交后的真实重排兜底（目标一致 animateTo 早退）。
   *  幂等/恢复路径下预告重排目标=现状，同样早退无副作用 */
  setNoteCollapsed(noteId: string, collapsed: boolean): void {
    const win = this.noteWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      setNoteWindowCollapsed(win, noteId, collapsed, () => this.groupManager.restackOf(noteId));
      if (collapsed) this.groupManager.restackOf(noteId, NOTE_COLLAPSED_HEIGHT);
    }
  }

  /** 关闭指定便签窗口。 */
  closeNoteWindow(noteId: string): void {
    const win = this.noteWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      win.close();
    }
    this.noteWindows.delete(noteId);
  }

  /** 关闭全部便签窗口（切换保险库时调用，旧数据的窗口全部失效）。
   *  切库关闭是系统行为不是用户意图：关窗不退组（旧 vault 的组
   *  frontmatter 原样保留）；标志位在 reloadGroups 重载后复位 */
  closeAllNoteWindows(): void {
    this.vaultSwitching = true;
    for (const win of this.noteWindows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    this.noteWindows.clear();
  }

  /** 当前打开的便签窗口 id 列表。 */
  listNoteWindows(): string[] {
    return [...this.noteWindows.keys()];
  }

  /** 记录便签缩放起始尺寸。 */
  beginNoteResize(noteId: string): void {
    const win = this.noteWindows.get(noteId);
    if (win && !win.isDestroyed()) {
      this.resizeStartSize.set(noteId, win.getSize() as [number, number]);
    }
  }

  /** 按累计位移缩放便签窗口（setSize 自动受 minWidth/minHeight 约束）。 */
  resizeNote(noteId: string, dx: number, dy: number): void {
    const start = this.resizeStartSize.get(noteId);
    const win = this.noteWindows.get(noteId);
    if (start && win && !win.isDestroyed()) {
      win.setSize(Math.round(start[0] + dx), Math.round(start[1] + dy));
    }
  }

  /** 缩放结束（渲染层 pointerup）：清理起始尺寸 + 组内几何收敛。
   *  自制缩放手柄是渲染层 pointer 拖拽 + IPC setSize，不走 OS 模态循环
   *  （WM_EXITSIZEMOVE 不触发），宽度统一/高度联动/归位只能挂这个通知上 */
  endNoteResize(noteId: string): void {
    this.resizeStartSize.delete(noteId);
    // 缩放只改尺寸不动位置：绝无拖出（调矮会张开 >40px 空档误伤拖出判定），
    // 只做宽度统一/高度联动/归位
    this.groupManager.handleMemberReleased(noteId, { resized: true });
  }

  /** 显示速记浮窗（单例）。 */
  showQuickCapture(): void {
    if (this.quickCaptureWindow && !this.quickCaptureWindow.isDestroyed()) {
      this.quickCaptureWindow.focus();
      return;
    }
    this.quickCaptureWindow = createQuickCaptureWindow();
    this.quickCaptureWindow.on('closed', () => {
      this.quickCaptureWindow = null;
    });
  }

  /** 显示主窗口（单例；已存在则显示并聚焦）。 */
  showMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
      return;
    }
    this.mainWindow = createMainWindow();
    // 关闭主窗口 = 隐藏到托盘（保留列表滚动/搜索状态，托盘秒开）；
    // 应用真正退出时（quitting）放行关闭
    this.mainWindow.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        this.mainWindow?.hide();
      }
    });
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  /** 切换主窗口显隐（托盘左键）。 */
  toggleMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.showMainWindow();
    }
  }

  /** 笔记数据变更广播：转发到主窗口（驱动列表近实时刷新）和所有便签窗口
   *  （便签据此自检文件是否被外部删除，幽灵窗口自闭，见 NoteView）。
   *  主窗口隐藏时无害丢弃 */
  broadcastNotesChanged(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.NotesChanged);
    }
    for (const win of this.noteWindows.values()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.NotesChanged);
    }
  }
}

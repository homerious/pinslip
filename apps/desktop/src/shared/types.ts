// 三进程共享类型。与 docs/api.md 的契约保持一致。

/** 便签颜色（空字符串 = 默认黄） */
export type NoteColor = 'yellow' | 'pink' | 'green' | 'blue' | 'purple' | 'orange' | '';

/** 完整笔记 */
export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  pin: boolean;
  color: NoteColor;
  /** 折叠成标题条（只显示标题栏） */
  collapsed: boolean;
  /** 所属便签组 id（"" = 不属于任何组） */
  group: string;
  inbox: boolean;
  /** notes/ 下的相对子目录（正斜杠分隔），"" 为根目录 */
  folder: string;
  createdAt: string;
  updatedAt: string;
}

/** 列表项（不含正文） */
export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  source: string;
  pin: boolean;
  color: NoteColor;
  collapsed: boolean;
  /** 所属便签组 id（"" = 不属于任何组） */
  group: string;
  inbox: boolean;
  /** notes/ 下的相对子目录（正斜杠分隔），"" 为根目录 */
  folder: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

/** PUT /api/notes/{id} 请求体（部分更新：未提供的字段保留原值） */
export interface SaveNoteInput {
  content?: string;
  title?: string;
  tags?: string[];
  pin?: boolean;
  source?: string;
  color?: NoteColor;
  collapsed?: boolean;
  /** 便签组（与 collapsed 同语义）：不传 = 保留原组，"" = 移出组 */
  group?: string;
  /** 仅新建时生效：落盘文件夹（notes/ 相对路径）；已存在便签忽略 */
  folder?: string;
}

/** 便签在组内的角色：首/中/尾用于 CSS 拼框（圆角/描边/阴影按角色拆）；
 *  solo 是兜底态（组剩 1 人应已解散，正常不会出现） */
export type GroupRole = 'first' | 'middle' | 'last' | 'solo';

/** 便签的组态；不在组内为 null */
export interface GroupState {
  groupId: string;
  role: GroupRole;
  /** 用户自定义组名（未命名 undefined；首位成员的组标签手柄上展示） */
  name?: string;
}

/** 搜索结果 */
export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
}

/** 主进程提供给渲染进程的运行时信息 */
export interface RuntimeInfo {
  goPort: number;
  platform: string;
  /** 保险库路径；null = 未设置（首次使用，渲染层应引导选择） */
  vaultPath: string | null;
  /** 是否打包环境（开机自启/自动更新等功能仅打包后可用） */
  isPackaged: boolean;
  /** 应用版本号（package.json version，设置页展示用） */
  version: string;
}

/** 自动更新状态机（主进程唯一权威，渲染层只展示）：
 *  idle → checking → available → downloading → downloaded；
 *  无更新 → latest；失败 → error（可再次检查回到 checking） */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'latest'; version: string }
  | { status: 'error'; message: string };

/** preload 暴露到 window.api 的接口契约（唯一 IPC 出口） */
export interface ElectronAPI {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  /** 打开/新建便签窗口；folder 仅新建时有效：首次保存落盘到该文件夹（notes/ 相对路径） */
  createNote(noteId?: string, folder?: string): Promise<void>;
  closeNote(noteId: string): Promise<void>;
  setNotePin(noteId: string, pinned: boolean): Promise<void>;
  /** 折叠/展开便签窗口（窗口高度压到标题条/恢复记忆尺寸） */
  setNoteCollapsed(noteId: string, collapsed: boolean): Promise<void>;
  listWindows(): Promise<string[]>;
  showMainWindow(): Promise<void>;
  /** 便签角落拖拽缩放：开始时记录尺寸 */
  noteResizeBegin(noteId: string): Promise<void>;
  /** 便签角落拖拽缩放：按累计位移调整 */
  noteResize(noteId: string, dx: number, dy: number): Promise<void>;
  /** 便签拖拽缩放结束（pointerup）：触发组内几何收敛（宽度统一/高度联动/归位） */
  noteResizeEnd(noteId: string): Promise<void>;
  /** 选择保险库目录；取消返回 null，成功返回新路径与服务端口 */
  chooseVault(): Promise<{ vaultPath: string; goPort: number } | null>;
  /** 在系统文件管理器中打开保险库目录 */
  openVaultFolder(): Promise<void>;
  /** 在系统文件管理器中打开回收区目录（<vault>/.trash，用于手动找回误删内容） */
  openTrashFolder(): Promise<void>;
  /** 在系统文件管理器中打开 notes/ 下指定子文件夹（"" = notes 根目录） */
  openNoteFolder(folder: string): Promise<void>;
  /** 查询开机自启（仅打包环境有效，dev 下恒为 false） */
  getAutoStart(): Promise<boolean>;
  /** 设置开机自启（dev 环境下为 no-op） */
  setAutoStart(enabled: boolean): Promise<void>;
  /** 通知主进程：笔记数据已变更（保存/删除/速记），用于广播刷新主界面列表 */
  notifyNotesChanged(): void;
  /** 订阅笔记变更广播（主界面列表近实时刷新），返回取消订阅函数 */
  onNotesChanged(cb: () => void): () => void;
  /** 查询便签当前组态（挂载时主动拉取：成员关窗组保留，重开回归恢复拼框） */
  getGroupState(noteId: string): Promise<GroupState | null>;
  /** 成组预告高亮（拖动重叠 ≥50% 时双向点亮，拖开即消），返回取消订阅函数 */
  onGroupHover(cb: (active: boolean) => void): () => void;
  /** 组态推送（成组/退组/角色变化），返回取消订阅函数 */
  onGroupState(cb: (state: GroupState | null) => void): () => void;
  /** 整组拖动开始（组手柄 pointerdown）：主进程记录全员起始矩形、抑制各自吸附，
   *  并启动 60fps 光标轮询跟随（位移不再经渲染层转发） */
  groupDragBegin(noteId: string): Promise<void>;
  /** 整组拖动结束：对组包围盒做屏幕边缘吸附，命中则全员同步滑动落位 */
  groupDragEnd(noteId: string): Promise<void>;
  /** 重命名组（组标签手柄双击改名）；空串 = 清除命名 */
  groupRename(noteId: string, name: string): Promise<void>;
  /** 解散组（组手柄右键菜单）：全员退组、位置原地不动 */
  groupDissolve(noteId: string): Promise<void>;
  /** 手动检查更新（dev 环境下会通过状态广播返回提示错误） */
  checkUpdate(): Promise<void>;
  /** 退出并安装已下载的更新 */
  installUpdate(): Promise<void>;
  /** 拉取当前更新状态（设置页打开时同步快照） */
  getUpdateState(): Promise<UpdateState>;
  /** 订阅更新状态广播（检查中/发现新版本/下载进度/可安装），返回取消订阅函数 */
  onUpdateState(cb: (state: UpdateState) => void): () => void;
  /** 用系统浏览器打开下载页（更新检查失败时的手动下载兜底） */
  openDownloadPage(): Promise<void>;
}

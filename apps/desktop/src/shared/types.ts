// 三进程共享类型。与 docs/api.md 的契约保持一致。

/** 便签颜色（空字符串 = 默认黄） */
export type NoteColor = 'yellow' | 'pink' | 'green' | 'blue' | 'purple' | 'orange' | '';

/** 完整笔记 */
export interface Note {
  id: string;
  title: string;
  /** 手动标题标志（true = 用户重命名，正文保存不再自动推导） */
  titleManual?: boolean;
  content: string;
  tags: string[];
  source: string;
  pin: boolean;
  color: NoteColor;
  /** 折叠成标题条（只显示标题栏） */
  collapsed: boolean;
  /** 内容缩放倍率（1.3 = 130%；缺省 = 100%） */
  zoom?: number;
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
  /** 内容含 git 冲突标记行（^<<<<<<< ），列表显示「待解冲突」标识 */
  conflicted: boolean;
  /** 正文纯文本摘要（服务端 MakeExcerpt 生成，列表预览用；空正文缺省） */
  excerpt?: string;
  createdAt: string;
  updatedAt: string;
}

/** PUT /api/notes/{id} 请求体（部分更新：未提供的字段保留原值） */
export interface SaveNoteInput {
  content?: string;
  title?: string;
  /** 手动标题标志：不传 = 保留；true = 手动标题；false = 恢复自动（服务端立即按正文重推导） */
  titleManual?: boolean;
  tags?: string[];
  pin?: boolean;
  source?: string;
  color?: NoteColor;
  collapsed?: boolean;
  /** 内容缩放倍率；不传 = 保留，1 = 恢复默认（服务端删除字段） */
  zoom?: number;
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
  /** 内容含 git 冲突标记行（^<<<<<<< ），结果显示「待解冲突」标识 */
  conflicted: boolean;
}

/** git 同步状态（GET /api/sync/status 响应；token 永不返回） */
export interface SyncStatus {
  enabled: boolean;
  configured: boolean;
  url?: string;
  username?: string;
  branch?: string;
  /** RFC3339；Go 零值时间（0001-01-01）= 从未同步 */
  lastSyncAt?: string;
  lastError?: string;
  /** 与 lastError 配套的稳定错误码（映射 serverError.* i18n 文案，无码回退原文） */
  lastErrorCode?: string;
  /** 本地领先远端提交数（待推送） */
  ahead: number;
  behind: number;
  /** 含冲突 markers 的 .md 文件（vault 相对路径） */
  conflictedFiles: string[];
  /** 当前生效的自动推拉间隔（分钟） */
  pushIntervalMin: number;
  /** 有变更时自动同步：防抖后跑完整 commit+pull+push（false = 防抖只 commit） */
  syncOnChange: boolean;
  /** 分叉参考信息：仅 lastErrorCode === 'SYNC_UNRELATED_HISTORIES' 时出现——
   *  远端 head 是否含 .pinslip-repo 标记（false/缺省都不给接管入口） */
  remoteIsPinslip?: boolean;
  /** 远端最后提交时间（基于最近一次 fetch 的 origin 引用，RFC3339） */
  remoteLastCommitAt?: string;
  /** 本地 worktree notes/ 下 .md 数（分叉时供用户判断选哪边） */
  localNotes?: number;
  /** 远端 head 树 notes/ 下 .md 数 */
  remoteNotes?: number;
}

/** PUT /api/sync/config 请求体；token 空串 = 不修改已存 token */
export interface SaveSyncConfigInput {
  url: string;
  username: string;
  /** 留空 = 保留已存 token（表单不回显凭证） */
  token: string;
  branch: string;
  enabled: boolean;
  /** 自动推拉间隔（分钟，1~1440）；缺省/非法 Go 侧回退默认 10 */
  pushIntervalMin?: number;
  /** 有变更时自动同步（缺省 false = 防抖只 commit 的现状） */
  syncOnChange?: boolean;
  /**
   * 一次性认领标志：仅当接入报 SYNC_LOCAL_NOT_PINSLIP_REPO（本地已是 git
   * 仓库但缺 .pinslip-repo 标记）且用户显式确认时传 true——服务端创建标记
   * 并提交后完成接入。不落盘，其他错误码下无效。
   */
  adopt?: boolean;
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

/** 全局快捷键预设键位池（速记/空白便签共用，'off' = 不注册）。
 *  main/渲染共用的单一来源：渲染层只能选这些值，main 侧注册前再校验；
 *  两功能选同一键时后注册者失败回滚（Electron 对同应用内重复注册亦返回失败） */
export type GlobalShortcutKey =
  | 'off'
  | 'ctrl+shift+n'
  | 'ctrl+alt+q'
  | 'ctrl+shift+q'
  | 'ctrl+alt+n'
  | 'ctrl+shift+alt+n'
  | 'ctrl+alt+insert';

/** 高级设置选项（应用设置 settings.json 的 advanced 对象，main/渲染共用）。
 *  全部字段可选且有缺省值（缺省 = 简洁模型现状），新增选项 = 加字段，零新增 IPC */
export interface AdvancedSettings {
  /** 系统托盘图标显隐（缺省 true）；关闭后全部窗口关闭时应用退出 */
  trayIcon?: boolean;
  /** 主窗口任务栏图标显隐（缺省 true）；仅作用于主窗口，便签窗口任务栏入口不受影响 */
  taskbarIcon?: boolean;
  /** 新便签落点（缺省 'cascade' 固定位置级联；
   *  'beside-manager' = 跟随主窗口——仅全新便签且主窗口可见时生效） */
  notePlacement?: 'cascade' | 'beside-manager';
  /** 管理器主题（缺省 'light' 浅色现状；'system' = 跟随 OS 深色模式）；
   *  仅作用于主窗口与设置抽屉，便签窗口/速记窗口不受影响，列表卡片六色不主题化 */
  managerTheme?: 'light' | 'dark' | 'system';
  /** 空白便签全局快捷键（缺省 'off' 不注册）：按下在根目录新建空白便签并聚焦 */
  blankNoteShortcut?: GlobalShortcutKey;
  /** 速记浮窗全局快捷键（缺省 'ctrl+shift+n' 保持现状）：按下呼出速记浮窗，'off' = 不注册 */
  quickCaptureShortcut?: GlobalShortcutKey;
  /** 便签底部工具栏左区（编辑辅助区）按钮顺序：有序 id 列表，缺省 = 现状顺序。
   *  展示上限 8 个是展示约束（渲染层截取），不是存储约束；读写两侧都过
   *  sanitizeToolbarButtons（过滤未知 id/去重/缺项补末尾） */
  toolbarButtons?: string[];
}

/** 补齐缺省值后的高级设置选项（settings:get-advanced 的返回形态） */
export type ResolvedAdvancedSettings = Required<AdvancedSettings>;

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

/** 导出便签为图片的请求载荷（渲染→主进程 export:image）。
 *  html 为编辑器显示态 DOM 的 innerHTML（所见即所得：任务勾选态、图片协议 src） */
export interface ExportImagePayload {
  /** copy = 写系统剪贴板；save = 弹保存对话框写盘 */
  action: 'copy' | 'save';
  html: string;
  color: NoteColor;
  title: string;
  tags: string[];
}

/** 导出结果：canceled = 用户在保存对话框取消（不构成失败提示） */
export interface ExportImageResult {
  ok: boolean;
  error?: string;
  canceled?: boolean;
}

/** preload 暴露到 window.api 的接口契约（唯一 IPC 出口） */
export interface ElectronAPI {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  /** 打开/新建便签窗口；folder 仅新建时有效：首次保存落盘到该文件夹（notes/ 相对路径） */
  createNote(noteId?: string, folder?: string): Promise<void>;
  closeNote(noteId: string): Promise<void>;
  /** 查询当前窗口 DevTools 是否打开（速记窗失焦自动关闭的豁免判定） */
  isDevToolsOpen(): Promise<boolean>;
  setNotePin(noteId: string, pinned: boolean): Promise<void>;
  /** 折叠/展开便签窗口（窗口高度压到标题条/恢复记忆尺寸） */
  setNoteCollapsed(noteId: string, collapsed: boolean): Promise<void>;
  listWindows(): Promise<string[]>;
  showMainWindow(): Promise<void>;
  /** 便签角落拖拽缩放：开始时记录尺寸 */
  noteResizeBegin(noteId: string): Promise<void>;
  /** 便签角落拖拽缩放：按累计位移调整；edge='left' 时左缘拖拽、右缘锚定 */
  noteResize(noteId: string, dx: number, dy: number, edge?: 'left'): Promise<void>;
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
  /** 查询界面语言偏好与系统 locale（渲染层据此解析「跟随系统」） */
  getLanguage(): Promise<{ preference: string; systemLocale: string }>;
  /** 持久化界面语言偏好（'system' 或具体语言码） */
  setLanguage(lang: string): Promise<void>;
  /** 查询高级设置选项（整对象，缺省字段已由主进程补默认值） */
  getAdvanced(): Promise<ResolvedAdvancedSettings>;
  /** 按键部分更新高级设置选项（即改即存即生效），返回补齐后的完整对象 */
  setAdvanced(patch: AdvancedSettings): Promise<ResolvedAdvancedSettings>;
  /** 订阅界面语言切换广播（任一窗口改语言后，其他已开窗口即时跟进），返回取消订阅函数 */
  onLanguageChanged(cb: (lang: string) => void): () => void;
  /** 订阅高级设置变更广播（set-advanced 后向全部窗口广播补齐后的完整对象，
   *  便签窗口据此即时重排工具栏按钮），返回取消订阅函数 */
  onAdvancedChanged(cb: (advanced: ResolvedAdvancedSettings) => void): () => void;
  /** 查询 OS 深色模式事实（nativeTheme.shouldUseDarkColors） */
  getOsDark(): Promise<boolean>;
  /** 订阅 OS 深色模式变更广播（managerTheme='system' 时渲染层即时跟进），返回取消订阅函数 */
  onOsThemeChanged(cb: (osDark: boolean) => void): () => void;
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
  /** 导出便签为图片：copy 写剪贴板 / save 弹保存对话框写盘；
   *  主进程开隐藏离屏窗渲染，全程不触碰真实便签窗口几何 */
  exportNoteImage(payload: ExportImagePayload): Promise<ExportImageResult>;
  /** 订阅导出载荷下发（仅隐藏导出窗的 ExportView 使用），返回取消订阅函数 */
  onExportPayload(cb: (payload: ExportImagePayload) => void): () => void;
  /** 导出窗挂载握手：订阅就绪后上报，主进程据此下发 payload（每次握手重发一次） */
  exportViewReady(): void;
  /** 导出窗上报渲染就绪与内容高度（主进程据此 setContentSize 后截图） */
  exportReady(height: number): void;
}

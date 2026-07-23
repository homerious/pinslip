// 三进程共享的 IPC 频道名常量。禁止在代码里手写频道字符串。
export const IPC = {
  /** 获取运行时信息（Go 服务端口等） */
  RuntimeInfo: 'runtime:info',
  /** 新建/聚焦便签窗口，参数 noteId? */
  WindowCreate: 'window:create',
  /** 关闭指定便签窗口，参数 noteId */
  WindowClose: 'window:close',
  /** 查询调用方窗口的 DevTools 是否打开（速记窗失焦关闭的调试豁免用） */
  WindowDevToolsOpen: 'window:devtools-open',
  /** 切换便签置顶状态，参数 (noteId, pinned) */
  WindowSetPin: 'window:setPin',
  /** 折叠/展开便签窗口，参数 (noteId, collapsed) */
  NoteSetCollapsed: 'note:set-collapsed',
  /** 列出当前打开的便签窗口 */
  WindowList: 'window:list',
  /** 显示主窗口 */
  MainWindowShow: 'main-window:show',
  /** 便签拖拽缩放开始（主进程记录起始尺寸），参数 noteId */
  NoteResizeBegin: 'note:resize-begin',
  /** 便签拖拽缩放中，参数 (noteId, dx, dy)——相对起始位置的累计位移 */
  NoteResize: 'note:resize',
  /** 便签拖拽缩放结束（pointerup）：组内几何收敛挂点——自制缩放手柄不走
   *  OS 模态循环，WM_EXITSIZEMOVE 不触发，收敛只能挂这个通知上 */
  NoteResizeEnd: 'note:resize-end',
  /** 选择保险库目录（首次设置/后续更改），返回 { vaultPath, goPort } 或 null（取消） */
  SettingsChooseVault: 'settings:choose-vault',
  /** 在系统文件管理器中打开保险库目录 */
  SettingsOpenVault: 'settings:open-vault',
  /** 在系统文件管理器中打开回收区目录（<vault>/.trash，不存在则先创建） */
  SettingsOpenTrash: 'settings:open-trash',
  /** 在系统文件管理器中打开 notes/ 下指定子文件夹，参数 folder（相对路径） */
  NoteOpenFolder: 'note:open-folder',
  /** 查询开机自启状态 */
  SettingsGetAutoStart: 'settings:get-auto-start',
  /** 设置开机自启，参数 enabled */
  SettingsSetAutoStart: 'settings:set-auto-start',
  /** 查询界面语言：返回 { preference: 'system'|语言码, systemLocale: app.getLocale() } */
  SettingsGetLanguage: 'settings:get-language',
  /** 设置界面语言偏好，参数 lang（'system' 或 zh-CN/en/ja/ko/es/de/fr） */
  SettingsSetLanguage: 'settings:set-language',
  /** 界面语言切换广播（主进程→所有窗口）：参数为生效语言码，已开窗口即时跟进 */
  LanguageChanged: 'app:language-changed',
  /** 笔记数据变更（保存/删除/速记）：渲染进程→主进程→主窗口广播 */
  NotesChanged: 'notes:changed',
  /** 成组预告高亮（主进程→便签渲染层），参数 active: boolean */
  GroupHover: 'group:hover',
  /** 组态推送（主进程→便签渲染层：成组/退组/角色变化），参数 GroupState | null */
  GroupState: 'group:state',
  /** 查询便签当前组态（渲染层挂载时主动拉取），参数 noteId，返回 GroupState | null */
  GroupGetState: 'group:get-state',
  /** 整组拖动开始（组手柄 pointerdown），参数 noteId；随后主进程轮询光标跟随 */
  GroupDragBegin: 'group:drag-begin',
  /** 整组拖动结束（松手对组包围盒做屏幕边缘吸附），参数 noteId */
  GroupDragEnd: 'group:drag-end',
  /** 重命名组（组标签手柄双击改名），参数 (noteId, name)；空串 = 清除命名 */
  GroupRename: 'group:rename',
  /** 解散组（组手柄右键菜单），参数 noteId：全员退组、位置原地不动 */
  GroupDissolve: 'group:dissolve',
  /** 手动检查更新（设置页按钮触发） */
  UpdateCheck: 'update:check',
  /** 退出并安装已下载的更新 */
  UpdateInstall: 'update:install',
  /** 拉取当前更新状态（设置页打开时同步快照） */
  UpdateGetState: 'update:get-state',
  /** 更新状态广播（主进程→所有窗口）：checking/available/downloading/downloaded/latest/error */
  UpdateState: 'update:state',
  /** 用系统浏览器打开下载页（更新检查失败时的手动下载兜底） */
  UpdateOpenDownload: 'update:open-download',
} as const;

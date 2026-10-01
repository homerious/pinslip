import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import PlusIcon from '~icons/ph/plus';
import TrashIcon from '~icons/ph/trash';
import TrayIcon from '~icons/ph/tray';
import AppWindowIcon from '~icons/ph/app-window';
import NoteIcon from '~icons/ph/note';
import MoonIcon from '~icons/ph/moon';
import GearSixIcon from '~icons/ph/gear-six';
import PinIcon from '../components/icons/PinIcon';
import FolderIcon from '~icons/ph/folder';
import FolderOpenIcon from '~icons/ph/folder-open';
import FolderPlusIcon from '~icons/ph/folder-plus';
import FolderFillIcon from '~icons/ph/folder-fill';
import FolderOpenFillIcon from '~icons/ph/folder-open-fill';
import FoldersIcon from '~icons/ph/folders';
import PencilSimpleIcon from '~icons/ph/pencil-simple';
import TagIcon from '~icons/ph/tag';
import TagFillIcon from '~icons/ph/tag-fill';
import ArrowLeftIcon from '~icons/ph/arrow-left';
import ListBulletsIcon from '~icons/ph/list-bullets';
import PowerIcon from '~icons/ph/power';
import TimerIcon from '~icons/ph/timer';
import TranslateIcon from '~icons/ph/translate';
import CaretDownIcon from '~icons/ph/caret-down';
import CaretRightIcon from '~icons/ph/caret-right';
import SortAscendingIcon from '~icons/ph/sort-ascending';
import SortDescendingIcon from '~icons/ph/sort-descending';
import ArrowsClockwiseIcon from '~icons/ph/arrows-clockwise';
import ArrowSquareOutIcon from '~icons/ph/arrow-square-out';
import InfoIcon from '~icons/ph/info';
import GitBranchIcon from '~icons/ph/git-branch';
import LightningIcon from '~icons/ph/lightning';
import WarningIcon from '~icons/ph/warning';
import RobotIcon from '~icons/ph/robot';
import LinkIcon from '~icons/ph/link';
import GlobeIcon from '~icons/ph/globe';
import FileCodeIcon from '~icons/ph/file-code';
import CopyIcon from '~icons/ph/copy';
import CheckIcon from '~icons/ph/check';
import ClipboardIcon from '~icons/ph/clipboard';
import KeyboardIcon from '~icons/ph/keyboard';
import DotsSixVerticalIcon from '~icons/ph/dots-six-vertical';
import SlidersHorizontalIcon from '~icons/ph/sliders-horizontal';
import ArrowCounterClockwiseIcon from '~icons/ph/arrow-counter-clockwise';
import type {
  BlankNoteShortcut,
  NoteMeta,
  SaveSyncConfigInput,
  SearchHit,
  SyncStatus,
  UpdateState,
} from '@shared/types';
import { foldersApi, notesApi, settingsApi, trashApi } from '../api/notes';
import type { TrashStats } from '../api/notes';
import { syncApi } from '../api/sync';
import { apiErrorCode, apiErrorMessage } from '../api/client';
import { shortenFolder } from '../utils/path';
import { COLORS, readLastNoteColor } from '../utils/colors';
import { formatRelativeTime } from '../utils/time';
import { toCompactMarkdown } from '../utils/compact-markdown';
import { highlightTerms, windowAroundMatch } from '../components/search-highlight';
import {
  applyLanguagePreference,
  getLanguagePreference,
  LANGUAGE_NATIVE_NAMES,
  SUPPORTED_LANGUAGES,
  translateServerError,
} from '../i18n';
import type { LanguagePreference } from '../i18n';
import {
  sanitizeToolbarButtons,
  TOOLBAR_BUTTON_DEFAULT_ORDER,
  TOOLBAR_DISPLAY_LIMIT,
} from '@shared/toolbar';

/** 工具栏排序列表的按钮名 i18n key（复用 note.* tooltip 文案；缩放键带
 *  {{pct}} 插值不适配列表名，用 settings 节的平名） */
const TOOLBAR_BUTTON_LABEL_KEYS: Record<string, string> = {
  bold: 'note.tipBold',
  strike: 'note.tipStrike',
  task: 'note.tipTask',
  image: 'note.tipImage',
  zoomIn: 'settings.toolbarZoomIn',
  zoomOut: 'settings.toolbarZoomOut',
  table: 'note.table.insert',
  export: 'note.exportImage',
};

/** 紧凑时间格式：M/d HH:mm（窄面板下完整 locale 字符串放不下） */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 字节数人性化：B/KB/MB/GB 两档取整，回收区统计用（单位国际通用，不进语言包） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 相对时间格式化已迁至 utils/time.ts（便签窗口同步按钮也要用） */

type Stage = 'loading' | 'setup' | 'ready';

/** 更新状态 → 设置页提示文案（dev 环境固定提示不可检查） */
function updateHint(t: TFunction, state: UpdateState, isPackaged: boolean): string {
  if (!isPackaged) return t('update.hintDev');
  switch (state.status) {
    case 'idle':
      return t('update.hintIdle');
    case 'checking':
      return t('update.hintChecking');
    case 'available':
      return t('update.hintAvailable', { version: state.version });
    case 'downloading':
      return t('update.hintDownloading', { percent: state.percent });
    case 'downloaded':
      return t('update.hintDownloaded', { version: state.version });
    case 'latest':
      return t('update.hintLatest');
    case 'error':
      return t('update.hintError', { message: state.message });
  }
}

/** 主窗口视图：笔记列表 + 搜索（管理入口；日常新建走便签 ＋ / 托盘 / 快捷键）。
 *  首次使用先引导选择保险库（便签存储目录，Obsidian 式） */
export default function MainView() {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>('loading');
  const [vaultPath, setVaultPath] = useState('');
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  /** 与 hits 同源的高亮词快照（搜索返回时记录，避免防抖期内 query 已变、结果未变的错配） */
  const [hitTerms, setHitTerms] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isPackaged, setIsPackaged] = useState(false);
  const [version, setVersion] = useState('');
  /** 自动更新状态（主进程权威，这里只是镜像展示） */
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  const [autoStart, setAutoStart] = useState(false);
  /** 界面语言偏好（'system' = 跟随系统；初值取自 i18n 模块的启动解析结果） */
  const [langPref, setLangPref] = useState<LanguagePreference>(getLanguagePreference());
  // 回收区：统计快照 + 保留天数 + 清空两阶段确认态
  const [trashStats, setTrashStats] = useState<TrashStats | null>(null);
  const [trashRetention, setTrashRetention] = useState(30);
  const [emptyConfirm, setEmptyConfirm] = useState(false);
  /** 新建按钮的显示色：跟随上次用色（localStorage，六色白名单校验） */
  const [createColor, setCreateColor] = useState(
    () => COLORS.find((c) => c.key === readLastNoteColor()) ?? COLORS[0],
  );
  // git 同步：状态快照 + 编辑表单（token 不回显，留空=不修改）+ 交互态
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncForm, setSyncForm] = useState({ url: '', username: '', token: '', branch: 'main' });
  const [syncEditing, setSyncEditing] = useState(false);
  const [syncDisableConfirm, setSyncDisableConfirm] = useState(false);
  /** 分叉接管两阶段确认态：命中的策略（local/remote），3 秒未再点自动复位 */
  const [syncResolveConfirm, setSyncResolveConfirm] = useState<'local' | 'remote' | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncFormError, setSyncFormError] = useState('');
  /** 与 syncFormError 配套的服务端错误码：SYNC_LOCAL_NOT_PINSLIP_REPO 时显示「仍要接入此仓库」认领入口 */
  const [syncFormErrorCode, setSyncFormErrorCode] = useState('');
  /** 本地仓库认领两阶段确认态（参照 syncDisableConfirm 模式） */
  const [syncAdoptConfirm, setSyncAdoptConfirm] = useState(false);
  /** 「自动同步」间隔输入框（分钟）：受控文本，提交/回退时与服务端生效值对齐；
   *  dirty 标记防止 30s 轮询回填覆盖用户正在输入的内容 */
  const [syncIntervalInput, setSyncIntervalInput] = useState('10');
  const syncIntervalDirtyRef = useRef(false);
  // MCP 服务：Go 端口（拼接入地址）+ mcpEnabled 开关（缺省开）+ 复制反馈
  const [goPort, setGoPort] = useState(0);
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpCopied, setMcpCopied] = useState(false);
  // 速记：落点模式（note 逐条 / daily 聚合到当日便签）+ 剪贴板带入开关（缺省开）
  const [quickMode, setQuickMode] = useState<'note' | 'daily'>('note');
  const [quickClipboard, setQuickClipboard] = useState(true);
  // 高级设置：折叠区展开态（默认收起）+ 托盘/任务栏图标开关（缺省开）
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [trayIcon, setTrayIcon] = useState(true);
  const [taskbarIcon, setTaskbarIcon] = useState(true);
  /** 新便签落点（缺省 cascade 固定级联；beside-manager = 跟随主窗口） */
  const [notePlacement, setNotePlacement] = useState<'cascade' | 'beside-manager'>('cascade');
  /** 管理器主题偏好（缺省 light 浅色现状；system = 跟随 OS 深色模式）；
   *  仅主窗口+设置抽屉，便签/速记不受影响 */
  const [managerTheme, setManagerTheme] = useState<'light' | 'dark' | 'system'>('light');
  /** OS 深色模式事实（main 经 nativeTheme 提供）：managerTheme='system' 时合成生效主题 */
  const [osDark, setOsDark] = useState(false);
  /** 生效主题：偏好 'system' 时按 OS 深色事实合成，手动档即偏好本身 */
  const effectiveTheme: 'light' | 'dark' =
    managerTheme === 'system' ? (osDark ? 'dark' : 'light') : managerTheme;
  /** 空白便签全局快捷键（缺省 off 不注册）+ 注册失败提示态（新键被他应用占用时回滚选项） */
  const [blankNoteShortcut, setBlankNoteShortcut] = useState<BlankNoteShortcut>('off');
  const [blankNoteShortcutError, setBlankNoteShortcutError] = useState(false);
  /** 工具栏按钮自定义顺序（高级设置拖拽排序；缺省 = 现状顺序）。
   *  ref 与 state 同源：拖拽松手结算时读现值，避开闭包旧值 */
  const [toolbarButtons, setToolbarButtonsState] = useState<string[]>(() => [
    ...TOOLBAR_BUTTON_DEFAULT_ORDER,
  ]);
  const toolbarButtonsRef = useRef(toolbarButtons);
  /** 排序列表拖拽态：from = 按住行索引，insert = 插入位，y = 指示线相对列表顶部的 px */
  const [tbDrag, setTbDrag] = useState<{ from: number; insert: number; y: number } | null>(null);
  const tbListRef = useRef<HTMLUListElement>(null);
  /** 工具栏按钮顺序：state/ref 同步更新（拖拽结算读 ref 现值） */
  const setToolbarButtons = useCallback((next: string[]) => {
    toolbarButtonsRef.current = next;
    setToolbarButtonsState(next);
  }, []);
  /** 配置表单 dirty 标记：编辑中不被 30s 轮询回填覆盖；保存/取消/重开抽屉时复位 */
  const syncFormDirtyRef = useRef(false);
  // 三视图：列表（全部平铺）/ 文件夹（分层导航）/ 标签（按标签分组）
  const [view, setView] = useState<'list' | 'folders' | 'tags'>('list');
  // 文件夹导航：currentFolder 为 notes/ 相对路径（"" 根目录）
  const [currentFolder, setCurrentFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [moveTarget, setMoveTarget] = useState<NoteMeta | null>(null);
  /** 摘要预览手风琴：当前展开的便签 id（同时只展开一条，会话内瞬态不持久化） */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 列表项「复制全部」的 ✓ 反馈：最近复制成功的便签 id（1.2s 后复位） */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 移动弹层的路径筛选 */
  const [moveFilter, setMoveFilter] = useState('');
  // 列表视图排序：按更新/创建时间 × 升/倒序（默认更新倒序，与 API 顺序一致）
  const [sortKey, setSortKey] = useState<'updated' | 'created'>('updated');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  /** 标签视图分组的收起集合（tag 名；'__untagged__' = 无标签组），会话内记忆 */
  const [collapsedTags, setCollapsedTags] = useState<ReadonlySet<string>>(new Set());
  // 文件夹管理：行内重命名 / 删除确认（target 为 notes/ 相对路径）
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(null);
  // 面包屑中间段折叠状态（层级深时默认折叠，点 … 展开）
  const [crumbsExpanded, setCrumbsExpanded] = useState(false);

  // 标签聚合：全部笔记的标签按出现频次降序
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [notes]);

  // 标签视图分组：标签 → 该标签下的笔记；无标签笔记归入最后的「无标签」组
  const tagGroups = useMemo(() => {
    const groups = tagCounts.map(([tag, count]) => ({
      tag,
      count,
      notes: notes.filter((n) => n.tags?.includes(tag)),
    }));
    const untagged = notes.filter((n) => (n.tags ?? []).length === 0);
    return { groups, untagged };
  }, [notes, tagCounts]);

  // 当前层的直接子文件夹
  const childFolders = useMemo(() => {
    const prefix = currentFolder ? currentFolder + '/' : '';
    return folders.filter((f) => {
      if (currentFolder && !f.startsWith(prefix)) return false;
      const rest = currentFolder ? f.slice(prefix.length) : f;
      return rest !== '' && !rest.includes('/');
    });
  }, [folders, currentFolder]);

  // 移动弹层的路径筛选结果（大小写不敏感子串）
  const filteredMoveFolders = useMemo(() => {
    const q = moveFilter.trim().toLowerCase();
    return q ? folders.filter((f) => f.toLowerCase().includes(q)) : folders;
  }, [folders, moveFilter]);

  // 列表视图排序：ISO 时间字符串字典序即时间序
  const sortedNotes = useMemo(() => {
    const key = sortKey === 'created' ? 'createdAt' : 'updatedAt';
    return [...notes].sort((a, b) => {
      const cmp = a[key].localeCompare(b[key]);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [notes, sortKey, sortDir]);

  // 标签视图分组收起/展开切换
  const toggleTagGroup = useCallback((tag: string) => {
    setCollapsedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  // 当前层笔记：文件夹视图只显示本层；根层显示根目录笔记 + inbox 速记
  const layerNotes = useMemo(() => {
    if (currentFolder) return notes.filter((n) => !n.inbox && n.folder === currentFolder);
    return notes.filter((n) => n.inbox || !n.folder);
  }, [notes, currentFolder]);

  // 面包屑分段
  const crumbs = useMemo(() => {
    const segs = currentFolder ? currentFolder.split('/') : [];
    return segs.map((name, i) => ({ name, path: segs.slice(0, i + 1).join('/') }));
  }, [currentFolder]);

  const refresh = useCallback(() => {
    notesApi
      .list()
      .then((list) => {
        setNotes(list);
        setError('');
      })
      .catch((err) => setError(t('error.serviceDown', { message: err.message })));
    foldersApi
      .list()
      .then(setFolders)
      .catch(() => {});
  }, [t]);

  // 进入文件夹（折叠状态复位，深层目录默认收起中间段）
  const enterFolder = useCallback((path: string) => {
    setCurrentFolder(path);
    setCrumbsExpanded(false);
  }, []);

  // 新建文件夹（在当前层下）
  const createFolder = useCallback(() => {
    const name = newFolderName.trim().replace(/[\\/:*?"<>|]/g, '');
    if (!name) return;
    const path = currentFolder ? `${currentFolder}/${name}` : name;
    foldersApi
      .create(path)
      .then(() => {
        setNewFolderName('');
        setNewFolderOpen(false);
        refresh();
      })
      .catch(() => {});
  }, [newFolderName, currentFolder, refresh]);

  // 文件夹子树内的便签数（删除确认弹层用；move/trash 都作用整棵子树）
  const folderNoteCount = useCallback(
    (path: string) =>
      notes.filter((n) => !n.inbox && (n.folder === path || n.folder.startsWith(path + '/')))
        .length,
    [notes],
  );

  // 提交行内重命名：同级改名；当前浏览路径落在被改名子树内时同步前缀
  const submitRename = useCallback(() => {
    if (!renamingFolder) return;
    const oldName = renamingFolder.split('/').pop() ?? '';
    const name = renameValue.trim().replace(/[\\/:*?"<>|]/g, '');
    setRenamingFolder(null);
    if (!name || name === oldName) return;
    foldersApi
      .rename(renamingFolder, name)
      .then(() => {
        const newPrefix = renamingFolder.includes('/')
          ? renamingFolder.slice(0, renamingFolder.lastIndexOf('/') + 1) + name
          : name;
        if (currentFolder === renamingFolder || currentFolder.startsWith(renamingFolder + '/')) {
          setCurrentFolder(newPrefix + currentFolder.slice(renamingFolder.length));
        }
        refresh();
      })
      .catch(() => {});
  }, [renamingFolder, renameValue, currentFolder, refresh]);

  // 删除文件夹：move=便签上移根目录后删空目录；trash=整树移入 .trash 后悔药。
  // 当前浏览路径在被删子树内时退回父级。
  const deleteFolder = useCallback(
    (path: string, mode: 'move' | 'trash') => {
      // trash 模式整树进回收区：先记下受影响便签，删除成功后关掉它们开着的
      // 窗口（move 模式便签只上移根目录、id 不变，窗口保留）
      const affected =
        mode === 'trash'
          ? notes.filter((n) => !n.inbox && (n.folder === path || n.folder.startsWith(path + '/')))
          : [];
      foldersApi
        .remove(path, mode)
        .then(() => {
          setDeleteFolderTarget(null);
          for (const n of affected) window.api.closeNote(n.id);
          if (currentFolder === path || currentFolder.startsWith(path + '/')) {
            enterFolder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
          }
          window.api.notifyNotesChanged();
          refresh();
        })
        .catch(() => {});
    },
    [notes, currentFolder, enterFolder, refresh],
  );

  // 移动笔记到文件夹
  const moveNoteTo = useCallback(
    (folder: string) => {
      if (!moveTarget) return;
      notesApi
        .move(moveTarget.id, folder)
        .then(() => {
          setMoveTarget(null);
          window.api.notifyNotesChanged();
          refresh();
        })
        .catch(() => {});
    },
    [moveTarget, refresh],
  );

  // 启动检查保险库：已设置 → 列表模式；未设置 → 引导选择
  useEffect(() => {
    window.api
      .getRuntimeInfo()
      .then((info) => {
        setIsPackaged(info.isPackaged);
        setVersion(info.version);
        setGoPort(info.goPort);
        if (info.vaultPath) {
          setVaultPath(info.vaultPath);
          setStage('ready');
        } else {
          setStage('setup');
        }
      })
      .catch(() => setStage('setup'));
  }, []);

  // 新建按钮色跟随上次用色：便签窗口换色写 localStorage——storage 事件
  // 跨窗口同步（同源分区），focus 兜底（同窗口读写不触发 storage）
  useEffect(() => {
    const sync = () =>
      setCreateColor(COLORS.find((c) => c.key === readLastNoteColor()) ?? COLORS[0]);
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  // 更新状态：挂载时拉一次快照（可能已有后台检查结果），之后跟随主进程广播
  useEffect(() => {
    window.api
      .getUpdateState()
      .then(setUpdateState)
      .catch(() => {});
    return window.api.onUpdateState(setUpdateState);
  }, []);

  // 列表加载 + 窗口聚焦时刷新 + 笔记变更广播时刷新（便签编辑/删除/速记近实时同步）
  useEffect(() => {
    if (stage !== 'ready') return;
    refresh();
    window.addEventListener('focus', refresh);
    const offNotesChanged = window.api.onNotesChanged(refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      offNotesChanged();
    };
  }, [stage, refresh]);

  // 搜索防抖
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      setHitTerms([]);
      return;
    }
    const timer = setTimeout(() => {
      const q = query.trim();
      notesApi
        .search(q)
        .then((h) => {
          setHits(h);
          setHitTerms(q.split(/\s+/).filter(Boolean));
        })
        .catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // 移动弹层开关时清空路径筛选（每次打开回到全量列表）
  useEffect(() => {
    setMoveFilter('');
  }, [moveTarget]);

  // 挂载即读高级设置：主题要在首帧就位（无「先浅色一闪再变深」窗口期），
  // 托盘/任务栏图标、新便签落点与主题同一次 getAdvanced 调用
  useEffect(() => {
    window.api
      .getAdvanced()
      .then((a) => {
        setTrayIcon(a.trayIcon);
        setTaskbarIcon(a.taskbarIcon);
        setNotePlacement(a.notePlacement);
        setManagerTheme(a.managerTheme);
        setBlankNoteShortcut(a.blankNoteShortcut);
        setToolbarButtons(sanitizeToolbarButtons(a.toolbarButtons));
      })
      .catch(() => {});
  }, [setToolbarButtons]);

  // OS 深色模式事实：挂载读取一次 + 订阅 main 的 nativeTheme 变更广播
  // （managerTheme='system' 时即时跟进，无需重启）
  useEffect(() => {
    window.api
      .getOsDark()
      .then(setOsDark)
      .catch(() => {});
    return window.api.onOsThemeChanged(setOsDark);
  }, []);

  // 打开设置抽屉时同步开机自启状态（仅打包环境为真实值）+ 回收区统计与保留天数
  useEffect(() => {
    if (!settingsOpen) return;
    setEmptyConfirm(false);
    window.api
      .getAutoStart()
      .then(setAutoStart)
      .catch(() => {});
    window.api
      .getAdvanced()
      .then((a) => {
        setTrayIcon(a.trayIcon);
        setTaskbarIcon(a.taskbarIcon);
        setNotePlacement(a.notePlacement);
        setManagerTheme(a.managerTheme);
        setBlankNoteShortcut(a.blankNoteShortcut);
        setToolbarButtons(sanitizeToolbarButtons(a.toolbarButtons));
      })
      .catch(() => {});
    trashApi
      .stats()
      .then(setTrashStats)
      .catch(() => setTrashStats(null));
    settingsApi
      .get()
      .then((s) => {
        setTrashRetention(s.trashRetentionDays);
        setMcpEnabled(s.mcpEnabled ?? true); // 字段缺失 = 缺省开启
        setQuickMode(s.quickCaptureMode === 'daily' ? 'daily' : 'note');
        setQuickClipboard(s.quickCaptureClipboard ?? true); // 字段缺失 = 缺省开启
      })
      .catch(() => {});
  }, [settingsOpen]);

  // git 同步状态：抽屉打开时拉一次并重置交互态；打开期间每 30s 轮询，关闭即停
  useEffect(() => {
    if (!settingsOpen) return;
    setSyncEditing(false);
    setSyncDisableConfirm(false);
    setSyncResolveConfirm(null);
    setSyncFormError('');
    syncFormDirtyRef.current = false;
    const load = () =>
      syncApi
        .getStatus()
        .then((st) => {
          setSyncStatus(st);
          // 轮询回填不覆盖正在输入的间隔草稿
          setSyncIntervalInput((cur) =>
            syncIntervalDirtyRef.current ? cur : String(st.pushIntervalMin ?? 10),
          );
          // 表单回填（token 不回显：永不进状态与表单初值）；编辑中不覆盖用户草稿
          if (st.configured && !syncFormDirtyRef.current) {
            setSyncForm({
              url: st.url ?? '',
              username: st.username ?? '',
              token: '',
              branch: st.branch || 'main',
            });
          }
        })
        .catch(() => setSyncStatus(null));
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [settingsOpen]);

  // 停用两阶段确认：3 秒内未再点自动复位（同清空回收区套路）
  useEffect(() => {
    if (!syncDisableConfirm) return;
    const timer = setTimeout(() => setSyncDisableConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [syncDisableConfirm]);

  // 分叉接管两阶段确认：3 秒内未再点自动复位（同停用套路）
  useEffect(() => {
    if (!syncResolveConfirm) return;
    const timer = setTimeout(() => setSyncResolveConfirm(null), 3000);
    return () => clearTimeout(timer);
  }, [syncResolveConfirm]);

  // 清空回收区：两阶段确认（第一次点击进入确认态，3 秒内再点执行，超时复位）
  useEffect(() => {
    if (!emptyConfirm) return;
    const timer = setTimeout(() => setEmptyConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [emptyConfirm]);

  const emptyTrash = useCallback(() => {
    if (!emptyConfirm) {
      setEmptyConfirm(true);
      return;
    }
    setEmptyConfirm(false);
    trashApi
      .empty()
      .then(() => trashApi.stats())
      .then(setTrashStats)
      .catch(() => {});
  }, [emptyConfirm]);

  // 修改回收区保留天数：即选即存（vault 的 .pinslip/settings.json）
  const changeTrashRetention = useCallback((days: number) => {
    setTrashRetention(days);
    settingsApi.update({ trashRetentionDays: days }).catch(() => {});
  }, []);

  // MCP 总开关：乐观切换，失败回滚。
  // PUT 必须带上 trashRetentionDays 现值——Go 侧是整体写入（只发 mcpEnabled
  // 会把回收区天数抹成 0）；反向同理（changeTrashRetention 不带 mcpEnabled 时
  // Go 侧保留现值，不会互相覆盖）
  const toggleMcp = useCallback(() => {
    const next = !mcpEnabled;
    setMcpEnabled(next);
    settingsApi
      .update({ trashRetentionDays: trashRetention, mcpEnabled: next })
      .catch(() => setMcpEnabled(!next));
  }, [mcpEnabled, trashRetention]);

  // 速记设置：落点模式 / 剪贴板带入。PUT 四字段全带（Go 侧整体写入，
  // trashRetentionDays 缺了会被抹成 0；其余字段虽有 nil 合并兜底，统一全带最稳）
  const changeQuickMode = useCallback(
    (mode: 'note' | 'daily') => {
      setQuickMode(mode);
      settingsApi
        .update({
          trashRetentionDays: trashRetention,
          mcpEnabled,
          quickCaptureMode: mode,
          quickCaptureClipboard: quickClipboard,
        })
        .catch(() => setQuickMode(quickMode));
    },
    [trashRetention, mcpEnabled, quickClipboard, quickMode],
  );

  const toggleQuickClipboard = useCallback(() => {
    const next = !quickClipboard;
    setQuickClipboard(next);
    settingsApi
      .update({
        trashRetentionDays: trashRetention,
        mcpEnabled,
        quickCaptureMode: quickMode,
        quickCaptureClipboard: next,
      })
      .catch(() => setQuickClipboard(!next));
  }, [trashRetention, mcpEnabled, quickMode, quickClipboard]);

  // 托盘图标开关（高级设置）：乐观切换，失败回滚；主进程 set 时立即销毁/重建托盘
  const toggleTrayIcon = useCallback(() => {
    const next = !trayIcon;
    setTrayIcon(next);
    window.api.setAdvanced({ trayIcon: next }).catch(() => setTrayIcon(!next));
  }, [trayIcon]);

  // 任务栏图标开关（高级设置）：乐观切换，失败回滚；主进程 set 时对主窗口
  // setSkipTaskbar 立即生效（仅主窗口，便签任务栏入口不受影响）
  const toggleTaskbarIcon = useCallback(() => {
    const next = !taskbarIcon;
    setTaskbarIcon(next);
    window.api.setAdvanced({ taskbarIcon: next }).catch(() => setTaskbarIcon(!next));
  }, [taskbarIcon]);

  // 新便签落点（高级设置）：乐观切换，失败回滚旧值
  const changeNotePlacement = useCallback(
    (next: 'cascade' | 'beside-manager') => {
      const prev = notePlacement;
      setNotePlacement(next);
      window.api.setAdvanced({ notePlacement: next }).catch(() => setNotePlacement(prev));
    },
    [notePlacement],
  );

  // 管理器主题（高级设置）：乐观切换即改 data-theme，失败回滚旧值
  const changeManagerTheme = useCallback(
    (next: 'light' | 'dark' | 'system') => {
      const prev = managerTheme;
      setManagerTheme(next);
      window.api.setAdvanced({ managerTheme: next }).catch(() => setManagerTheme(prev));
    },
    [managerTheme],
  );

  // 空白便签快捷键（高级设置）：乐观切换；注册失败（新键被他应用占用）时
  // main 抛错——回滚选项并提示（设置未持久化、旧绑定保持有效）
  const changeBlankNoteShortcut = useCallback(
    (next: BlankNoteShortcut) => {
      const prev = blankNoteShortcut;
      setBlankNoteShortcut(next);
      setBlankNoteShortcutError(false);
      window.api.setAdvanced({ blankNoteShortcut: next }).catch(() => {
        setBlankNoteShortcut(prev);
        setBlankNoteShortcutError(true);
      });
    },
    [blankNoteShortcut],
  );

  // 界面语言切换：乐观更新，立即生效（i18n.changeLanguage）并持久化到主进程设置
  const changeLanguage = useCallback((pref: LanguagePreference) => {
    setLangPref(pref);
    void applyLanguagePreference(pref);
  }, []);

  /** 拖拽排序落定：把 from 行移到插入位（insert 按含被拖行的列表坐标系，
   *  越过自身时 -1 校正）；乐观更新，持久化失败回滚。主进程 set-advanced
   *  广播后，开着的便签窗口即时重排 */
  const commitToolbarOrder = useCallback(
    (from: number, insert: number) => {
      const cur = toolbarButtonsRef.current;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return;
      let to = insert > from ? insert - 1 : insert;
      to = Math.max(0, Math.min(next.length, to));
      if (to === from) return; // 原位 = no-op
      next.splice(to, 0, moved);
      setToolbarButtons(next);
      window.api.setAdvanced({ toolbarButtons: next }).catch(() => setToolbarButtons(cur));
    },
    [setToolbarButtons],
  );

  /** 恢复默认顺序（乐观更新，失败回滚） */
  const resetToolbarButtons = useCallback(() => {
    const prev = toolbarButtonsRef.current;
    const next = [...TOOLBAR_BUTTON_DEFAULT_ORDER];
    setToolbarButtons(next);
    window.api.setAdvanced({ toolbarButtons: next }).catch(() => setToolbarButtons(prev));
  }, [setToolbarButtons]);

  /** 排序列表手柄 pointerdown：指针驱动拖拽（便签组同款模式——不用 HTML5 DnD），
   *  move 追踪插入位并画指示线，松手落定提交。指示线 y 在 move 时按当前行
   *  矩形算好（拖拽期列表不重排，布局稳定） */
  const startToolbarDrag = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, from: number) => {
      if (e.button !== 0) return; // 只响应左键
      e.preventDefault();
      const list = tbListRef.current;
      if (!list) return;
      // 插入位放闭包局部变量：松手结算直接读，不经过 setState updater
      // （updater 须纯，StrictMode 双跑会把移动应用两次）
      let insert = from;
      setTbDrag({ from, insert, y: 0 });
      const onMove = (ev: PointerEvent) => {
        const rows = Array.from(list.querySelectorAll<HTMLElement>('.settings-sortlist__row'));
        const listRect = list.getBoundingClientRect();
        let y = listRect.height;
        insert = rows.length;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            insert = i;
            y = r.top - listRect.top;
            break;
          }
        }
        const ins = insert;
        setTbDrag((cur) => (cur && cur.insert === ins ? cur : { from, insert: ins, y }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setTbDrag(null);
        commitToolbarOrder(from, insert);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [commitToolbarOrder],
  );

  // 复制 MCP 接入配置（通用 mcpServers 形态，Claude Code / Kimi 等可直接粘贴）；
  // 成功后按钮短暂显示「已复制 ✓」（2s 恢复，与便签复制按钮同套路）
  const copyMcpConfig = useCallback(() => {
    const config = JSON.stringify({
      mcpServers: { pinslip: { type: 'http', url: `http://127.0.0.1:${goPort}/mcp` } },
    });
    void navigator.clipboard
      .writeText(config)
      .then(() => {
        setMcpCopied(true);
        setTimeout(() => setMcpCopied(false), 2000);
      })
      .catch(() => {});
  }, [goPort]);

  // 保存 git 同步配置（含首次接入；接入失败原因进表单错误区）
  const saveSyncConfig = useCallback(() => {
    const url = syncForm.url.trim();
    if (!url || syncBusy) return;
    setSyncBusy(true);
    setSyncFormError('');
    setSyncFormErrorCode('');
    setSyncAdoptConfirm(false);
    syncApi
      .saveConfig({
        url,
        username: syncForm.username.trim(),
        token: syncForm.token, // 空串 = 不修改已存 token（Go 侧语义）
        branch: syncForm.branch.trim() || 'main',
        enabled: true,
      })
      .then((st) => {
        setSyncStatus(st);
        setSyncEditing(false);
        syncFormDirtyRef.current = false;
        setSyncForm((f) => ({ ...f, token: '' })); // token 不留内存态
      })
      .catch((err) => {
        setSyncFormError(translateServerError(t, apiErrorCode(err), apiErrorMessage(err)));
        setSyncFormErrorCode(apiErrorCode(err) ?? '');
      })
      .finally(() => setSyncBusy(false));
  }, [syncForm, syncBusy, t]);

  // 本地仓库认领：守卫报 SYNC_LOCAL_NOT_PINSLIP_REPO（vault 已是 git 仓库但缺
  // .pinslip-repo 标记）且用户两阶段确认后，重发配置带 adopt:true——服务端创建
  // 标记并提交（现有未提交变更一并入库，提示文案已声明）。编辑态用表单值；
  // 状态态（错误来自状态轮询）用服务端生效值 + 空 token（不修改已存凭证）
  const adoptLocalRepo = useCallback(() => {
    if (syncBusy) return;
    if (!syncAdoptConfirm) {
      setSyncAdoptConfirm(true);
      return;
    }
    setSyncAdoptConfirm(false);
    setSyncBusy(true);
    setSyncFormError('');
    setSyncFormErrorCode('');
    const input: SaveSyncConfigInput = syncEditing
      ? {
          url: syncForm.url.trim(),
          username: syncForm.username.trim(),
          token: syncForm.token,
          branch: syncForm.branch.trim() || 'main',
          enabled: true,
          adopt: true,
        }
      : {
          url: syncStatus?.url ?? syncForm.url.trim(),
          username: syncStatus?.username ?? syncForm.username.trim(),
          token: '', // 空串 = 不修改已存 token
          branch: syncStatus?.branch || syncForm.branch.trim() || 'main',
          enabled: true,
          adopt: true,
        };
    syncApi
      .saveConfig(input)
      .then((st) => {
        setSyncStatus(st);
        setSyncEditing(false);
        syncFormDirtyRef.current = false;
        setSyncForm((f) => ({ ...f, token: '' }));
      })
      .catch((err) => {
        if (syncEditing) {
          setSyncFormError(translateServerError(t, apiErrorCode(err), apiErrorMessage(err)));
          setSyncFormErrorCode(apiErrorCode(err) ?? '');
        }
      })
      .finally(() => {
        setSyncBusy(false);
        // 状态态失败时错误体现在 lastError：拉一次状态立即对齐（不必等 30s 轮询）
        if (!syncEditing) {
          syncApi
            .getStatus()
            .then(setSyncStatus)
            .catch(() => {});
        }
      });
  }, [syncBusy, syncAdoptConfirm, syncEditing, syncForm, syncStatus, t]);

  // 立即同步一轮（syncNow 不抛错，结果全在返回状态里）
  const doSyncNow = useCallback(() => {
    if (syncBusy) return;
    setSyncBusy(true);
    syncApi
      .syncNow()
      .then(setSyncStatus)
      .catch(() => {})
      .finally(() => setSyncBusy(false));
  }, [syncBusy]);

  // 提交「自动同步」间隔（失焦/Enter）：非法值回退当前生效值；合法值即改即存——
  // 复用 PUT /api/sync/config（token 空串 = 不修改），Go 侧 Reconfigure 停旧循环
  // 起新循环，新间隔立即生效，无需重启服务
  const commitSyncInterval = useCallback(() => {
    syncIntervalDirtyRef.current = false;
    const current = syncStatus?.pushIntervalMin ?? 10;
    const n = Number(syncIntervalInput);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      setSyncIntervalInput(String(current)); // 非法输入回退生效值
      return;
    }
    if (n === current) {
      setSyncIntervalInput(String(current)); // 规整显示（如 "010" → "10"）
      return;
    }
    if (syncBusy) return;
    setSyncBusy(true);
    syncApi
      .saveConfig({
        url: syncStatus?.url ?? syncForm.url.trim(),
        username: syncStatus?.username ?? syncForm.username.trim(),
        token: '', // 空串 = 不修改已存 token
        branch: syncStatus?.branch || syncForm.branch.trim() || 'main',
        enabled: true,
        pushIntervalMin: n,
      })
      // PUT 失败（多为接入失败）：Go 侧配置已先落盘，拉一次状态对齐真实生效值
      .catch(() => syncApi.getStatus())
      .then((st) => {
        setSyncStatus(st);
        setSyncIntervalInput(String(st.pushIntervalMin ?? current));
      })
      .catch(() => setSyncIntervalInput(String(current)))
      .finally(() => setSyncBusy(false));
  }, [syncIntervalInput, syncStatus, syncForm, syncBusy]);

  // 「有变更时自动同步」开关（状态态）：乐观切换，失败回滚。即改即存复用
  // PUT /api/sync/config（url/username/branch 用服务端生效值，token 空串 =
  // 不修改已存凭证，enabled 保持）；Go 侧 Reconfigure 停旧循环起新循环即时生效
  const toggleSyncOnChange = useCallback(() => {
    if (!syncStatus || syncBusy) return;
    const next = !syncStatus.syncOnChange;
    setSyncStatus({ ...syncStatus, syncOnChange: next });
    setSyncBusy(true);
    syncApi
      .saveConfig({
        url: syncStatus.url ?? '',
        username: syncStatus.username ?? '',
        token: '', // 空串 = 不修改已存 token
        branch: syncStatus.branch || 'main',
        enabled: syncStatus.enabled,
        syncOnChange: next,
      })
      .then(setSyncStatus)
      // PUT 失败（多为接入失败）：Go 侧配置已先落盘，拉一次状态对齐真实生效值
      .catch(() =>
        syncApi
          .getStatus()
          .then(setSyncStatus)
          .catch(() => setSyncStatus((st) => (st ? { ...st, syncOnChange: !next } : st))),
      )
      .finally(() => setSyncBusy(false));
  }, [syncStatus, syncBusy]);

  // 停用同步：两阶段确认；保留 .git 与已存凭证
  const disableSync = useCallback(() => {
    if (!syncDisableConfirm) {
      setSyncDisableConfirm(true);
      return;
    }
    setSyncDisableConfirm(false);
    setSyncBusy(true);
    syncApi
      .disable()
      .then(() => syncApi.getStatus())
      .then(setSyncStatus)
      .catch(() => {})
      .finally(() => setSyncBusy(false));
  }, [syncDisableConfirm]);

  // 分叉接管：两阶段确认（确认文案写明各自代价）。执行失败不抛错——
  // 错误体现在返回状态的 lastError；前置校验被拒（400）时拉一次状态对齐
  const resolveDivergence = useCallback(
    (strategy: 'local' | 'remote') => {
      if (syncBusy) return;
      if (syncResolveConfirm !== strategy) {
        setSyncResolveConfirm(strategy);
        return;
      }
      setSyncResolveConfirm(null);
      setSyncBusy(true);
      syncApi
        .resolve(strategy)
        .then(setSyncStatus)
        .catch(() =>
          syncApi
            .getStatus()
            .then(setSyncStatus)
            .catch(() => {}),
        )
        .finally(() => setSyncBusy(false));
    },
    [syncBusy, syncResolveConfirm],
  );

  // 选择/更换保险库：主进程弹目录选择框，成功后重启服务，刷新本窗口
  const chooseVault = useCallback(() => {
    window.api
      .chooseVault()
      .then((res) => {
        if (res) window.location.reload();
      })
      .catch(() => {});
  }, []);

  const openNote = (id: string) => window.api.createNote(id);
  const createNote = () => window.api.createNote();

  /** 列表项「复制全部」：拉全文 → 紧凑 markdown（语法保留、折叠块分隔空行、
   *  保留有意空行，与便签复制/Ctrl+C 同口径）→ 写剪贴板；✓ 反馈 1.2s */
  const copyAllNote = useCallback((note: NoteMeta) => {
    notesApi
      .get(note.id)
      .then((full) => navigator.clipboard.writeText(toCompactMarkdown(full.content)))
      .then(() => {
        setCopiedId(note.id);
        setTimeout(() => setCopiedId((cur) => (cur === note.id ? null : cur)), 1200);
      })
      .catch(() => {});
  }, []);

  const removeNote = (id: string) => {
    notesApi
      .remove(id)
      .then(() => {
        // 关开窗着的便签窗口：文件已进回收区，窗口留着不仅幽灵存在，
        // 下次自动保存还会把文件写回来（删除失效）
        window.api.closeNote(id);
        refresh();
      })
      .catch(() => {});
  };

  // 空列表提示：强制两行排版——窄面板里自然换行会把「新建便签」拦腰折断
  const emptyNoteHint = (
    <>
      {t('note.emptyLine1')}
      <br />
      {t('note.emptyLine2')}
    </>
  );

  // 便签列表项（三视图共用）：颜色卡 + 标题/摘要预览/时间/标签 + 打开/打开目录/移动/删除按钮。
  // 交互反转（add-list-note-preview）：单击切换摘要 3 行 ↔ 10 行（手风琴），
  // 打开便签走双击 / 中键 / 右侧「打开」按钮；无摘要（空白便签）时单击回退打开。
  // showFolder：列表视图平铺全部便签，需要标注所在文件夹。
  const renderNoteItem = (note: NoteMeta, showFolder = false) => (
    <li
      key={note.id}
      className="note-list__note"
      data-color={note.color || 'yellow'}
      onClick={(e) => {
        // e.detail > 1 是双击的第二次 click，交给 onDoubleClick 处理
        if (e.detail > 1) return;
        // 拖选文本后也算一次 click——用户只是想选中，不触发展开
        if (window.getSelection()?.toString()) return;
        if (!note.excerpt) {
          openNote(note.id);
          return;
        }
        setExpandedId((cur) => (cur === note.id ? null : note.id));
      }}
      onDoubleClick={() => openNote(note.id)}
      onAuxClick={(e) => {
        // 中键打开；点在按钮上让按钮自己处理（保持既有按钮行为不受中键影响）
        if (e.button !== 1 || (e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        openNote(note.id);
      }}
    >
      <span className="note-list__title">
        {note.inbox && <TrayIcon className="note-list__inbox" />}
        {note.pin && <PinIcon className="note-list__pin" />}
        {/* 文本独立 span：flex 容器的 text-overflow 对匿名文本不可靠，
            省略号要落在自己的 min-width:0 盒子里；hover 用原生 title 展示全名 */}
        <span className="note-list__title-text" title={note.title}>
          {note.title}
        </span>
      </span>
      {/* 摘要预览：折叠 line-clamp 3 行，展开 10 行（内容不足按实际显示）；空白便签不渲染 */}
      {note.excerpt && (
        <span className={`note-list__preview${expandedId === note.id ? ' is-expanded' : ''}`}>
          {note.excerpt}
        </span>
      )}
      <span className="note-list__meta">
        {formatTime(note.updatedAt)} · {t('note.words', { count: note.wordCount })}
        {showFolder && note.folder && !note.inbox && (
          <span className="note-list__folder" title={note.folder}>
            <FolderFillIcon />
            {shortenFolder(note.folder)}
          </span>
        )}
      </span>
      {/* 标签独立一行，与时间行分开，清晰可读；冲突标识优先于标签（没有标签也要显示） */}
      {(note.tags ?? []).length > 0 || note.conflicted ? (
        <span className="note-list__badges">
          {note.conflicted && (
            <span className="note-list__conflict" title={t('note.conflictTip')}>
              <WarningIcon />
              {t('note.conflict')}
            </span>
          )}
          {(note.tags ?? []).slice(0, 2).map((tag) => (
            <span key={tag} className="note-list__tag">
              <TagFillIcon />
              {tag}
            </span>
          ))}
          {(note.tags ?? []).length > 2 && (
            <span className="note-list__tag">+{note.tags!.length - 2}</span>
          )}
        </span>
      ) : null}
      <button
        className="note-list__copy-all"
        title={copiedId === note.id ? t('note.copied') : t('note.copyAll')}
        onClick={(e) => {
          e.stopPropagation();
          copyAllNote(note);
        }}
      >
        {copiedId === note.id ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        className="note-list__open-note"
        title={t('note.openNote')}
        onClick={(e) => {
          e.stopPropagation();
          openNote(note.id);
        }}
      >
        <ArrowSquareOutIcon />
      </button>
      {!note.inbox && (
        <button
          className="note-list__open"
          title={t('note.openFolder')}
          onClick={(e) => {
            e.stopPropagation();
            void window.api.openNoteFolder(note.folder ?? '');
          }}
        >
          <FolderOpenFillIcon />
        </button>
      )}
      <button
        className="note-list__move"
        title={t('note.move')}
        onClick={(e) => {
          e.stopPropagation();
          setMoveTarget(note);
        }}
      >
        <FoldersIcon />
      </button>
      <button
        className="note-list__delete"
        title={t('note.delete')}
        onClick={(e) => {
          e.stopPropagation();
          removeNote(note.id);
        }}
      >
        <TrashIcon />
      </button>
    </li>
  );

  if (stage === 'loading') {
    return <div className="main-view vault-setup" data-theme={effectiveTheme} />;
  }

  // 首次使用：选择保险库
  if (stage === 'setup') {
    return (
      <div className="main-view vault-setup" data-theme={effectiveTheme}>
        <h1 className="vault-setup__title">PinSlip</h1>
        <FolderIcon className="vault-setup__icon" />
        <p className="vault-setup__text">{t('setup.text')}</p>
        <button className="vault-setup__btn" onClick={chooseVault}>
          {t('setup.button')}
        </button>
        <p className="vault-setup__hint">{t('setup.hint')}</p>
      </div>
    );
  }

  return (
    <div className="main-view" data-theme={effectiveTheme}>
      <header className="main-view__header">
        <h1>PinSlip</h1>
        <div className="main-view__actions">
          {/* 底色跟随上次用色（storage 事件/focus 同步），文字保持固定深棕
              （#5d4037 在六个浅色底上都清晰，绑色板 ink 会同色系低对比） */}
          <button
            className="main-view__create"
            style={{ background: createColor.dot }}
            onClick={createNote}
          >
            <PlusIcon /> {t('header.create')}
          </button>
          <button
            className="main-view__settings"
            title={t('header.settings')}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <GearSixIcon />
          </button>
        </div>
      </header>

      {/* 设置抽屉：从下往上滑出、遮住主界面（后续功能往这里加） */}
      {settingsOpen && (
        <>
          <button
            className="settings-drawer-backdrop"
            aria-label={t('settings.close')}
            onClick={() => setSettingsOpen(false)}
          />
          <div className="settings-drawer">
            <header className="settings-drawer__header">
              <button
                className="settings-drawer__close"
                title={t('settings.back')}
                onClick={() => setSettingsOpen(false)}
              >
                <ArrowLeftIcon />
              </button>
              <h2 className="settings-drawer__title">{t('settings.title')}</h2>
              <span className="settings-drawer__header-spacer" />
            </header>

            <div className="settings-panel__section">{t('settings.general')}</div>
            <div className="settings-card settings-card--spaced">
              <div className="settings-panel__row">
                <TranslateIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.language')}</span>
                <select
                  className="settings-panel__select"
                  value={langPref}
                  onChange={(e) => changeLanguage(e.target.value as LanguagePreference)}
                >
                  <option value="system">{t('settings.languageSystem')}</option>
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {LANGUAGE_NATIVE_NAMES[lang]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-panel__row">
                <PowerIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.autoStart')}</span>
                <button
                  className="settings-toggle"
                  role="switch"
                  aria-checked={autoStart}
                  data-on={autoStart}
                  disabled={!isPackaged}
                  title={
                    isPackaged ? t('settings.autoStartTip') : t('settings.autoStartPackagedOnly')
                  }
                  onClick={() => {
                    const next = !autoStart;
                    setAutoStart(next);
                    window.api.setAutoStart(next).catch(() => setAutoStart(!next));
                  }}
                >
                  <span className="settings-toggle__thumb" />
                </button>
              </div>
              {!isPackaged && (
                <div className="settings-panel__hint">{t('settings.autoStartDevHint')}</div>
              )}
            </div>

            <div className="settings-panel__section">{t('settings.quick')}</div>
            <div className="settings-card settings-card--spaced">
              <div className="settings-panel__row">
                <PencilSimpleIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.quickTarget')}</span>
                <select
                  className="settings-panel__select"
                  value={quickMode}
                  onChange={(e) => changeQuickMode(e.target.value as 'note' | 'daily')}
                >
                  <option value="note">{t('settings.quickTargetNote')}</option>
                  <option value="daily">{t('settings.quickTargetDaily')}</option>
                </select>
              </div>
              <div className="settings-panel__row">
                <ClipboardIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.quickClipboard')}</span>
                <button
                  className="settings-toggle"
                  role="switch"
                  aria-checked={quickClipboard}
                  data-on={quickClipboard}
                  title={t('settings.quickClipboardTip')}
                  onClick={toggleQuickClipboard}
                >
                  <span className="settings-toggle__thumb" />
                </button>
              </div>
              <div className="settings-panel__hint">{t('settings.quickHint')}</div>
            </div>

            <div className="settings-panel__section">{t('settings.data')}</div>
            <div className="settings-card settings-card--spaced">
              <div className="settings-panel__row">
                <FolderIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.vaultLocation')}</span>
                <span className="settings-panel__value settings-panel__value--rtl" title={vaultPath}>
                  {vaultPath}
                </span>
              </div>
              <div className="settings-panel__actions">
                <button
                  className="settings-panel__btn"
                  onClick={() => void window.api.openVaultFolder()}
                >
                  {t('settings.openNotesFolder')}
                </button>
                <button
                  className="settings-panel__btn"
                  onClick={() => {
                    setSettingsOpen(false);
                    chooseVault();
                  }}
                >
                  {t('settings.changeLocation')}
                </button>
              </div>
            </div>

            <div className="settings-panel__section">{t('settings.trash')}</div>
            <div className="settings-card">
              <div className="settings-panel__row">
                <TrashIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.trashContent')}</span>
                <span className="settings-panel__value">
                  {trashStats
                    ? trashStats.count === 0
                      ? t('settings.trashEmpty')
                      : t('settings.trashStats', {
                          count: trashStats.count,
                          size: formatSize(trashStats.bytes),
                        })
                    : '…'}
                </span>
              </div>
              <div className="settings-panel__row">
                <TimerIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.trashAutoClean')}</span>
                <select
                  className="settings-panel__select"
                  value={trashRetention}
                  onChange={(e) => changeTrashRetention(Number(e.target.value))}
                >
                  <option value={7}>{t('settings.trashDays', { count: 7 })}</option>
                  <option value={30}>{t('settings.trashDays', { count: 30 })}</option>
                  <option value={90}>{t('settings.trashDays', { count: 90 })}</option>
                  <option value={0}>{t('settings.trashNoClean')}</option>
                </select>
              </div>
              <div className="settings-panel__actions">
                <button
                  className="settings-panel__btn"
                  onClick={() => void window.api.openTrashFolder()}
                >
                  {t('settings.openTrash')}
                </button>
                <button
                  className={`settings-panel__btn${emptyConfirm ? ' is-danger' : ''}`}
                  disabled={!trashStats || trashStats.count === 0}
                  onClick={emptyTrash}
                >
                  {emptyConfirm ? t('settings.emptyTrashConfirm') : t('settings.emptyTrash')}
                </button>
              </div>
              <div className="settings-panel__hint">{t('settings.trashHint')}</div>
            </div>

            <div className="settings-panel__section">{t('settings.update')}</div>
            <div className="settings-card">
              <div className="settings-panel__row">
                <InfoIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('settings.currentVersion')}</span>
                <span className="settings-panel__value">
                  {version ? `v${version}` : '…'}
                </span>
              </div>
              <div className="settings-panel__actions">
                {updateState.status === 'downloaded' ? (
                  <button
                    className="settings-panel__btn"
                    onClick={() => void window.api.installUpdate()}
                  >
                    {t('settings.restartInstall', { version: updateState.version })}
                  </button>
                ) : (
                  <button
                    className="settings-panel__btn"
                    disabled={
                      !isPackaged ||
                      updateState.status === 'checking' ||
                      updateState.status === 'available' ||
                      updateState.status === 'downloading'
                    }
                    onClick={() => void window.api.checkUpdate()}
                  >
                    <ArrowsClockwiseIcon /> {t('settings.checkUpdate')}
                  </button>
                )}
                {updateState.status === 'error' && (
                  <button
                    className="settings-panel__btn"
                    onClick={() => void window.api.openDownloadPage()}
                  >
                    {t('settings.goDownload')}
                  </button>
                )}
              </div>
              <div className="settings-panel__hint">{updateHint(t, updateState, isPackaged)}</div>
            </div>

            <div className="settings-panel__section">{t('settings.gitSync')}</div>
            <div className="settings-card">
              {/* 未配置 / 编辑态：配置表单（token 永不回显，留空=不修改） */}
              {!syncStatus?.configured || syncEditing ? (
                <>
                  <div className="settings-panel__field">
                    <span className="settings-panel__field-label">{t('sync.repoUrl')}</span>
                    <input
                      className="settings-panel__input"
                      value={syncForm.url}
                      placeholder="https://github.com/you/pinslip-vault.git"
                      spellCheck={false}
                      onChange={(e) => {
                        syncFormDirtyRef.current = true;
                        setSyncForm((f) => ({ ...f, url: e.target.value }));
                      }}
                    />
                  </div>
                  <div className="settings-panel__field">
                    <span className="settings-panel__field-label">{t('sync.username')}</span>
                    <input
                      className="settings-panel__input"
                      value={syncForm.username}
                      placeholder={t('sync.usernamePlaceholder')}
                      spellCheck={false}
                      onChange={(e) => {
                        syncFormDirtyRef.current = true;
                        setSyncForm((f) => ({ ...f, username: e.target.value }));
                      }}
                    />
                  </div>
                  <div className="settings-panel__field">
                    <span className="settings-panel__field-label">{t('sync.token')}</span>
                    <input
                      className="settings-panel__input"
                      type="password"
                      value={syncForm.token}
                      placeholder={
                        syncStatus?.configured ? t('sync.tokenPlaceholderSet') : 'personal access token'
                      }
                      autoComplete="off"
                      onChange={(e) => {
                        syncFormDirtyRef.current = true;
                        setSyncForm((f) => ({ ...f, token: e.target.value }));
                      }}
                    />
                  </div>
                  <div className="settings-panel__field">
                    <span className="settings-panel__field-label">{t('sync.branch')}</span>
                    <input
                      className="settings-panel__input"
                      value={syncForm.branch}
                      placeholder="main"
                      spellCheck={false}
                      onChange={(e) => {
                        syncFormDirtyRef.current = true;
                        setSyncForm((f) => ({ ...f, branch: e.target.value }));
                      }}
                    />
                  </div>
                  {syncFormError && <div className="settings-panel__error">{syncFormError}</div>}
                  {/* 本地认领入口：仅守卫错误（缺 .pinslip-repo 标记）时出现 */}
                  {syncFormErrorCode === 'SYNC_LOCAL_NOT_PINSLIP_REPO' && (
                    <>
                      <div className="settings-panel__hint">{t('sync.adoptHint')}</div>
                      <div className="settings-panel__actions">
                        <button
                          className={`settings-panel__btn${syncAdoptConfirm ? ' is-danger' : ''}`}
                          disabled={syncBusy}
                          onClick={adoptLocalRepo}
                        >
                          {syncAdoptConfirm ? t('sync.adoptConfirm') : t('sync.adopt')}
                        </button>
                      </div>
                    </>
                  )}
                  <div className="settings-panel__actions">
                    {syncStatus?.configured && (
                      <button
                        className="settings-panel__btn"
                        onClick={() => {
                          setSyncEditing(false);
                          setSyncFormError('');
                          setSyncFormErrorCode('');
                          setSyncAdoptConfirm(false);
                          // 放弃草稿：复位 dirty 并立刻回填服务端生效值
                          syncFormDirtyRef.current = false;
                          if (syncStatus?.configured) {
                            setSyncForm({
                              url: syncStatus.url ?? '',
                              username: syncStatus.username ?? '',
                              token: '',
                              branch: syncStatus.branch || 'main',
                            });
                          }
                        }}
                      >
                        {t('sync.cancel')}
                      </button>
                    )}
                    <button
                      className="settings-panel__btn"
                      disabled={syncBusy || !syncForm.url.trim()}
                      onClick={saveSyncConfig}
                    >
                      {syncBusy ? t('sync.connecting') : t('sync.saveEnable')}
                    </button>
                  </div>
                  <div className="settings-panel__hint">{t('sync.formHint')}</div>
                </>
              ) : (
                <>
                  <div className="settings-panel__row">
                    <GitBranchIcon className="settings-panel__row-icon" />
                    <span className="settings-panel__label">{syncStatus.branch || 'main'}</span>
                    <span className="settings-panel__value settings-panel__value--rtl" title={syncStatus.url}>
                      {syncStatus.url}
                    </span>
                  </div>
                  <div className="settings-panel__row">
                    <ArrowsClockwiseIcon className="settings-panel__row-icon" />
                    <span className="settings-panel__label">{t('sync.lastSync')}</span>
                    <span className="settings-panel__value">
                      {syncStatus.enabled
                        ? `${formatRelativeTime(t, syncStatus.lastSyncAt)}${
                            syncStatus.ahead > 0
                              ? t('sync.pendingPush', { count: syncStatus.ahead })
                              : ''
                          }`
                        : t('sync.disabled')}
                    </span>
                  </div>
                  {/* 自动推拉间隔：数字输入在左、单位「分钟」在右，失焦/Enter 即改即存 */}
                  {syncStatus.enabled && (
                    <div className="settings-panel__row">
                      <TimerIcon className="settings-panel__row-icon" />
                      <span className="settings-panel__label">{t('sync.autoSync')}</span>
                      <span className="settings-panel__interval">
                        <input
                          className="settings-panel__input settings-panel__input--number"
                          type="number"
                          min={1}
                          max={1440}
                          step={1}
                          value={syncIntervalInput}
                          disabled={syncBusy}
                          aria-label={t('sync.autoSyncAria')}
                          onChange={(e) => {
                            syncIntervalDirtyRef.current = true;
                            setSyncIntervalInput(e.target.value);
                          }}
                          onBlur={commitSyncInterval}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                        />
                        {t('sync.minutes')}
                      </span>
                    </div>
                  )}
                  {/* 有变更时自动同步：防抖后跑完整 commit+pull+push，定时循环仍作兜底 */}
                  <div className="settings-panel__row">
                    <LightningIcon className="settings-panel__row-icon" />
                    <span className="settings-panel__label">{t('sync.syncOnChange')}</span>
                    <button
                      className="settings-toggle"
                      role="switch"
                      aria-checked={syncStatus.syncOnChange ?? false}
                      data-on={syncStatus.syncOnChange ?? false}
                      disabled={syncBusy}
                      title={t('sync.syncOnChangeHint')}
                      onClick={toggleSyncOnChange}
                    >
                      <span className="settings-toggle__thumb" />
                    </button>
                  </div>
                  {syncStatus.conflictedFiles.length > 0 && (
                    <div className="settings-panel__row">
                      <WarningIcon className="settings-panel__row-icon settings-panel__row-icon--danger" />
                      <span className="settings-panel__label settings-panel__label--danger">
                        {t('sync.conflictFiles', { count: syncStatus.conflictedFiles.length })}
                      </span>
                      <span
                        className="settings-panel__value settings-panel__value--rtl"
                        title={syncStatus.conflictedFiles.join('\n')}
                      >
                        {syncStatus.conflictedFiles[0]}
                        {syncStatus.conflictedFiles.length > 1 ? t('sync.conflictEtc') : ''}
                      </span>
                    </div>
                  )}
                  {/* 分叉接管面板：远端有 .pinslip-repo 标记才把单行错误升级为面板
                      （参考信息 + 两个两阶段确认按钮）；来历不明远端维持原单行错误 */}
                  {syncStatus.lastError &&
                    (syncStatus.lastErrorCode === 'SYNC_UNRELATED_HISTORIES' &&
                    syncStatus.remoteIsPinslip ? (
                      <>
                        <div className="settings-panel__error">
                          {translateServerError(t, syncStatus.lastErrorCode, syncStatus.lastError)}
                        </div>
                        <div className="settings-panel__hint">
                          {t('sync.divergenceInfo', {
                            time: formatRelativeTime(t, syncStatus.remoteLastCommitAt),
                            local: syncStatus.localNotes ?? 0,
                            remote: syncStatus.remoteNotes ?? 0,
                          })}
                        </div>
                        <div className="settings-panel__actions">
                          <button
                            className={`settings-panel__btn${syncResolveConfirm === 'local' ? ' is-danger' : ''}`}
                            disabled={syncBusy}
                            onClick={() => resolveDivergence('local')}
                          >
                            {syncResolveConfirm === 'local'
                              ? t('sync.divergenceLocalConfirm')
                              : t('sync.divergenceLocal')}
                          </button>
                          <button
                            className={`settings-panel__btn${syncResolveConfirm === 'remote' ? ' is-danger' : ''}`}
                            disabled={syncBusy}
                            onClick={() => resolveDivergence('remote')}
                          >
                            {syncResolveConfirm === 'remote'
                              ? t('sync.divergenceRemoteConfirm')
                              : t('sync.divergenceRemote')}
                          </button>
                        </div>
                        <div className="settings-panel__hint">{t('sync.divergenceHint')}</div>
                      </>
                    ) : (
                      <div className="settings-panel__error">
                        {translateServerError(t, syncStatus.lastErrorCode, syncStatus.lastError)}
                      </div>
                    ))}
                  {/* 本地认领入口：状态轮询暴露的守卫错误（缺 .pinslip-repo 标记）同样可认领 */}
                  {syncStatus.lastErrorCode === 'SYNC_LOCAL_NOT_PINSLIP_REPO' && (
                    <>
                      <div className="settings-panel__hint">{t('sync.adoptHint')}</div>
                      <div className="settings-panel__actions">
                        <button
                          className={`settings-panel__btn${syncAdoptConfirm ? ' is-danger' : ''}`}
                          disabled={syncBusy}
                          onClick={adoptLocalRepo}
                        >
                          {syncAdoptConfirm ? t('sync.adoptConfirm') : t('sync.adopt')}
                        </button>
                      </div>
                    </>
                  )}
                  <div className="settings-panel__actions">
                    {syncStatus.enabled ? (
                      <>
                        <button
                          className="settings-panel__btn"
                          disabled={syncBusy}
                          onClick={doSyncNow}
                        >
                          <ArrowsClockwiseIcon /> {t('sync.syncNow')}
                        </button>
                        <button
                          className="settings-panel__btn"
                          disabled={syncBusy}
                          onClick={() => setSyncEditing(true)}
                        >
                          {t('sync.editConfig')}
                        </button>
                        <button
                          className={`settings-panel__btn${syncDisableConfirm ? ' is-danger' : ''}`}
                          disabled={syncBusy}
                          onClick={disableSync}
                        >
                          {syncDisableConfirm ? t('sync.disableConfirm') : t('sync.disable')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="settings-panel__btn"
                          disabled={syncBusy || !syncForm.url.trim()}
                          onClick={saveSyncConfig}
                        >
                          {t('sync.reenable')}
                        </button>
                        <button
                          className="settings-panel__btn"
                          disabled={syncBusy}
                          onClick={() => setSyncEditing(true)}
                        >
                          {t('sync.editConfig')}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="settings-panel__hint">
                    {t('sync.statusHint', { minutes: syncStatus.pushIntervalMin ?? 10 })}
                  </div>
                </>
              )}
            </div>

            <div className="settings-panel__section">{t('settings.mcp')}</div>
            <div className="settings-card">
              {/* 总开关：mcpEnabled 缺省开；关闭时 Go 侧 /mcp 端点整体 404 */}
              <div className="settings-panel__row">
                <RobotIcon className="settings-panel__row-icon" />
                <span className="settings-panel__label">{t('mcp.aiAccess')}</span>
                <button
                  className="settings-toggle"
                  role="switch"
                  aria-checked={mcpEnabled}
                  data-on={mcpEnabled}
                  title={mcpEnabled ? t('mcp.turnOff') : t('mcp.turnOn')}
                  onClick={toggleMcp}
                >
                  <span className="settings-toggle__thumb" />
                </button>
              </div>
              {/* 接入信息：仅开启时展示（关闭后端点不存在，信息无意义） */}
              {mcpEnabled && (
                <>
                  <div className="settings-panel__row">
                    <LinkIcon className="settings-panel__row-icon" />
                    <span className="settings-panel__label">{t('mcp.endpoint')}</span>
                    <span
                      className="settings-panel__value settings-panel__value--rtl"
                      title={goPort ? `http://127.0.0.1:${goPort}/mcp` : ''}
                    >
                      {goPort ? `http://127.0.0.1:${goPort}/mcp` : '…'}
                    </span>
                  </div>
                  <div className="settings-panel__row">
                    <GlobeIcon className="settings-panel__row-icon" />
                    <span className="settings-panel__label">{t('mcp.httpBase')}</span>
                    <span
                      className="settings-panel__value settings-panel__value--rtl"
                      title={goPort ? `http://127.0.0.1:${goPort}` : ''}
                    >
                      {goPort ? `http://127.0.0.1:${goPort}` : '…'}
                    </span>
                  </div>
                  <div className="settings-panel__row">
                    <FileCodeIcon className="settings-panel__row-icon" />
                    <span className="settings-panel__label">{t('mcp.configFile')}</span>
                    <span
                      className="settings-panel__value settings-panel__value--rtl"
                      title={`${vaultPath}/.pinslip/mcp.json`}
                    >
                      {vaultPath ? `${vaultPath}/.pinslip/mcp.json` : '…'}
                    </span>
                  </div>
                  <div className="settings-panel__actions">
                    <button
                      className="settings-panel__btn"
                      disabled={!goPort}
                      onClick={copyMcpConfig}
                    >
                      {mcpCopied ? <CheckIcon /> : <CopyIcon />}
                      {mcpCopied ? t('mcp.copied') : t('mcp.copy')}
                    </button>
                  </div>
                </>
              )}
              <div className="settings-panel__hint">{t('mcp.hint')}</div>
            </div>

            {/* 高级设置：抽屉底部可折叠二级区域（默认收起，视觉降级），
                承载行为定制选项；全部选项缺省保持现状，即改即存即生效 */}
            <button
              className="settings-panel__section settings-panel__section--toggle"
              title={advancedOpen ? t('settings.advancedCollapse') : t('settings.advancedExpand')}
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              {advancedOpen ? <CaretDownIcon /> : <CaretRightIcon />}
              {t('settings.advanced')}
            </button>
            {advancedOpen && (
              <div className="settings-card">
                <div className="settings-panel__row">
                  <TrayIcon className="settings-panel__row-icon" />
                  <span className="settings-panel__label">{t('settings.trayIcon')}</span>
                  <button
                    className="settings-toggle"
                    role="switch"
                    aria-checked={trayIcon}
                    data-on={trayIcon}
                    title={t('settings.trayIconTip')}
                    onClick={toggleTrayIcon}
                  >
                    <span className="settings-toggle__thumb" />
                  </button>
                </div>
                <div className="settings-panel__hint">{t('settings.trayIconHint')}</div>
                <div className="settings-panel__row">
                  <AppWindowIcon className="settings-panel__row-icon" />
                  <span className="settings-panel__label">{t('settings.taskbarIcon')}</span>
                  <button
                    className="settings-toggle"
                    role="switch"
                    aria-checked={taskbarIcon}
                    data-on={taskbarIcon}
                    title={t('settings.taskbarIconTip')}
                    onClick={toggleTaskbarIcon}
                  >
                    <span className="settings-toggle__thumb" />
                  </button>
                </div>
                <div className="settings-panel__hint">{t('settings.taskbarIconHint')}</div>
                <div className="settings-panel__row">
                  <NoteIcon className="settings-panel__row-icon" />
                  <span className="settings-panel__label">{t('settings.notePlacement')}</span>
                  <select
                    className="settings-panel__select"
                    value={notePlacement}
                    onChange={(e) =>
                      changeNotePlacement(e.target.value as 'cascade' | 'beside-manager')
                    }
                  >
                    <option value="cascade">{t('settings.notePlacementCascade')}</option>
                    <option value="beside-manager">
                      {t('settings.notePlacementBesideManager')}
                    </option>
                  </select>
                </div>
                <div className="settings-panel__hint">{t('settings.notePlacementHint')}</div>
                <div className="settings-panel__row">
                  <MoonIcon className="settings-panel__row-icon" />
                  <span className="settings-panel__label">{t('settings.managerTheme')}</span>
                  <select
                    className="settings-panel__select"
                    value={managerTheme}
                    onChange={(e) =>
                      changeManagerTheme(e.target.value as 'light' | 'dark' | 'system')
                    }
                  >
                    <option value="light">{t('settings.managerThemeLight')}</option>
                    <option value="dark">{t('settings.managerThemeDark')}</option>
                    <option value="system">{t('settings.managerThemeSystem')}</option>
                  </select>
                </div>
                <div className="settings-panel__hint">{t('settings.managerThemeHint')}</div>
                <div className="settings-panel__row">
                  <KeyboardIcon className="settings-panel__row-icon" />
                  <span className="settings-panel__label">{t('settings.blankNoteShortcut')}</span>
                  <select
                    className="settings-panel__select"
                    value={blankNoteShortcut}
                    onChange={(e) => changeBlankNoteShortcut(e.target.value as BlankNoteShortcut)}
                  >
                    <option value="off">{t('settings.blankNoteShortcutOff')}</option>
                    <option value="ctrl+alt+n">{t('settings.blankNoteShortcutCtrlAltN')}</option>
                    <option value="ctrl+shift+alt+n">
                      {t('settings.blankNoteShortcutCtrlShiftAltN')}
                    </option>
                    <option value="ctrl+alt+insert">
                      {t('settings.blankNoteShortcutCtrlAltInsert')}
                    </option>
                  </select>
                </div>
                <div className="settings-panel__hint">{t('settings.blankNoteShortcutHint')}</div>
                {blankNoteShortcutError && (
                  <div className="settings-panel__error">
                    {t('settings.blankNoteShortcutRegisterFailed')}
                  </div>
                )}
                {/* 工具栏按钮排序：指针拖拽换位（便签组同款模式，不用 HTML5 DnD），
                    前 8 位直接显示在便签工具栏，超出位次进 ⋯ 菜单找回；
                    即改即存即生效（主进程广播，便签窗口即时重排） */}
                <div className="settings-panel__row">
                  <SlidersHorizontalIcon className="settings-panel__row-icon" />
                  <span className="settings-panel__label">{t('settings.toolbarButtons')}</span>
                  <button
                    className="settings-panel__btn settings-sortlist__reset"
                    title={t('settings.toolbarButtonsResetTip')}
                    onClick={resetToolbarButtons}
                  >
                    <ArrowCounterClockwiseIcon />
                    {t('settings.toolbarButtonsReset')}
                  </button>
                </div>
                <div className="settings-panel__hint">{t('settings.toolbarButtonsHint')}</div>
                <ul className="settings-sortlist" ref={tbListRef}>
                  {toolbarButtons.map((id, i) => (
                    <Fragment key={id}>
                      {i === TOOLBAR_DISPLAY_LIMIT && (
                        <li className="settings-sortlist__overflow" aria-hidden>
                          {t('settings.toolbarButtonsOverflow')}
                        </li>
                      )}
                      <li
                        className={`settings-sortlist__row${tbDrag?.from === i ? ' is-dragging' : ''}`}
                      >
                        <button
                          className="settings-sortlist__handle"
                          aria-label={t('settings.toolbarDragTip')}
                          title={t('settings.toolbarDragTip')}
                          onPointerDown={(e) => startToolbarDrag(e, i)}
                        >
                          <DotsSixVerticalIcon />
                        </button>
                        <span className="settings-sortlist__name">
                          {t(TOOLBAR_BUTTON_LABEL_KEYS[id] ?? id)}
                        </span>
                      </li>
                    </Fragment>
                  ))}
                  {tbDrag && (
                    <div className="settings-sortlist__indicator" style={{ top: tbDrag.y }} />
                  )}
                </ul>
              </div>
            )}
          </div>
        </>
      )}

      <div className="main-view__search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
        />
      </div>

      {error && <div className="main-view__error">{error}</div>}

      {/* 三视图切换：列表 / 文件夹 / 标签 */}
      {!hits && (
        <div className="main-view__tabs">
          <button
            className={`main-view__tab${view === 'list' ? ' is-active' : ''}`}
            onClick={() => setView('list')}
          >
            <ListBulletsIcon /> {t('tabs.list')}
          </button>
          <button
            className={`main-view__tab${view === 'folders' ? ' is-active' : ''}`}
            onClick={() => setView('folders')}
          >
            <FolderIcon /> {t('tabs.folders')}
          </button>
          <button
            className={`main-view__tab${view === 'tags' ? ' is-active' : ''}`}
            onClick={() => setView('tags')}
          >
            <TagIcon /> {t('tabs.tags')}
          </button>
        </div>
      )}

      {/* 文件夹视图：面包屑 + 新建文件夹。
          层级深时中间段折叠为 …（点击展开），只留 全部/…/父级/当前，避免折行占位 */}
      {!hits && view === 'folders' && (
        <div className="main-view__crumbs">
          <button
            className={`main-view__crumb${currentFolder === '' ? ' is-here' : ''}`}
            onClick={() => enterFolder('')}
          >
            {t('folders.all')}
          </button>
          {!crumbsExpanded && crumbs.length > 3 && (
            <span className="main-view__crumb-seg">
              <span className="main-view__crumb-sep">/</span>
              <button
                className="main-view__crumb"
                title={crumbs
                  .slice(0, -2)
                  .map((c) => c.name)
                  .join(' / ')}
                onClick={() => setCrumbsExpanded(true)}
              >
                …
              </button>
            </span>
          )}
          {(crumbsExpanded || crumbs.length <= 3 ? crumbs : crumbs.slice(-2)).map((c) => (
            <span key={c.path} className="main-view__crumb-seg">
              <span className="main-view__crumb-sep">/</span>
              <button
                className={`main-view__crumb${c.path === currentFolder ? ' is-here' : ''}`}
                title={c.path}
                onClick={() => enterFolder(c.path)}
              >
                {c.name}
              </button>
            </span>
          ))}
          <span className="main-view__crumb-actions">
            <button
              className="main-view__newfolder-btn"
              title={
                currentFolder
                  ? t('folders.newNoteHere', { folder: shortenFolder(currentFolder, 14) })
                  : t('folders.newNoteRoot')
              }
              onClick={() => void window.api.createNote(undefined, currentFolder)}
            >
              <PlusIcon />
            </button>
            <button
              className="main-view__newfolder-btn"
              title={t('folders.newFolder')}
              onClick={() => setNewFolderOpen((v) => !v)}
            >
              <FolderPlusIcon />
            </button>
          </span>
        </div>
      )}

      {/* 新建文件夹输入行：Enter 与创建按钮等效 */}
      {!hits && view === 'folders' && newFolderOpen && (
        <div className="main-view__newfolder-row">
          <input
            autoFocus
            value={newFolderName}
            placeholder={t('folders.newFolderPlaceholder')}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createFolder();
              if (e.key === 'Escape') {
                setNewFolderName('');
                setNewFolderOpen(false);
              }
            }}
          />
          <button
            className="main-view__newfolder-create"
            title={t('folders.createTip')}
            disabled={!newFolderName.trim()}
            onClick={createFolder}
          >
            <PlusIcon />
          </button>
        </div>
      )}

      {hits ? (
        <section className="main-view__section">
          <h2>{t('search.results', { count: hits.length })}</h2>
          <ul className="note-list">
            {hits.map((hit) => (
              <li key={hit.id} onClick={() => openNote(hit.id)}>
                {/* 标题先做命中锚定窗口截断：长标题里命中词会被 CSS 省略号
                    截掉，窗口化保证命中词落在可视区前部（20 ≈ 一行容量） */}
                <span className="note-list__title note-list__title--plain">
                  {highlightTerms(windowAroundMatch(hit.title, hitTerms, 20), hitTerms)}
                </span>
                <span className="note-list__snippet">{highlightTerms(hit.snippet, hitTerms)}</span>
                {hit.conflicted && (
                  <span className="note-list__badges">
                    <span className="note-list__conflict" title={t('note.conflictTip')}>
                      <WarningIcon />
                      {t('note.conflict')}
                    </span>
                  </span>
                )}
              </li>
            ))}
            {hits.length === 0 && <li className="note-list__empty">{t('search.noResults')}</li>}
          </ul>
        </section>
      ) : view === 'list' ? (
        /* 列表视图：全部便签平铺（含各文件夹与 inbox），meta 标注所在文件夹；
           支持按更新/创建时间 × 升/倒序排序 */
        <section className="main-view__section">
          <div className="main-view__listhead">
            <h2>{t('list.allNotes', { count: notes.length })}</h2>
            <div className="main-view__sort">
              <select
                value={sortKey}
                title={t('list.sortField')}
                onChange={(e) => setSortKey(e.target.value as 'updated' | 'created')}
              >
                <option value="updated">{t('list.byUpdated')}</option>
                <option value="created">{t('list.byCreated')}</option>
              </select>
              <button
                title={sortDir === 'desc' ? t('list.descTip') : t('list.ascTip')}
                onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
              >
                {sortDir === 'desc' ? <SortDescendingIcon /> : <SortAscendingIcon />}
              </button>
            </div>
          </div>
          <ul className="note-list">
            {sortedNotes.map((note) => renderNoteItem(note, true))}
            {notes.length === 0 && !error && (
              <li className="note-list__empty">{emptyNoteHint}</li>
            )}
          </ul>
        </section>
      ) : view === 'folders' ? (
        /* 文件夹视图：本层子文件夹 + 本层便签 */
        <section className="main-view__section">
          <h2 title={currentFolder || undefined}>
            {currentFolder
              ? t('folders.current', { name: shortenFolder(currentFolder, 18), count: layerNotes.length })
              : t('folders.root', { count: layerNotes.length })}
          </h2>
          <ul className="note-list">
            {childFolders.map((f) => (
              <li
                key={`dir:${f}`}
                className="note-list__dir"
                onClick={() => renamingFolder !== f && enterFolder(f)}
              >
                {renamingFolder === f ? (
                  /* 行内重命名：Enter 确认 / Esc 取消，失焦等价取消 */
                  <input
                    className="note-list__rename-input"
                    autoFocus
                    value={renameValue}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => setRenamingFolder(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename();
                      if (e.key === 'Escape') setRenamingFolder(null);
                    }}
                  />
                ) : (
                  <span className="note-list__title">
                    <FolderOpenIcon className="note-list__dir-icon" />
                    {f.split('/').pop()}
                  </span>
                )}
                <button
                  className="note-list__rename"
                  title={t('folders.renameTip')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingFolder(f);
                    setRenameValue(f.split('/').pop() ?? '');
                  }}
                >
                  <PencilSimpleIcon />
                </button>
                <button
                  className="note-list__delete"
                  title={t('folders.deleteTip')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteFolderTarget(f);
                  }}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
            {layerNotes.map((note) => renderNoteItem(note))}
            {layerNotes.length === 0 && childFolders.length === 0 && !error && (
              <li className="note-list__empty">
                {currentFolder ? t('folders.empty') : emptyNoteHint}
              </li>
            )}
          </ul>
        </section>
      ) : (
        /* 标签视图：按标签分组（频次降序），无标签的归到最后一组；
           组头可点击收起/展开（会话内记忆） */
        <>
          {tagGroups.groups.map((g) => {
            const collapsed = collapsedTags.has(g.tag);
            return (
              <section key={g.tag} className="main-view__section">
                <h2
                  className="main-view__grouphead"
                  title={collapsed ? t('tags.expand') : t('tags.collapse')}
                  onClick={() => toggleTagGroup(g.tag)}
                >
                  {collapsed ? <CaretRightIcon /> : <CaretDownIcon />}
                  #{g.tag}（{g.count}）
                </h2>
                {!collapsed && (
                  <ul className="note-list">{g.notes.map((note) => renderNoteItem(note))}</ul>
                )}
              </section>
            );
          })}
          {tagGroups.untagged.length > 0 && (
            <section className="main-view__section">
              <h2
                className="main-view__grouphead"
                title={collapsedTags.has('__untagged__') ? t('tags.expand') : t('tags.collapse')}
                onClick={() => toggleTagGroup('__untagged__')}
              >
                {collapsedTags.has('__untagged__') ? <CaretRightIcon /> : <CaretDownIcon />}
                {t('tags.untagged', { count: tagGroups.untagged.length })}
              </h2>
              {!collapsedTags.has('__untagged__') && (
                <ul className="note-list">
                  {tagGroups.untagged.map((note) => renderNoteItem(note))}
                </ul>
              )}
            </section>
          )}
          {notes.length === 0 && !error && (
            <section className="main-view__section">
              <ul className="note-list">
                <li className="note-list__empty">{emptyNoteHint}</li>
              </ul>
            </section>
          )}
        </>
      )}

      {/* 移动到文件夹弹层 */}
      {moveTarget && (
        <>
          <button
            className="move-pop__backdrop"
            aria-label={t('move.cancel')}
            onClick={() => setMoveTarget(null)}
          />
          <div className="move-pop">
            <h3 className="move-pop__title">{t('move.title', { title: moveTarget.title })}</h3>
            {/* 路径筛选：目录多的时候快速定位（大小写不敏感子串） */}
            {folders.length > 5 && (
              <input
                className="move-pop__filter"
                value={moveFilter}
                placeholder={t('move.filter')}
                autoFocus
                onChange={(e) => setMoveFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setMoveTarget(null);
                }}
              />
            )}
            <div className="move-pop__list">
              {(!moveFilter.trim() || t('folders.rootShort').includes(moveFilter.trim())) && (
                <button className="move-pop__item" onClick={() => moveNoteTo('')}>
                  <FolderIcon /> {t('folders.rootShort')}
                </button>
              )}
              {filteredMoveFolders.map((f) => (
                <button
                  key={f}
                  className="move-pop__item"
                  title={f}
                  onClick={() => moveNoteTo(f)}
                >
                  <FolderIcon /> {shortenFolder(f, 22)}
                </button>
              ))}
              {folders.length === 0 && (
                <div className="move-pop__empty">{t('move.noFolders')}</div>
              )}
              {folders.length > 0 && filteredMoveFolders.length === 0 && (
                <div className="move-pop__empty">{t('move.noMatch', { query: moveFilter.trim() })}</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 删除文件夹确认弹层：空文件夹直接确认；非空给两种策略——
          move（便签上移根目录，默认）/ trash（整树移入 .trash 回收区，可手动找回） */}
      {deleteFolderTarget && (
        <>
          <button
            className="move-pop__backdrop"
            aria-label={t('folders.cancelDelete')}
            onClick={() => setDeleteFolderTarget(null)}
          />
          <div className="move-pop">
            <h3 className="move-pop__title" title={deleteFolderTarget}>
              {t('folders.deleteTitle', { name: deleteFolderTarget.split('/').pop() })}
              {folderNoteCount(deleteFolderTarget) > 0 &&
                t('folders.deleteContains', { count: folderNoteCount(deleteFolderTarget) })}
            </h3>
            <div className="move-pop__list">
              <button
                className="move-pop__item"
                onClick={() => deleteFolder(deleteFolderTarget, 'move')}
              >
                <FolderIcon />
                {folderNoteCount(deleteFolderTarget) > 0
                  ? t('folders.deleteMoveNotes')
                  : t('folders.deleteEmpty')}
              </button>
              {folderNoteCount(deleteFolderTarget) > 0 && (
                <button
                  className="move-pop__item move-pop__item--danger"
                  onClick={() => deleteFolder(deleteFolderTarget, 'trash')}
                >
                  <TrashIcon /> {t('folders.deleteWithNotes')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

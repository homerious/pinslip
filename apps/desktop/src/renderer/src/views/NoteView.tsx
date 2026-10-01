import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PlusIcon from '~icons/ph/plus';
import XIcon from '~icons/ph/x';
import CaretUpIcon from '~icons/ph/caret-up';
import CaretDownIcon from '~icons/ph/caret-down';
import CaretDownFillIcon from '~icons/ph/caret-down-fill';
import SubtractFillIcon from '~icons/ph/subtract-fill';
import DotsThreeIcon from '~icons/ph/dots-three';
import DotsSixVerticalIcon from '~icons/ph/dots-six-vertical';
import LinkBreakIcon from '~icons/ph/link-break';
import TrashIcon from '~icons/ph/trash';
import ListBulletsIcon from '~icons/ph/list-bullets';
import TagIcon from '~icons/ph/tag';
import TagFillIcon from '~icons/ph/tag-fill';
import FolderIcon from '~icons/ph/folder';
import FolderFillIcon from '~icons/ph/folder-fill';
import TextBolderIcon from '~icons/ph/text-bolder';
import TextStrikethroughIcon from '~icons/ph/text-strikethrough';
import ListChecksIcon from '~icons/ph/list-checks';
import ImageIcon from '~icons/ph/image';
import MagnifyingGlassMinusIcon from '~icons/ph/magnifying-glass-minus';
import MagnifyingGlassPlusIcon from '~icons/ph/magnifying-glass-plus';
import CopyIcon from '~icons/ph/copy';
import CheckIcon from '~icons/ph/check';
import ExportIcon from '~icons/ph/aperture';
import FloppyDiskIcon from '~icons/ph/floppy-disk';
import ArrowsClockwiseIcon from '~icons/ph/arrows-clockwise';
import WarningCircleFillIcon from '~icons/ph/warning-circle-fill';
import TableIcon from '~icons/ph/table';
import PencilSimpleIcon from '~icons/ph/pencil-simple';
import ArrowCounterClockwiseIcon from '~icons/ph/arrow-counter-clockwise';
import PinIcon from '../components/icons/PinIcon';
import Editor from '../components/editor/Editor';
import type { EditorHandle } from '../components/editor/Editor';
import FindBar from '../components/editor/FindBar';
import ConflictResolver from '../components/ConflictResolver';
import { toMarkdownImageSrc } from '../components/editor/image-support';
import { attachmentsApi, SUPPORTED_IMAGE_MIME_TYPES } from '../api/attachments';
import { foldersApi, notesApi } from '../api/notes';
import { syncApi } from '../api/sync';
import { hasConflictMarkers } from '../utils/conflict';
import { COLORS, LAST_NOTE_COLOR_KEY, readLastNoteColor } from '../utils/colors';
import { formatRelativeTime } from '../utils/time';
import { toCompactMarkdown } from '../utils/compact-markdown';
import { shortenFolder } from '../utils/path';
import { COLLAPSE_ANIM_MS } from '@shared/anim';
import { sanitizeToolbarButtons, TOOLBAR_BUTTON_DEFAULT_ORDER, TOOLBAR_DISPLAY_LIMIT } from '@shared/toolbar';
import type { GroupState, NoteColor, SyncStatus } from '@shared/types';

type SaveState = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

/** 与服务端 deriveTitle 完全一致的标题推导：
 *  首个有效行剥掉 markdown 结构标记后截断 30 字符（按码点计，同 Go 的 rune）：
 *  - 行首结构标记（可叠加，循环剥）：#{1,6} 标题、> 引用、-/​*​/+ 无序列表、
 *    1. 有序列表、[ ]/[x] 任务框；"#tag" 这类无空格形式不算标记
 *  - 整行链接/图片 [t](url) / ![alt](src) → 取 t / alt
 *  - 整行行内包装（**b** / *i* / ~~s~~ / `c` 等）：配对完整才剥最外层，循环
 *  剥完为空的纯格式行（如 "##"）继续看下一行；全空返回 ''（调用方决定兜底文案） */
function deriveTitle(markdown: string): string {
  const BLOCK_PREFIX =
    /^(?:#{1,6}(?:\s+|$)|>(?:\s?|$)|[-*+](?:\s+|$)|\d{1,9}[.)](?:\s+|$)|\[[ xX]\](?:\s+|$))/;
  const LINK_ONLY = /^!?\[([^\]]*)\]\([^)]*\)$/;
  // 两字符包装在前，保证 ** 优先于 * 匹配（顺序同服务端 titleInlineWraps）
  const INLINE_WRAPS = ['**', '__', '~~', '*', '_', '`'];

  for (const raw of markdown.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    // git 冲突标记行不参与标题推导（与服务端 deriveTitle 的守卫一致，
    // 否则冲突便签窗口标题会显示成标记符）
    if (line.startsWith('<<<<<<<') || line.startsWith('=======') || line.startsWith('>>>>>>>')) {
      continue;
    }
    // 表格行：按 | 拆单元格，空单元格的 <br/> 占位与分隔线单元格（---/:--:）
    // 剥掉，其余文本空格连接；纯管道行产出空 → 跳过。空表格不至于把标题
    // 污染成 "| <br /> | <br /> |"（与服务端 deriveTitle 同规则）
    if (line.startsWith('|')) {
      line = line
        .split('|')
        .map((c) => c.trim().replace(/^<br\s*\/?>$/i, '').trim())
        .filter((c) => c !== '' && !/^[-: ]+$/.test(c))
        .join(' ')
        .trim();
      if (!line) continue;
    }
    // 块级前缀：循环剥（叠加前缀如 "> ## "）
    while (BLOCK_PREFIX.test(line)) {
      const next = line.replace(BLOCK_PREFIX, '').trim();
      if (next === line) break;
      line = next;
    }
    const link = LINK_ONLY.exec(line);
    if (link) line = link[1].trim();
    // 行内包装：整行被同一标记完整包裹才剥最外层（**重要**：xxx 这类半包装保留原文）
    for (;;) {
      const wrap = INLINE_WRAPS.find(
        (w) => line.length > w.length * 2 && line.startsWith(w) && line.endsWith(w),
      );
      if (!wrap) break;
      line = line.slice(wrap.length, -wrap.length).trim();
    }
    if (!line) continue; // 纯格式行 → 下一行
    const chars = [...line];
    if (chars.length > 30) line = chars.slice(0, 30).join('') + '…';
    return line;
  }
  return '';
}

/** 内容缩放：整数百分比存储/计算（50–200，步进 10，默认 100），
 *  避免 0.7+0.1 这类浮点误差；持久化到 frontmatter 时 /100 转倍率 */
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;

/** 六色定义已迁至 utils/colors.ts（主窗口新建按钮也要读色板与上次用色） */

/** 便签窗口视图：无边框窗内的编辑界面；
 *  标题栏承载 新建/颜色/置顶/关闭，底部工具栏（focus 浮现）承载 ⋯菜单/保存状态 */
export default function NoteView() {
  const { t } = useTranslation();
  const { noteId = '' } = useParams<{ noteId: string }>();
  const [searchParams] = useSearchParams();
  /** 新建便签的落盘文件夹（窗口创建时经路由 query 下发；已存在便签忽略，以 note.folder 为准） */
  const initialFolder = searchParams.get('folder') ?? '';
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(true); // 新便签默认置顶
  const [collapsed, setCollapsed] = useState(false); // 折叠成标题条（只显示标题栏）
  /** 折叠/展开的 CSS 高度过渡只在切换瞬间挂（180ms），平时拖拽改尺寸不挂 transition 防滞后 */
  const [collapseAnim, setCollapseAnim] = useState(false);
  const [color, setColor] = useState<NoteColor>(() => readLastNoteColor());
  /** 当前新建用色（localStorage 上次用色）：与本便签同色时新建按钮不显示圆点 */
  const [newNoteColor, setNewNoteColor] = useState<NoteColor>(() => readLastNoteColor());
  /** 内容缩放（整数百分比）；只作用于标题文字与编辑器正文，标题栏/工具栏按钮不缩 */
  const [zoomPct, setZoomPct] = useState(ZOOM_DEFAULT);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  // 文件夹归属：folder 为 notes/ 相对路径（"" 根目录）；folderPanel 打开时才拉取目录列表
  const [folder, setFolder] = useState('');
  const [folderPanelOpen, setFolderPanelOpen] = useState(false);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  /** 文件夹面板的路径筛选（目录 >5 个时出现输入框） */
  const [folderFilter, setFolderFilter] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  /** git 同步状态快照：仅配置了同步时有意义；激活时 + 手动同步后拉取（不轮询） */
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** 外部修改横幅：本地脏期间磁盘被改 → 暂存磁盘内容，等用户选择（后到的覆盖旧的） */
  const [externalUpdate, setExternalUpdate] = useState<string | null>(null);
  /** Editor remount 世代号：外部重载时 +1，以磁盘内容为 defaultValue 重建编辑器 */
  const [editorEpoch, setEditorEpoch] = useState(0);
  /** 自动重载完成的轻提示文案（2.5s 自动消隐） */
  const [toast, setToast] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 便签内搜索条：Ctrl+F 打开；findReplaceOpen = 替换行展开（Ctrl+H 直接展开） */
  const [findOpen, setFindOpen] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  /** 导出为图片：菜单开关 + 进行中断言（主进程同一时间只允许一次导出）+ 复制成功 ✓ 反馈 */
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exported, setExported] = useState(false);
  /** ＋新建落点菜单（便签在子文件夹时才有：同文件夹 / 根目录） */
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 窗口是否激活（跟随 OS 焦点，比 :focus-within 可靠——点面板任意处都算） */
  const [active, setActive] = useState(() => document.hasFocus());
  /** 工具栏优先级隐藏：编辑区从低优先级藏起的按钮数（0..3，保底留区首） */
  const [hiddenEdit, setHiddenEdit] = useState(0);
  /** 工具栏左区按钮的用户自定义顺序（有序 id 列表；缺省 = 现状顺序）。
   *  挂载读 getAdvanced + 订阅 advanced:changed 广播即时重排 */
  const [toolbarOrder, setToolbarOrder] = useState<string[]>(() => [
    ...TOOLBAR_BUTTON_DEFAULT_ORDER,
  ]);
  /** 分类区隐藏级别：0=全显，1=藏复制全部，2=再藏保存状态（保底留 标签/文件夹/⋯） */
  const [hiddenAux, setHiddenAux] = useState(0);
  /** 复制全部成功反馈（图标短暂变 ✓） */
  const [copied, setCopied] = useState(false);
  /** 便签组态：null = 不在组内；角色驱动 CSS 拼框（首/中/尾圆角/描边/阴影） */
  const [groupState, setGroupState] = useState<GroupState | null>(null);
  /** 成组预告高亮：拖动中与目标卡片重叠 ≥50% 时两张同时点亮，拖开即消 */
  const [groupHover, setGroupHover] = useState(false);
  /** 组手柄拖拽中（整组移动）：驱动手柄 is-dragging 态（cursor: grabbing） */
  const [groupDragging, setGroupDragging] = useState(false);
  /** 文件管理器拖入受支持图片时的卡片级投放反馈。 */
  const [imageDragActive, setImageDragActive] = useState(false);
  /** 组名编辑中（组标签手柄双击进入）；Esc 置取消标记，blur 提交 */
  const [groupRenaming, setGroupRenaming] = useState(false);
  /** 组手柄右键菜单（解散此组） */
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const groupRenameCancelRef = useRef(false);
  /** 手动标题标志：true = 标题由用户重命名，标题栏取 note.title 不随正文实时推导 */
  const [titleManual, setTitleManual] = useState(false);
  /** 标题行内编辑中（双击标题或右键「重命名便签」进入）；Esc 置取消标记，blur 提交 */
  const [titleRenaming, setTitleRenaming] = useState(false);
  /** 标题栏右键菜单（重命名便签 / 恢复自动标题） */
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const titleRenameCancelRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);
  const loadedRef = useRef(false);
  const existsRef = useRef(false); // 是否已存在于服务端（新便签写了内容才落盘）
  const lastSavedRef = useRef(''); // 上次保存的内容，避免加载后多余回写
  const folderRef = useRef(''); // 笔记所在子文件夹（图片 ../ 前缀深度）
  const contentRef = useRef(''); // 内容现值：供异步回调（保存回包/外部变更）读取，避开闭包旧值
  const dirtyRef = useRef(false); // 有未落盘的本地编辑（用户输入置位，保存成功/外部重载复位）
  /** 最后一次用户编辑的时间戳：同步按钮判定「本地与 git 最后一次同步是否一致」用 */
  const lastEditAtRef = useRef(0);

  /** 窗口激活时若焦点没落在具体控件上，把焦点交给编辑器（光标置文末，直接可输入）。
   *  编辑器异步初始化，未就绪时短间隔重试几次 */
  const focusEditorIfIdle = useCallback((attempt = 0) => {
    const el = document.activeElement;
    if (el && el !== document.body) return;
    const ok = editorRef.current?.focusEnd() ?? false;
    if (!ok && attempt < 10) {
      setTimeout(() => focusEditorIfIdle(attempt + 1), 120);
    }
  }, []);

  /** 关闭搜索条：卸载浮层 + 清空命中高亮 + 焦点还回编辑器（closeFind 内部幂等） */
  const closeFindBar = useCallback(() => {
    setFindOpen(false);
    setFindReplaceOpen(false);
    editorRef.current?.closeFind();
  }, []);

  /** 工具栏宽度自适应：溢出时按优先级从低到高逐级藏（先编辑区按钮，再分类区的
   *  复制全部/保存状态）；富余超过一个按钮位（≈30px，迟滞防抖）时按相反顺序逐级放回。
   *  每次渲染后由 useLayoutEffect 驱动，setState 触发重渲染直到收敛。
   *  血泪教训：宽度测量必须用「已渲染子元素 offsetWidth 之和」——右区
   *  margin-left:auto 会把内容顶满全宽，scrollWidth 恒等于 clientWidth，
   *  靠 clientWidth-scrollWidth 判定富余是死代码（单向棘轮只藏不放：
   *  挂载瞬态一旦溢出，按钮永久消失，2026-07-21 新便签工具栏事故） */
  const reflowToolbar = useCallback(() => {
    const el = toolbarRef.current;
    if (!el || el.clientWidth === 0) return; // 未布局（挂载瞬态）不判定
    const cs = getComputedStyle(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const natural = Array.from(el.children).reduce(
      (sum, c) => sum + (c as HTMLElement).offsetWidth,
      0,
    );
    if (natural > avail + 1) {
      if (hiddenEdit < 3) setHiddenEdit((v) => v + 1);
      else if (hiddenAux < 2) setHiddenAux((v) => v + 1);
    } else if ((hiddenAux > 0 || hiddenEdit > 0) && avail - natural > 30) {
      if (hiddenAux > 0) setHiddenAux((v) => v - 1);
      else setHiddenEdit((v) => v - 1);
    }
  }, [hiddenEdit, hiddenAux]);

  useLayoutEffect(() => {
    reflowToolbar();
  });

  // 窗口缩放（含拖边缘缩便签）时重排工具栏
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => reflowToolbar());
    ro.observe(el);
    return () => ro.disconnect();
  }, [reflowToolbar]);

  // 工具栏按钮自定义顺序：挂载读取 + 订阅主进程广播（主窗口高级设置改序后
  // 即时重排，无需重开）；广播载荷是补齐后的完整对象，渲染层再过一遍
  // sanitize 兜底（广播外的来源不入此通道）
  useEffect(() => {
    let alive = true;
    window.api
      .getAdvanced()
      .then((a) => {
        if (alive) setToolbarOrder(sanitizeToolbarButtons(a.toolbarButtons));
      })
      .catch(() => {});
    return window.api.onAdvancedChanged((a) =>
      setToolbarOrder(sanitizeToolbarButtons(a.toolbarButtons)),
    );
  }, []);

  // 文件夹面板关闭时清空路径筛选（下次打开回到全量列表）
  useEffect(() => {
    if (!folderPanelOpen) setFolderFilter('');
  }, [folderPanelOpen]);

  /** git 同步状态：挂载/激活/同步完成后拉取（便签可多开，轮询不可接受） */
  const refreshSyncStatus = useCallback(() => {
    syncApi
      .getStatus()
      .then(setSyncStatus)
      .catch(() => {});
  }, []);

  useEffect(() => refreshSyncStatus(), [refreshSyncStatus]);

  /** 同步按钮点击：立即一轮 commit+pull+push；失败不抛错，错误在返回状态的
   *  lastError 字段（按钮转红色调 + tooltip 展示） */
  const doSyncNow = useCallback(() => {
    if (syncing) return;
    setSyncing(true);
    syncApi
      .syncNow()
      .then(setSyncStatus)
      .catch(() => {})
      .finally(() => setSyncing(false));
  }, [syncing]);

  // 窗口焦点跟踪：激活时显示工具栏/加深阴影并尝试聚焦编辑器；失焦时收起色板与菜单
  useEffect(() => {
    const onFocus = () => {
      setActive(true);
      focusEditorIfIdle();
      refreshSyncStatus(); // 用户看它时才拉同步状态
      setNewNoteColor(readLastNoteColor()); // 其他窗口可能换过新建用色
    };
    const onBlur = () => {
      setActive(false);
      setPaletteOpen(false);
      setMenuOpen(false);
      setNewMenuOpen(false);
      setTagPanelOpen(false);
      setFolderPanelOpen(false);
      setGroupMenuOpen(false);
      setTitleMenuOpen(false);
      setExportMenuOpen(false);
      setConfirmDelete(false);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [focusEditorIfIdle, refreshSyncStatus]);

  /** 应用外部（磁盘）内容：同步三个 ref 使自动保存 effect 短路（不回写、无回环），
   *  setContent 驱动 UI，editorEpoch+1 触发 Editor key-remount 以磁盘内容重建——
   *  remount 走 defaultValue 初始化，不触发 listener 回声，也不会多写一次盘。
   *  代价是撤销历史清空（外部更新极少发生，可接受）；不主动 refocus，避免抢滚动 */
  const applyExternal = useCallback(
    (disk: string, diskTitle: string, diskManual: boolean, withToast: boolean) => {
      contentRef.current = disk;
      lastSavedRef.current = disk;
      dirtyRef.current = false;
      setContent(disk);
      setTitle(diskTitle); // 兜底标题顺手刷新（显示标题仍由 deriveTitle 实时推导）
      setTitleManual(diskManual); // 手动标题标志同样以磁盘为准（外部改 .md 后自愈）
      setExternalUpdate(null);
      setEditorEpoch((n) => n + 1);
      if (withToast) setToast(t('note.toastSynced'));
    },
    [t],
  );

  /** 冲突解决视图的「保存解决」：全量 upsert 落盘（与 autosave 同参数快照）。
   *  解决视图不走自动保存（草稿是 ConflictResolver 内部 state，不碰 content），
   *  只有这里显式保存；保存后 markers 消失 → hasConflict 转 false，
   *  editorEpoch+1 触发 Editor key-remount 切回 Milkdown */
  const saveResolution = useCallback(
    (text: string) => {
      setSaveState('saving');
      notesApi
        .save(noteId, { content: text, source: 'sticky', pin: pinned, color, tags, collapsed, folder: folderRef.current, zoom: zoomPct === ZOOM_DEFAULT ? 1 : zoomPct / 100 })
        .then((note) => {
          existsRef.current = true;
          lastSavedRef.current = note.content;
          contentRef.current = note.content;
          dirtyRef.current = false;
          setExternalUpdate(null);
          setTitle(note.title);
          setTitleManual(note.titleManual ?? false);
          setContent(note.content);
          setEditorEpoch((n) => n + 1);
          setSaveState('saved');
          setToast(t('note.toastResolved'));
          window.api.notifyNotesChanged(); // 广播：主界面列表近实时刷新
          // 内容已无冲突 markers：立即触发一轮 git 同步，不必等下个自动周期。
          // 异步静默触发，不阻塞保存反馈；失败不打扰（错误体现在设置抽屉同步状态的
          // lastError），拉回的新内容走现有 applyExternal/外部变更感知处理
          if (!hasConflictMarkers(note.content)) {
            void syncApi.syncNow().catch(() => {});
          }
        })
        .catch(() => setSaveState('error'));
    },
    [noteId, pinned, color, tags, collapsed, zoomPct, t],
  );

  // toast 轻提示 2.5s 自动消隐
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  // 外部变更感知：notes-changed 广播（含 vault watch 的外部变更）后拉取磁盘内容——
  // 404：被外部/主界面删除，关窗防止幽灵窗口把文件写回来（非 404 不关，避免服务重启误杀）；
  // 200：与 lastSavedRef 比较，一致说明是自己保存的回包/无实质变化，无操作；
  // 不一致时本地未脏 → 直接重载 + toast，本地脏 → 弹「载入最新/保留我的」横幅不抢编辑器
  useEffect(() => {
    const off = window.api.onNotesChanged(() => {
      if (!existsRef.current) return; // 未落盘的新便签没有文件可被删/改
      notesApi
        .get(noteId)
        .then((note) => {
          const disk = note.content;
          // disk === contentRef：自己保存的广播先于回包到达（磁盘即编辑器现值），同样无操作
          if (disk === lastSavedRef.current || disk === contentRef.current) return;
          if (dirtyRef.current) setExternalUpdate(disk);
          else applyExternal(disk, note.title, note.titleManual ?? false, true);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.message.startsWith('API 404')) {
            window.close();
          }
        });
    });
    return off;
  }, [noteId, applyExternal]);

  // 便签组态：挂载时主动拉取初始态（成员关窗组保留，重开回归恢复拼框），
  // 之后跟随主进程推送（成组/退组/角色变化）；成组预告高亮同通道订阅
  useEffect(() => {
    let alive = true;
    window.api
      .getGroupState(noteId)
      .then((s) => {
        if (alive) setGroupState(s);
      })
      .catch(() => {});
    const offState = window.api.onGroupState(setGroupState);
    const offHover = window.api.onGroupHover(setGroupHover);
    return () => {
      alive = false;
      offState();
      offHover();
    };
  }, [noteId]);

  // 加载笔记；404（首次创建的新便签）视为空白笔记
  useEffect(() => {
    notesApi
      .get(noteId)
      .then((note) => {
        existsRef.current = true;
        lastSavedRef.current = note.content;
        contentRef.current = note.content;
        setTitle(note.title);
        setTitleManual(note.titleManual ?? false);
        setContent(note.content);
        setPinned(note.pin);
        setCollapsed(note.collapsed ?? false);
        // 自愈重放：frontmatter 是折叠状态的真相源，winstate 只记几何。
        // 两边脱钩时（外部改 .md / 历史脏数据）按笔记数据矫正窗口；
        // 主进程有幂等保护，状态一致时是 no-op
        void window.api.setNoteCollapsed(noteId, note.collapsed ?? false);
        setColor(note.color || 'yellow');
        setTags(note.tags ?? []);
        // 内容缩放：frontmatter zoom 倍率 → 整数百分比（范围外收敛；缺省 = 100%）
        if (note.zoom && note.zoom > 0) {
          setZoomPct(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(note.zoom * 100))));
        }
        folderRef.current = note.folder ?? '';
        setFolder(note.folder ?? '');
      })
      .catch(() => {
        setTitle('');
        setTitleManual(false);
        contentRef.current = '';
        setContent('');
        // 新建便签：落盘文件夹来自窗口路由 query（主界面文件夹视图/便签＋菜单传入）；
        // 同步 folderRef——粘贴图片的 ../ 前缀深度从第一次粘贴起就是对的
        folderRef.current = initialFolder;
        setFolder(initialFolder);
      })
      .finally(() => {
        loadedRef.current = true;
        setSaveState('idle');
        // 加载完成后编辑器就绪即聚焦（窗口打开即可直接输入，内部带重试）
        focusEditorIfIdle();
      });
  }, [noteId, focusEditorIfIdle, initialFolder]);

  /** 显示用标题：手动标题取已保存值（不随正文变动）；否则实时跟随内容首行
   *  （与服务端同算法），兜底已保存标题，再兜底「新便签」 */
  const displayTitle = useMemo(
    () => (titleManual ? title : deriveTitle(content) || title) || t('note.newTitle'),
    [content, title, titleManual, t],
  );

  /** 冲突标记实时检测：随 content 派生，编辑删掉标记即消失（涵盖初始载入/外部重载/保存后）。
   *  true 时编辑区整换 ConflictResolver 原文解决视图（Milkdown 会把 markers 渲染成标题/引用），
   *  解决保存后 markers 消失，自动切回 Milkdown */
  const hasConflict = useMemo(() => hasConflictMarkers(content), [content]);

  // 便签内搜索：Ctrl+F 唤出搜索条、Ctrl+H 唤出并展开替换行（窗口内按键，
  // 与全局快捷键无交集：全局只有速记 Ctrl+Shift+N 与空白便签 Ctrl+Alt+N 系）。
  // 搜索条已打开时的聚焦/替换行聚焦由 FindBar 自己的窗口监听处理
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'f' && k !== 'h') return;
      if (collapsed || hasConflict) return; // 折叠/冲突解决（只读）态不开放搜索
      e.preventDefault();
      setFindOpen(true);
      if (k === 'h') setFindReplaceOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, hasConflict]);

  // 折叠/冲突态不支持搜索条：进入即关（渲染条件同步拦截，双保险）
  useEffect(() => {
    if ((collapsed || hasConflict) && findOpen) closeFindBar();
  }, [collapsed, hasConflict, findOpen, closeFindBar]);

  // 窗口标题同步便签标题（任务栏/Alt+Tab 可辨识）
  useEffect(() => {
    document.title = displayTitle;
  }, [displayTitle]);

  // 自动保存：加载完成后内容变化，防抖 1s upsert（tags 一并带上，
  // 保证「先打标签后写内容」的新便签首次落盘不丢标签）。
  // 守卫：空白新便签不落盘；内容未变化不回写。
  useEffect(() => {
    if (!loadedRef.current) return;
    if (!existsRef.current && !content.trim()) return;
    if (content === lastSavedRef.current) return;
    setSaveState('saving');
    const timer = setTimeout(() => {
      // folder 随保存带上：仅新建便签首次落盘生效（已存在便签服务端忽略，移动走 move）；
      // collapsed 一并带上（全量快照式 upsert，与 pin/color 同模式），折叠的新便签首次落盘不丢状态
      notesApi
        .save(noteId, { content, source: 'sticky', pin: pinned, color, tags, collapsed, folder: folderRef.current, zoom: zoomPct === ZOOM_DEFAULT ? 1 : zoomPct / 100 })
        .then((note) => {
          existsRef.current = true;
          lastSavedRef.current = note.content;
          // 防抖飞行期间用户又输入（contentRef 现值 ≠ 回包内容）则保持脏标志，
          // 只有编辑器现值与落盘一致才复位；落盘即最新，撤销外部修改横幅
          if (contentRef.current === note.content) dirtyRef.current = false;
          setExternalUpdate(null);
          setTitle(note.title);
          setTitleManual(note.titleManual ?? false);
          setSaveState('saved');
          window.api.notifyNotesChanged(); // 广播：主界面列表近实时刷新
        })
        .catch(() => setSaveState('error'));
    }, 1000);
    return () => clearTimeout(timer);
  }, [content, noteId, pinned, color, tags, collapsed, zoomPct]);

  // 标签增删：立即更新本地；已存在的笔记立即持久化，新便签随首次内容保存落盘
  const saveTags = useCallback(
    (next: string[]) => {
      setTags(next);
      if (existsRef.current) {
        notesApi.save(noteId, { tags: next }).catch(() => {});
      }
    },
    [noteId],
  );

  // 提交输入框中的标签（Enter 与 + 按钮共用）：trim 去重后追加
  const commitTag = useCallback(() => {
    const v = tagInput.trim();
    if (v && !tags.includes(v)) saveTags([...tags, v]);
    setTagInput('');
  }, [tagInput, tags, saveTags]);

  // 打开文件夹面板时拉取目录列表（候选全集来自服务端，天然限定 notes/ 内）
  useEffect(() => {
    if (!folderPanelOpen) return;
    foldersApi
      .list()
      .then(setAllFolders)
      .catch(() => setAllFolders([]));
  }, [folderPanelOpen]);

  // 移动本便签到目标文件夹：物理移文件，后续保存仍 Locate 到新位置
  const moveToFolder = useCallback(
    (target: string) => {
      if (target === folder) return;
      // 新便签尚未落盘（空内容不保存）：接口无文件可移会静默失败。
      // 改为本地暂存归属——首次内容保存随 folder 字段落盘（与标签同模式，
      // 同 initialFolder 从文件夹视图新建的落地路径）
      if (!existsRef.current) {
        folderRef.current = target;
        setFolder(target);
        setFolderPanelOpen(false);
        return;
      }
      notesApi
        .move(noteId, target)
        .then(() => {
          folderRef.current = target;
          setFolder(target);
          window.api.notifyNotesChanged();
          setFolderPanelOpen(false); // 迁移完成即收面板，避免用户误以为没生效
        })
        .catch(() => {});
    },
    [noteId, folder],
  );

  const handleChange = useCallback((markdown: string) => {
    contentRef.current = markdown;
    dirtyRef.current = true;
    lastEditAtRef.current = Date.now();
    setContent(markdown);
  }, []);

  /** 添加图像：系统选图 → 上传 vault attachments/ → 按当前文件夹深度补 ../ 前缀插入 */
  const pickImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 重置：允许重复选同一文件
    if (!file) return;
    void attachmentsApi
      .upload(file)
      .then((res) => {
        if (!res) return; // MIME 不在白名单（理论不会，accept 已限定 image/*）
        editorRef.current?.insertImages([
          { src: toMarkdownImageSrc(res.path, folderRef.current), alt: file.name },
        ]);
      })
      .catch(() => {});
  }, []);

  const hasFilePayload = useCallback(
    (transfer: DataTransfer) =>
      transfer.files.length > 0 ||
      Array.from(transfer.items).some((item) => item.kind === 'file') ||
      Array.from(transfer.types).includes('Files'),
    [],
  );

  const supportedDropFiles = useCallback(
    (transfer: DataTransfer) =>
      Array.from(transfer.files).filter((file) => SUPPORTED_IMAGE_MIME_TYPES.has(file.type)),
    [],
  );

  const hasSupportedDropItem = useCallback(
    (transfer: DataTransfer) =>
      Array.from(transfer.items).some(
        (item) => item.kind === 'file' && SUPPORTED_IMAGE_MIME_TYPES.has(item.type),
      ) || supportedDropFiles(transfer).length > 0,
    [supportedDropFiles],
  );

  const handleImageDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (collapsed || hasConflict || !hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      if (hasSupportedDropItem(e.dataTransfer)) setImageDragActive(true);
    },
    [collapsed, hasConflict, hasFilePayload, hasSupportedDropItem],
  );

  const handleImageDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (collapsed || hasConflict || !hasFilePayload(e.dataTransfer)) return;
      // 始终吞掉文件投放:不支持的文件不能让 Chromium 把页面导航走或把
      // 本地路径注入 contenteditable;只有受支持的图片显示 copy 投放反馈
      e.preventDefault();
      const supported = hasSupportedDropItem(e.dataTransfer);
      e.dataTransfer.dropEffect = supported ? 'copy' : 'none';
      setImageDragActive(supported);
    },
    [collapsed, hasConflict, hasFilePayload, hasSupportedDropItem],
  );

  const handleImageDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setImageDragActive(false);
  }, []);

  const handleImageDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      setImageDragActive(false);
      if (collapsed || hasConflict) return;
      const files = supportedDropFiles(e.dataTransfer);
      if (files.length === 0) return;
      const at = { left: e.clientX, top: e.clientY };
      void Promise.all(
        files.map(async (file) => {
          const uploaded = await attachmentsApi.upload(file).catch(() => null);
          return uploaded
            ? {
                src: toMarkdownImageSrc(uploaded.path, folderRef.current),
                alt: file.name,
              }
            : null;
        }),
      ).then((images) => {
        editorRef.current?.insertImages(
          images.filter((image): image is { src: string; alt: string } => image !== null),
          at,
        );
      });
    },
    [collapsed, hasConflict, hasFilePayload, supportedDropFiles],
  );

  /** 导出为图片：载荷取编辑器显示态 DOM（句柄 getHTML，含未落盘改动）+ 标题/颜色/标签；
   *  主进程开隐藏离屏窗渲染构图后截图，复制写剪贴板/另存弹对话框 */
  const doExport = useCallback(
    (action: 'copy' | 'save') => {
      if (exportBusy) return;
      const html = editorRef.current?.getHTML();
      if (html == null) return; // 编辑器未就绪：静默不导出（按钮随加载完成即可用）
      setExportBusy(true);
      setExportMenuOpen(false);
      setMenuOpen(false); // 从 ⋯ 菜单找回入口触发时同步收菜单
      window.api
        .exportNoteImage({ action, html, color: color || 'yellow', title: displayTitle, tags })
        .then((res) => {
          if (res.ok && !res.canceled && action === 'copy') {
            setExported(true);
            setTimeout(() => setExported(false), 1200);
          }
          if (!res.ok) console.error('[export] failed:', res.error);
        })
        .catch(() => {})
        .finally(() => setExportBusy(false));
    },
    [exportBusy, color, displayTitle, tags],
  );

  /** 复制全部正文到剪贴板；成功后图标短暂变 ✓ 反馈。
   *  输出紧凑 markdown（语法保留、块间单换行、有意空行保留），
   *  与 Ctrl+C、主界面列表「复制全部」同一口径（toCompactMarkdown） */
  const copyAll = useCallback(() => {
    const cleaned = toCompactMarkdown(content);
    void navigator.clipboard
      .writeText(cleaned)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [content]);

  // 置顶切换：窗口行为立即生效（IPC）。
  // 已存在的笔记立即持久化 pin；空白新便签只影响当前窗口，不落盘。
  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      void window.api.setNotePin(noteId, next);
      if (existsRef.current) {
        notesApi.save(noteId, { pin: next }).catch(() => {});
      }
      return next;
    });
  }, [noteId]);

  // 折叠/展开：渲染层 CSS transition 做高度动画（is-collapse-anim 挂 180ms），
  // 主进程只在动画首/尾提交一次窗口几何（根治逐帧 setBounds 的 DPI 累积漂移）；
  // collapsed 持久化到笔记数据（重启后渲染折叠 UI），新便签随首次内容保存落盘
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      void window.api.setNoteCollapsed(noteId, next);
      if (existsRef.current) {
        notesApi.save(noteId, { collapsed: next }).catch(() => {});
      }
      return next;
    });
    setCollapseAnim(true);
    setTimeout(() => setCollapseAnim(false), COLLAPSE_ANIM_MS);
    // 折叠时收起所有弹层（底部栏/面板随折叠卸载）
    setPaletteOpen(false);
    setMenuOpen(false);
    setNewMenuOpen(false);
    setTagPanelOpen(false);
    setFolderPanelOpen(false);
    setConfirmDelete(false);
  }, [noteId]);

  // 换色：立即应用；已存在的笔记立即持久化，新便签随首次内容保存落盘
  const changeColor = useCallback(
    (next: NoteColor) => {
      setColor(next);
      localStorage.setItem(LAST_NOTE_COLOR_KEY, next);
      setNewNoteColor(next); // 换色即成为新建用色（圆点与本便签同色后自然隐藏）
      setPaletteOpen(false);
      if (existsRef.current) {
        notesApi.save(noteId, { color: next }).catch(() => {});
      }
    },
    [noteId],
  );

  // 内容缩放步进：整数百分比 ±10（范围 50–200）；已存在的笔记立即持久化
  // （100% 时传 1，服务端删除 zoom 字段保持 frontmatter 干净），新便签随首次内容保存落盘
  const stepZoom = useCallback(
    (delta: number) => {
      setZoomPct((prev) => {
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev + delta));
        if (next === prev) return prev;
        if (existsRef.current) {
          notesApi
            .save(noteId, { zoom: next === ZOOM_DEFAULT ? 1 : next / 100 })
            .catch(() => {});
        }
        return next;
      });
    },
    [noteId],
  );

  // 删除：菜单内二次确认；空白新便签未落盘，直接关窗
  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (existsRef.current) {
      notesApi
        .remove(noteId)
        .then(() => window.api.notifyNotesChanged())
        .catch(() => {});
    }
    window.close();
  }, [confirmDelete, noteId]);

  // 点正文空白区（padding 边条、文本下方的 PM 空盒）时聚焦编辑器到文末。
  // 必须 preventDefault：mousedown 默认会把焦点移到被点元素上，把焦点从编辑器抢回去。
  const handleBodyMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 点在具体文本块（p/li/h1…）上：交给 ProseMirror 原生定位光标，不干预
    if (target.closest('.ProseMirror') && !target.classList.contains('ProseMirror')) return;
    e.preventDefault();
    editorRef.current?.focusEnd();
  }, []);

  // 卡片边缘/角落缩放：拖动按累计位移经 IPC 调整窗口尺寸（rAF 节流）
  // axis: 'x' 右边缘 / 'y' 底边缘 / 'both' 右下角；edge='left' 左边缘（右缘锚定）
  const startResize = useCallback(
    (e: React.PointerEvent, axis: 'x' | 'y' | 'both', edge?: 'left') => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.screenX;
      const startY = e.screenY;
      void window.api.noteResizeBegin(noteId);
      let raf = 0;
      const onMove = (ev: PointerEvent) => {
        const dx = axis === 'y' ? 0 : ev.screenX - startX;
        const dy = axis === 'x' ? 0 : ev.screenY - startY;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => void window.api.noteResize(noteId, dx, dy, edge));
      };
      const onUp = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        // 缩放结束：主进程做组内几何收敛（宽度统一/高度联动/归位）
        void window.api.noteResizeEnd(noteId);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [noteId],
  );

  // 组手柄拖动 = 整组移动：pointer capture 手动拖拽，IPC 发累计位移
  // （与角落缩放同模式：pointerdown 记起点、pointermove 发 dx/dy、pointerup 结算；
  // clientX/clientY 是 DIP，与主进程 setBounds 同单位）。松手后主进程对
  // 组包围盒做屏幕边缘吸附，命中则全员 animateTo 同步滑动落位
  const startGroupDrag = useCallback(
    // 泛型收窄到 HTMLButtonElement：currentTarget 才带 pointer 事件表（TS 约束）
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return; // 只响应左键（右键留给 P5 解散菜单）
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      setGroupDragging(true);
      void window.api.groupDragBegin(noteId);
      // 跟随由主进程轮询光标完成（clientX 相对窗口客户区，窗口一动 Chromium
      // 会反向补发 pointermove，位移信号自我振荡），渲染层只在松手时收尾
      const onUp = () => {
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        setGroupDragging(false);
        void window.api.groupDragEnd(noteId);
      };
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    [noteId],
  );

  /** 进入标题行内编辑（标题栏铅笔图标 → 菜单「重命名便签」）。
   *  未落盘的新便签也开放：提交时 upsert 直接建档（见 commitTitleRename）——
   *  「先起名再写内容」是直觉操作，禁用入口反直觉 */
  const startTitleRename = useCallback(() => {
    setTitleMenuOpen(false);
    setTitleRenaming(true);
  }, []);

  /** 标题行内编辑提交（Enter/blur）：客户端清洗文件系统非法字符
   *  （30 字截断由服务端统一）；Esc 置取消标记后 blur 走同一出口。
   *  新便签首次命名即落盘（PUT 幂等 upsert 部分更新，正文为空也建档） */
  const commitTitleRename = useCallback(
    (raw: string) => {
      setTitleRenaming(false);
      if (titleRenameCancelRef.current) {
        titleRenameCancelRef.current = false;
        return;
      }
      const v = raw.replace(/[\\/:*?"<>|]/g, '').trim();
      if (!v || v === displayTitle) return; // 空值/未改动 = no-op（幂等）
      notesApi
        .save(noteId, { title: v, titleManual: true })
        .then((note) => {
          existsRef.current = true; // upsert 已建档，后续内容保存走常规路径
          setTitle(note.title);
          setTitleManual(note.titleManual ?? true);
          window.api.notifyNotesChanged(); // 广播：主界面列表近实时刷新
        })
        .catch(() => {});
    },
    [noteId, displayTitle],
  );

  /** 恢复自动标题：服务端立即按当前正文重推导并重命名文件（所见即所得） */
  const restoreAutoTitle = useCallback(() => {
    setTitleMenuOpen(false);
    notesApi
      .save(noteId, { titleManual: false })
      .then((note) => {
        setTitle(note.title);
        setTitleManual(false);
        window.api.notifyNotesChanged();
      })
      .catch(() => {});
  }, [noteId]);

  const stateText: Record<SaveState, string> = {
    loading: t('note.stateLoading'),
    idle: '',
    saving: t('note.stateSaving'),
    saved: t('note.stateSaved'),
    error: t('note.stateError'),
  };

  /** 同步按钮派生态：仅「已配置且启用」时显示（未配置不渲染，不占工具栏宽度） */
  const syncConfigured = !!(syncStatus?.configured && syncStatus.enabled);
  /** 最后一次 git 同步的时间戳（零值/非法时间 = 0） */
  const lastSyncMs = (() => {
    if (!syncStatus?.lastSyncAt) return 0;
    const d = new Date(syncStatus.lastSyncAt);
    return !Number.isNaN(d.getTime()) && d.getFullYear() > 1 ? d.getTime() : 0;
  })();
  /** 未同步 = 本地与 git 不一致:上次同步之后有编辑(本地刚保存也算——
   *  磁盘内容已领先 git)/保存失败/有待推送提交 */
  const syncDirty =
    lastEditAtRef.current > lastSyncMs ||
    saveState === 'error' ||
    (syncStatus?.ahead ?? 0) > 0;
  const syncFailed = !syncing && !!syncStatus?.lastError;
  const syncTip = syncing
    ? t('note.syncTipSyncing')
    : syncFailed
      ? t('note.syncTipFailed')
      : syncDirty
        ? t('note.syncTipDirty')
        : t('note.syncTipSynced', { time: formatRelativeTime(t, syncStatus?.lastSyncAt) });

  /** 编辑辅助区按钮：用户自定义顺序（toolbarOrder）即展示顺序，展示上限 8 个
   *  （TOOLBAR_DISPLAY_LIMIT），宽度不够时从尾部藏起；收进 ⋯ 菜单的项按 id
   *  动态找回（见菜单渲染处，写死的 hiddenEdit≥1/≥2/≥3 阈值已退役）。
   *  mousedown preventDefault：不抢编辑器 DOM 焦点，命令作用于当前选区后可继续输入 */
  const zoomOutTip =
    zoomPct <= ZOOM_MIN ? t('note.zoomOutLimit') : t('note.zoomOut', { pct: zoomPct });
  const zoomInTip =
    zoomPct >= ZOOM_MAX ? t('note.zoomInLimit') : t('note.zoomIn', { pct: zoomPct });
  interface EditButtonDef {
    key: string;
    tip: string;
    icon: ReactNode;
    act: () => void;
    disabled: boolean;
  }
  /** id → 按钮定义映射表（定制顺序的单一来源）；新按钮在此登记后进默认顺序表 */
  const editButtonDefs: Record<string, EditButtonDef> = {
    bold: {
      key: 'bold',
      tip: t('note.tipBold'),
      icon: <TextBolderIcon />,
      act: () => editorRef.current?.toggleMark('strong'),
      disabled: false,
    },
    strike: {
      key: 'strike',
      tip: t('note.tipStrike'),
      icon: <TextStrikethroughIcon />,
      act: () => editorRef.current?.toggleMark('strikethrough'),
      disabled: false,
    },
    task: {
      key: 'task',
      tip: t('note.tipTask'),
      icon: <ListChecksIcon />,
      act: () => editorRef.current?.toggleTaskList(),
      disabled: false,
    },
    image: {
      key: 'image',
      tip: t('note.tipImage'),
      icon: <ImageIcon />,
      act: () => imageInputRef.current?.click(),
      disabled: false,
    },
    zoomIn: {
      key: 'zoomIn',
      tip: zoomInTip,
      icon: <MagnifyingGlassPlusIcon />,
      act: () => stepZoom(ZOOM_STEP),
      disabled: zoomPct >= ZOOM_MAX,
    },
    zoomOut: {
      key: 'zoomOut',
      tip: zoomOutTip,
      icon: <MagnifyingGlassMinusIcon />,
      act: () => stepZoom(-ZOOM_STEP),
      disabled: zoomPct <= ZOOM_MIN,
    },
    table: {
      key: 'table',
      tip: t('note.table.insert'),
      icon: <TableIcon />,
      act: () => editorRef.current?.insertTable(),
      disabled: false,
    },
    export: {
      // 导出为图片：不在可视集时两条目（复制为图片/另存为 PNG）在 ⋯ 菜单找回
      key: 'export',
      tip: exported ? t('note.copied') : t('note.exportImage'),
      icon: exported ? <CheckIcon /> : <ExportIcon />,
      act: () => {
        setPaletteOpen(false);
        setMenuOpen(false);
        setNewMenuOpen(false);
        setTagPanelOpen(false);
        setFolderPanelOpen(false);
        setConfirmDelete(false);
        setExportMenuOpen((v) => !v);
      },
      disabled: exportBusy,
    },
  };
  // 按用户顺序构建（toolbarOrder 已过 sanitize，id 全覆盖）；展示上限 8 个，
  // 宽度收敛（hiddenEdit）叠加在用户顺序上从尾部藏
  const orderedEditButtons = toolbarOrder
    .map((id) => editButtonDefs[id])
    .filter((b): b is EditButtonDef => !!b);
  const displayedEditButtons = orderedEditButtons.slice(0, TOOLBAR_DISPLAY_LIMIT);
  const visibleEditButtons = displayedEditButtons.slice(0, displayedEditButtons.length - hiddenEdit);
  /** 不在可视集的按钮（超出 8 位 + 被宽度收敛藏掉的尾部）：⋯ 菜单按 id 找回 */
  const overflowEditButtons = orderedEditButtons.filter((b) => !visibleEditButtons.includes(b));

  /** 文件夹面板的路径筛选结果（大小写不敏感子串） */
  const filteredFolders = useMemo(() => {
    const q = folderFilter.trim().toLowerCase();
    return q ? allFolders.filter((f) => f.toLowerCase().includes(q)) : allFolders;
  }, [allFolders, folderFilter]);

  const overlayOpen =
    paletteOpen || menuOpen || newMenuOpen || tagPanelOpen || folderPanelOpen || groupMenuOpen || titleMenuOpen || exportMenuOpen;

  return (
    <>
      {/* 组手柄：仅首位成员显示（组 ≥2 人）。卡片外的兄弟节点——组顶边
          中点的居中药丸（移动端抽屉 grabber 模式），按住拖动 = 整组移动
          （松手组包围盒做屏幕边缘吸附）；双击 = 行内改名 */}
      {/* 拼缝外框：每个成员画整组外轮廓的一段（首：上+左右；中：左右；
          尾：左右+下），纵向探出跨过 2px 缝隙拼成连续圆角外框。
          必须是卡片的兄弟节点（卡片 overflow:hidden，伪元素画不到卡片外） */}
      {groupState && groupState.role !== 'solo' && (
        <div
          className={`sticky-note__groupframe is-frame-${groupState.role}${groupHover ? ' is-hover' : ''}`}
        />
      )}
      {groupState?.role === 'first' &&
        (groupRenaming ? (
          /* 组名行内编辑：双击组手柄进入；Enter/blur 提交，Esc 取消。
             与手柄同位（顶边居中 fixed 药丸），宽度给足输入空间 */
          <input
            className="sticky-note__groupname-input"
            autoFocus
            defaultValue={groupState.name ?? ''}
            maxLength={30}
            placeholder={t('note.groupNamePlaceholder')}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              setGroupRenaming(false);
              if (groupRenameCancelRef.current) {
                groupRenameCancelRef.current = false;
                return;
              }
              const v = e.currentTarget.value.trim();
              if (v !== (groupState.name ?? '')) void window.api.groupRename(noteId, v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                groupRenameCancelRef.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          /* 组手柄：组顶边中点的居中药丸——按住拖动 = 整组移动
             （松手组包围盒做屏幕边缘吸附），双击 = 行内改名；
             未命名只显示 ⋮ 圆点，命名后药丸展开显示组名 */
          <button
            className={`sticky-note__grouphandle${groupDragging ? ' is-dragging' : ''}${groupState.name ? ' has-name' : ''}`}
            data-tip={
              groupState.name
                ? t('note.groupHandleTipNamed', { name: groupState.name })
                : t('note.groupHandleTip')
            }
            data-tip-wrap
            aria-label={t('note.groupDragAria')}
            onPointerDown={(e) => {
              setGroupMenuOpen(false); // 拖动起手即收菜单（左键拖动与右键菜单互斥）
              startGroupDrag(e);
            }}
            onDoubleClick={() => setGroupRenaming(true)}
            onContextMenu={(e) => {
              e.preventDefault();
              setGroupRenaming(false);
              setGroupMenuOpen((v) => !v);
            }}
          >
            <DotsSixVerticalIcon />
            {groupState.name && <span className="sticky-note__groupname">{groupState.name}</span>}
          </button>
        ))}
      <div
      ref={rootRef}
      className={`sticky-note${active ? ' is-active' : ''}${collapsed ? ' is-collapsed' : ''}${collapseAnim ? ' is-collapse-anim' : ''}${groupHover ? ' is-group-hover' : ''}${imageDragActive ? ' is-image-drag' : ''}${groupState && groupState.role !== 'solo' ? ` is-grouped is-group-${groupState.role}` : ''}`}
      data-color={color}
      onMouseDownCapture={() => setActive(true)} /* 兜底：点击即激活，不依赖 focus 事件 */
      onDragEnter={handleImageDragEnter}
      onDragOver={handleImageDragOver}
      onDragLeave={handleImageDragLeave}
      onDrop={handleImageDrop}
    >
      <div className="sticky-note__titlebar">
        {/* 顺序：置顶 - 标题 - 新建 - 颜色 - 折叠 - 关闭；data-tip 驱动 CSS tooltip；
            折叠态隐藏 新建/颜色，只留 置顶/折叠/关闭 */}
        <button
          className={`sticky-note__btn sticky-note__pin${pinned ? ' is-pinned' : ''}`}
          data-tip={pinned ? t('note.unpin') : t('note.pin')}
          data-tip-align="left"
          aria-label={pinned ? t('note.unpin') : t('note.pin')}
          onClick={togglePin}
        >
          <PinIcon />
        </button>
        {/* 重命名入口：标题前的实心下拉三角，点击弹标题菜单（重命名/恢复自动标题）。
            新便签同样开放——提交命名时 upsert 直接建档（先起名再写内容是直觉操作） */}
        {!collapsed && (
          <button
            className="sticky-note__btn"
            data-tip={t('note.renameNote')}
            aria-label={t('note.renameNote')}
            onClick={() => {
              setPaletteOpen(false);
              setMenuOpen(false);
              setNewMenuOpen(false);
              setTagPanelOpen(false);
              setFolderPanelOpen(false);
              setGroupMenuOpen(false);
              setConfirmDelete(false);
              setTitleMenuOpen((v) => !v);
            }}
          >
            <CaretDownFillIcon />
          </button>
        )}
        {/* 标题文字单独缩放（CSS zoom，Chromium 下排版自动重排）；
            标题栏按钮留在缩放元素外。
            标题留在 drag 带内随整栏拖窗；改名走标题前的下拉三角按钮弹出的菜单 */}
        {titleRenaming ? (
          <input
            className="sticky-note__title-input"
            style={{ zoom: zoomPct / 100 }}
            autoFocus
            defaultValue={displayTitle}
            placeholder={t('note.renamePlaceholder')}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commitTitleRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                titleRenameCancelRef.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="sticky-note__title" style={{ zoom: zoomPct / 100 }}>
            {displayTitle}
          </span>
        )}
        {/* 折叠态只留核心按钮：新建/颜色收起（底部栏已卸载，新建落点菜单无从依附）。
            右上角小圆点 = 当前新建用色（dot 浅色档，与本便签同色时不显示） */}
        {!collapsed && (
          <button
            className="sticky-note__btn sticky-note__createbtn"
            data-tip={t('header.create')}
            aria-label={t('header.create')}
            onClick={() => {
              if (!folder) {
                void window.api.createNote(); // 根目录便签：直接新建到根目录（默认操作）
                return;
              }
              // 子文件夹便签：弹落点选择（同文件夹 / 根目录）
              setPaletteOpen(false);
              setMenuOpen(false);
              setTagPanelOpen(false);
              setFolderPanelOpen(false);
              setConfirmDelete(false);
              setNewMenuOpen((v) => !v);
            }}
          >
            <PlusIcon />
            {newNoteColor !== color && (
              <span
                className="sticky-note__newdot"
                style={{ background: COLORS.find((c) => c.key === newNoteColor)?.dot }}
              />
            )}
          </button>
        )}
        {!collapsed && (
          <button
            className="sticky-note__btn sticky-note__color"
            data-tip={t('note.pickColor')}
            data-tip-align="right"
            aria-label={t('note.pickColor')}
            style={{ color: COLORS.find((c) => c.key === color)?.ink }}
            onClick={() => {
              setMenuOpen(false);
              setNewMenuOpen(false);
              setTagPanelOpen(false);
              setFolderPanelOpen(false);
              setPaletteOpen((v) => !v);
            }}
          >
            <SubtractFillIcon />
          </button>
        )}
        <button
          className="sticky-note__btn"
          data-tip={collapsed ? t('note.expand') : t('note.collapse')}
          data-tip-align="right"
          aria-label={collapsed ? t('note.expand') : t('note.collapse')}
          onClick={toggleCollapse}
        >
          {collapsed ? <CaretDownIcon /> : <CaretUpIcon />}
        </button>
        <button
          className="sticky-note__btn sticky-note__close"
          data-tip={t('note.close')}
          data-tip-align="right"
          aria-label={t('note.close')}
          onClick={() => window.close()}
        >
          <XIcon />
        </button>
      </div>

      {/* 外部修改横幅：本地脏期间磁盘被改，由用户选择载入最新或保留我的 */}
      {!collapsed && externalUpdate !== null && (
        <div className="sticky-note__banner sticky-note__banner--external">
          <ArrowsClockwiseIcon />
          <span>{t('note.externalBanner')}</span>
          <div className="sticky-note__banner-actions">
            <button
              className="sticky-note__banner-btn"
              onClick={() => applyExternal(externalUpdate, title, titleManual, false)}
            >
              {t('note.loadLatest')}
            </button>
            <button className="sticky-note__banner-btn" onClick={() => setExternalUpdate(null)}>
              {t('note.keepMine')}
            </button>
          </div>
        </div>
      )}

      {/* 冲突时整换原文解决视图（横幅+快捷按钮在组件内，不再进 Milkdown）；
          无冲突一切照旧：Milkdown 所见即所得 + 自动保存 */}
      {!collapsed &&
        (hasConflict ? (
          <ConflictResolver
            content={content}
            saving={saveState === 'saving'}
            onSave={saveResolution}
          />
        ) : (
          <div
            className="sticky-note__body"
            style={{ zoom: zoomPct / 100 }}
            onMouseDown={handleBodyMouseDown}
          >
            {saveState !== 'loading' && (
              <Editor
                key={editorEpoch}
                ref={editorRef}
                content={content}
                onChange={handleChange}
                mode="sticky"
                folder={folderRef.current}
              />
            )}
          </div>
        ))}

      {/* 便签内搜索条：编辑器区域顶部浮层（absolute，不占标题栏）。
          有外部修改横幅时 top 下移 26px 避让（横幅 ~26px 高）；折叠/冲突态不渲染 */}
      {!collapsed && !hasConflict && findOpen && (
        <FindBar
          editorRef={editorRef}
          replaceOpen={findReplaceOpen}
          topOffset={externalUpdate !== null ? 68 : 42}
          onToggleReplace={() => setFindReplaceOpen((v) => !v)}
          onOpenReplace={() => setFindReplaceOpen(true)}
          onClose={closeFindBar}
        />
      )}

      {/* 自动重载完成的轻提示（折叠态不弹） */}
      {!collapsed && toast && <div className="sticky-note__toast">{toast}</div>}

      {/* 透明捕获层：点击任意处收起色板/菜单 */}
      {overlayOpen && (
        <button
          className="sticky-note__backdrop"
          aria-label={t('note.dismiss')}
          onClick={() => {
            setPaletteOpen(false);
            setMenuOpen(false);
            setNewMenuOpen(false);
            setTagPanelOpen(false);
            setFolderPanelOpen(false);
            setGroupMenuOpen(false);
            setTitleMenuOpen(false);
            setExportMenuOpen(false);
            setConfirmDelete(false);
          }}
        />
      )}

      {/* ＋新建落点菜单：仅便签在子文件夹时弹出（标题栏下方） */}
      {newMenuOpen && folder && (
        <div className="sticky-note__menu sticky-note__menu--new">
          <button
            className="sticky-note__menu-item"
            title={folder}
            onClick={() => {
              setNewMenuOpen(false);
              void window.api.createNote(undefined, folder);
            }}
          >
            <FolderIcon />
            {t('note.newToFolder', { folder: shortenFolder(folder, 14) })}
          </button>
          <button
            className="sticky-note__menu-item"
            onClick={() => {
              setNewMenuOpen(false);
              void window.api.createNote();
            }}
          >
            <PlusIcon />
            {t('note.newToRoot')}
          </button>
        </div>
      )}

      {/* 颜色条：点 🎨 后从右向左依次弹出；当前色钉红色图钉（呼应 logo） */}
      <div className={`sticky-note__palette${paletteOpen ? ' is-open' : ''}`}>
        {COLORS.map((c, i) => (
          <button
            key={c.key}
            className={`sticky-note__palette-strip${color === c.key ? ' is-current' : ''}`}
            title={t(`color.${c.key}`)}
            style={
              {
                background: c.dot,
                '--d': `${(COLORS.length - 1 - i) * 35}ms`, // 最右先弹出
              } as CSSProperties
            }
            onClick={() => changeColor(c.key)}
          >
            <PinIcon />
          </button>
        ))}
      </div>

      {/* 底部工具栏：focus 时浮现。左 = 编辑辅助区（格式），右 = 分类区（标签/文件夹/
          保存状态/复制全部/⋯）；宽度不够时按优先级从低到高逐级藏，每区保底留内容。
          折叠态整个卸载（连同标签/文件夹面板与缩放热区） */}
      {!collapsed && (
        <div className="sticky-note__toolbar" ref={toolbarRef}>
        <div className="sticky-note__toolbar-zone">
          {visibleEditButtons.map((b) => (
            <button
              key={b.key}
              className="sticky-note__btn"
              data-tip={b.tip}
              data-tip-place="top"
              data-tip-align="left"
              aria-label={b.tip}
              disabled={b.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={b.act}
            >
              {b.icon}
            </button>
          ))}
        </div>
        <span className="sticky-note__toolbar-divider" />
        <div className="sticky-note__toolbar-zone sticky-note__toolbar-zone--right">
          <button
            className="sticky-note__btn sticky-note__tagbtn"
            data-tip={t('note.tags')}
            data-tip-place="top"
            data-tip-align="left"
            aria-label={t('note.tags')}
            /* 有标签时换 fill 款图标 + 便签主题色（ink），无标签保持线框灰 */
            style={
              tags.length > 0 ? { color: COLORS.find((c) => c.key === color)?.ink } : undefined
            }
            onClick={() => {
              setPaletteOpen(false);
              setMenuOpen(false);
              setNewMenuOpen(false);
              setFolderPanelOpen(false);
              setConfirmDelete(false);
              setTagPanelOpen((v) => !v);
            }}
          >
            {tags.length > 0 ? <TagFillIcon /> : <TagIcon />}
            {tags.length > 0 && <span className="sticky-note__tagcount">{tags.length}</span>}
          </button>
          <button
            className="sticky-note__btn"
            data-tip={
              folder ? t('note.folderTipWith', { folder: shortenFolder(folder, 24) }) : t('note.folderTip')
            }
            data-tip-place="top"
            data-tip-align="left"
            aria-label={t('note.folderTip')}
            /* 已在子文件夹中时换 fill 款图标 + 便签主题色（同标签按钮的两态逻辑） */
            style={folder ? { color: COLORS.find((c) => c.key === color)?.ink } : undefined}
            onClick={() => {
              setPaletteOpen(false);
              setMenuOpen(false);
              setNewMenuOpen(false);
              setTagPanelOpen(false);
              setConfirmDelete(false);
              setFolderPanelOpen((v) => !v);
            }}
          >
            {folder ? <FolderFillIcon /> : <FolderIcon />}
          </button>
          {/* 同步状态按钮：仅配置并启用 git 同步时渲染；四态（未同步线框/
              已同步深色底/同步中旋转/失败红色），与保存状态文字同档优先级 */}
          {hiddenAux < 2 && syncConfigured && (
            <button
              className={`sticky-note__btn sticky-note__syncbtn${
                syncing ? ' is-spinning' : syncFailed ? ' is-error' : syncDirty ? ' is-dirty' : ' is-synced'
              }`}
              /* 已同步态换便签主题色 ink 图标（同标签/文件夹按钮的两态逻辑） */
              style={
                !syncing && !syncFailed && !syncDirty
                  ? { color: COLORS.find((c) => c.key === color)?.ink }
                  : undefined
              }
              data-tip={syncTip}
              data-tip-place="top"
              data-tip-align="right"
              aria-label={t('note.syncNow')}
              onClick={doSyncNow}
            >
              {/* 同步失败换错误图标（fill 款）——仅红色着色在彩色便签上不显眼 */}
              {syncFailed ? <WarningCircleFillIcon /> : <ArrowsClockwiseIcon />}
            </button>
          )}
          {hiddenAux < 2 && (
            <span className="sticky-note__toolbar-state">{stateText[saveState]}</span>
          )}
          {hiddenAux < 1 && (
            <button
              className="sticky-note__btn"
              data-tip={copied ? t('note.copied') : t('note.copyAll')}
              data-tip-place="top"
              data-tip-align="right"
              aria-label={t('note.copyAll')}
              onClick={copyAll}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
          <button
            className="sticky-note__btn"
            data-tip={t('note.more')}
            data-tip-place="top"
            data-tip-align="right"
            aria-label={t('note.more')}
            onClick={() => {
              setPaletteOpen(false);
              setNewMenuOpen(false);
              setTagPanelOpen(false);
              setFolderPanelOpen(false);
              setConfirmDelete(false);
              setMenuOpen((v) => !v);
            }}
          >
            <DotsThreeIcon />
          </button>
        </div>
        </div>
      )}

      {/* 添加图像的隐藏文件选择器（工具栏按钮触发） */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={pickImage}
      />

      {/* 卡片边缘缩放热区：左缘 ↔ / 右缘 ↔ / 底缘 ↕ / 右下角 ↘（透明不可见，光标提示）。
          左缘与右缘对称贴卡片边缘——原生 OS 缩放边在透明阴影区上，手感不一致。
          折叠态不渲染（主进程同步禁了 resizable） */}
      {!collapsed && (
        <>
          <div
            className="sticky-note__edge sticky-note__edge--l"
            onPointerDown={(e) => startResize(e, 'x', 'left')}
          />
          <div
            className="sticky-note__edge sticky-note__edge--r"
            onPointerDown={(e) => startResize(e, 'x')}
          />
          <div
            className="sticky-note__edge sticky-note__edge--b"
            onPointerDown={(e) => startResize(e, 'y')}
          />
          <div
            className="sticky-note__grip"
            data-tip={t('note.resizeTip')}
            data-tip-place="top"
            data-tip-align="right"
            onPointerDown={(e) => startResize(e, 'both')}
          />
        </>
      )}

      {/* 标签面板：chips + 输入框，Enter/✓ 添加，Backspace 删尾 */}
      {tagPanelOpen && (
        <div className="sticky-note__tagpanel">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip">
              {tag}
              <button
                className="tag-chip__x"
                aria-label={t('note.removeTagAria', { tag })}
                onClick={() => saveTags(tags.filter((x) => x !== tag))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="sticky-note__taginput"
            value={tagInput}
            placeholder={t('note.addTagPlaceholder')}
            autoFocus
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitTag();
              } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
                saveTags(tags.slice(0, -1));
              } else if (e.key === 'Escape') {
                setTagPanelOpen(false);
              }
            }}
          />
          <button
            className="sticky-note__tagadd"
            data-tip={t('note.addTag')}
            data-tip-place="top"
            data-tip-align="right"
            aria-label={t('note.addTagAria')}
            disabled={!tagInput.trim()}
            onClick={commitTag}
          >
            <PlusIcon />
          </button>
        </div>
      )}

      {/* 文件夹面板：当前位置 + 打开目录 + 更改归属（候选仅 notes/ 内） */}
      {folderPanelOpen && (
        <div className="sticky-note__folderpanel">
          <div className="sticky-note__folderpath" title={`notes/${folder}`}>
            <FolderIcon />
            <span className="sticky-note__folderpath-text">
              notes/{folder ? shortenFolder(folder, 20) : ''}
              {!folder && (
                <span className="sticky-note__folderpath-root">{t('note.rootSuffix')}</span>
              )}
            </span>
            <button
              className="sticky-note__folderopen"
              onClick={() => void window.api.openNoteFolder(folder)}
            >
              {t('note.openFolderBtn')}
            </button>
          </div>
          <div className="sticky-note__folderlist-title">{t('note.moveToFolder')}</div>
          {/* 路径筛选：目录多的时候快速定位；大小写不敏感子串匹配 */}
          {allFolders.length > 5 && (
            <input
              className="sticky-note__folderfilter"
              value={folderFilter}
              placeholder={t('move.filter')}
              onChange={(e) => setFolderFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFolderPanelOpen(false);
              }}
            />
          )}
          <div className="sticky-note__folderlist">
            {(!folderFilter.trim() || t('folders.rootShort').includes(folderFilter.trim())) && (
              <button
                className={`sticky-note__folderitem${folder === '' ? ' is-current' : ''}`}
                disabled={folder === ''}
                onClick={() => moveToFolder('')}
              >
                {t('folders.rootShort')}
              </button>
            )}
            {filteredFolders.map((f) => (
              <button
                key={f}
                className={`sticky-note__folderitem${folder === f ? ' is-current' : ''}`}
                disabled={folder === f}
                title={f}
                onClick={() => moveToFolder(f)}
              >
                {shortenFolder(f, 22)}
              </button>
            ))}
            {allFolders.length === 0 && (
              <div className="sticky-note__folderempty">{t('note.noSubfolders')}</div>
            )}
            {allFolders.length > 0 && filteredFolders.length === 0 && (
              <div className="sticky-note__folderempty">
                {t('move.noMatch', { query: folderFilter.trim() })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 导出为图片菜单(工具栏导出按钮触发;左对齐锚定编辑区) */}
      {exportMenuOpen && (
        <div className="sticky-note__menu sticky-note__menu--export">
          <button
            className="sticky-note__menu-item"
            disabled={exportBusy}
            onClick={() => doExport('copy')}
          >
            <CopyIcon />
            {t('note.exportCopy')}
          </button>
          <button
            className="sticky-note__menu-item"
            disabled={exportBusy}
            onClick={() => doExport('save')}
          >
            <FloppyDiskIcon />
            {t('note.exportSave')}
          </button>
        </div>
      )}

      {/* ⋯ 菜单（不在可视集的按钮在这里按 id 动态找回：超出展示上限 8 个的
          位次 + 被宽度收敛藏掉的尾部；导出保持「复制为图片/另存为 PNG」
          两条目特殊形态，缩放的百分比/上限态文案照旧） */}
      {menuOpen && (
        <div className="sticky-note__menu">
          {overflowEditButtons.map((b) => {
            if (b.key === 'export') {
              return (
                <Fragment key="export">
                  <button
                    className="sticky-note__menu-item"
                    disabled={exportBusy}
                    onClick={() => doExport('copy')}
                  >
                    <CopyIcon />
                    {t('note.exportCopy')}
                  </button>
                  <button
                    className="sticky-note__menu-item"
                    disabled={exportBusy}
                    onClick={() => doExport('save')}
                  >
                    <FloppyDiskIcon />
                    {t('note.exportSave')}
                  </button>
                </Fragment>
              );
            }
            // 缩放按钮：不收菜单（可连击调倍率），百分比/上限态文案照旧
            if (b.key === 'zoomIn' || b.key === 'zoomOut') {
              return (
                <button
                  key={b.key}
                  className="sticky-note__menu-item"
                  disabled={b.disabled}
                  onClick={b.act}
                >
                  {b.icon}
                  {b.tip}
                </button>
              );
            }
            return (
              <button
                key={b.key}
                className="sticky-note__menu-item"
                disabled={b.disabled}
                onClick={() => {
                  setMenuOpen(false);
                  b.act();
                }}
              >
                {b.icon}
                {b.tip}
              </button>
            );
          })}
          <button
            className="sticky-note__menu-item"
            onClick={() => {
              setMenuOpen(false);
              void window.api.showMainWindow();
            }}
          >
            <ListBulletsIcon />
            {t('note.noteList')}
          </button>
          <button
            className={`sticky-note__menu-item${confirmDelete ? ' is-danger' : ''}`}
            onClick={handleDelete}
          >
            <TrashIcon />
            {confirmDelete ? t('note.deleteConfirm') : t('note.deleteNote')}
          </button>
        </div>
      )}

      {/* 组手柄右键菜单：解散此组（全员退组、位置原地不动）。渲染在卡片
          内部（与 ⋯/＋菜单同模式）——fixed 放卡片外会被标题栏 drag 区
          吞掉文字区命中（2026-07-21 热区事故） */}
      {groupMenuOpen && groupState?.role === 'first' && (
        <div className="sticky-note__menu sticky-note__menu--group">
          <button
            className="sticky-note__menu-item is-danger"
            onClick={() => {
              setGroupMenuOpen(false);
              void window.api.groupDissolve(noteId);
            }}
          >
            <LinkBreakIcon />
            {t('note.dissolveGroup')}
          </button>
        </div>
      )}

      {/* 标题菜单（铅笔图标按钮触发）：重命名便签（未落盘新便签按钮禁用）；
          title_manual 时追加「恢复自动标题」。渲染在卡片内部，
          需 -webkit-app-region: no-drag（同 menu--group 的热区教训） */}
      {titleMenuOpen && (
        <div className="sticky-note__menu sticky-note__menu--title">
          <button className="sticky-note__menu-item" onClick={startTitleRename}>
            <PencilSimpleIcon />
            {t('note.renameNote')}
          </button>
          {titleManual && (
            <button className="sticky-note__menu-item" onClick={restoreAutoTitle}>
              <ArrowCounterClockwiseIcon />
              {t('note.restoreAutoTitle')}
            </button>
          )}
        </div>
      )}
      </div>
    </>
  );
}

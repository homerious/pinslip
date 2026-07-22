import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import PlusIcon from '~icons/ph/plus';
import XIcon from '~icons/ph/x';
import CaretUpIcon from '~icons/ph/caret-up';
import CaretDownIcon from '~icons/ph/caret-down';
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
import CopyIcon from '~icons/ph/copy';
import CheckIcon from '~icons/ph/check';
import PinIcon from '../components/icons/PinIcon';
import Editor from '../components/editor/Editor';
import type { EditorHandle } from '../components/editor/Editor';
import { toMarkdownImageSrc } from '../components/editor/image-support';
import { attachmentsApi } from '../api/attachments';
import { foldersApi, notesApi } from '../api/notes';
import { shortenFolder } from '../utils/path';
import { COLLAPSE_ANIM_MS } from '@shared/anim';
import type { GroupState, NoteColor } from '@shared/types';

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

/** 六色定义：dot = 标题栏色；ink = 同色加深版（颜色按钮图标着色，
 *  直接用标题栏本色会在同色标题栏上隐身，故用 600 档深色） */
const COLORS: { key: Exclude<NoteColor, ''>; label: string; dot: string; ink: string }[] = [
  { key: 'yellow', label: '黄', dot: '#ffe97a', ink: '#f9a825' },
  { key: 'pink', label: '粉', dot: '#f48fb1', ink: '#d81b60' },
  { key: 'green', label: '绿', dot: '#a5d6a7', ink: '#43a047' },
  { key: 'blue', label: '蓝', dot: '#90caf9', ink: '#1e88e5' },
  { key: 'purple', label: '紫', dot: '#ce93d8', ink: '#8e24aa' },
  { key: 'orange', label: '橙', dot: '#ffcc80', ink: '#fb8c00' },
];

/** 便签窗口视图：无边框窗内的编辑界面；
 *  标题栏承载 新建/颜色/置顶/关闭，底部工具栏（focus 浮现）承载 ⋯菜单/保存状态 */
export default function NoteView() {
  const { noteId = '' } = useParams<{ noteId: string }>();
  const [searchParams] = useSearchParams();
  /** 新建便签的落盘文件夹（窗口创建时经路由 query 下发；已存在便签忽略，以 note.folder 为准） */
  const initialFolder = searchParams.get('folder') ?? '';
  const [title, setTitle] = useState('新便签');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(true); // 新便签默认置顶
  const [collapsed, setCollapsed] = useState(false); // 折叠成标题条（只显示标题栏）
  /** 折叠/展开的 CSS 高度过渡只在切换瞬间挂（180ms），平时拖拽改尺寸不挂 transition 防滞后 */
  const [collapseAnim, setCollapseAnim] = useState(false);
  const [color, setColor] = useState<NoteColor>('yellow');
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** ＋新建落点菜单（便签在子文件夹时才有：同文件夹 / 根目录） */
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 窗口是否激活（跟随 OS 焦点，比 :focus-within 可靠——点面板任意处都算） */
  const [active, setActive] = useState(() => document.hasFocus());
  /** 工具栏优先级隐藏：编辑区从低优先级藏起的按钮数（0..3，保底留「加粗」） */
  const [hiddenEdit, setHiddenEdit] = useState(0);
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
  /** 组名编辑中（组标签手柄双击进入）；Esc 置取消标记，blur 提交 */
  const [groupRenaming, setGroupRenaming] = useState(false);
  /** 组手柄右键菜单（解散此组） */
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const groupRenameCancelRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);
  const loadedRef = useRef(false);
  const existsRef = useRef(false); // 是否已存在于服务端（新便签写了内容才落盘）
  const lastSavedRef = useRef(''); // 上次保存的内容，避免加载后多余回写
  const folderRef = useRef(''); // 笔记所在子文件夹（图片 ../ 前缀深度）

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

  // 文件夹面板关闭时清空路径筛选（下次打开回到全量列表）
  useEffect(() => {
    if (!folderPanelOpen) setFolderFilter('');
  }, [folderPanelOpen]);

  // 窗口焦点跟踪：激活时显示工具栏/加深阴影并尝试聚焦编辑器；失焦时收起色板与菜单
  useEffect(() => {
    const onFocus = () => {
      setActive(true);
      focusEditorIfIdle();
    };
    const onBlur = () => {
      setActive(false);
      setPaletteOpen(false);
      setMenuOpen(false);
      setNewMenuOpen(false);
      setTagPanelOpen(false);
      setFolderPanelOpen(false);
      setConfirmDelete(false);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [focusEditorIfIdle]);

  // 外部删除自闭：notes-changed 广播（含 vault watch 的外部变更）后自检文件
  // 是否还在——404 说明被外部/主界面删除，关窗防止幽灵窗口把文件写回来；
  // 服务异常等非 404 错误不关，避免 Go 服务重启时误杀所有窗口
  useEffect(() => {
    const off = window.api.onNotesChanged(() => {
      if (!existsRef.current) return; // 未落盘的新便签没有文件可被删
      notesApi.get(noteId).catch((err: unknown) => {
        if (err instanceof Error && err.message.startsWith('API 404')) {
          window.close();
        }
      });
    });
    return off;
  }, [noteId]);

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
        setTitle(note.title);
        setContent(note.content);
        setPinned(note.pin);
        setCollapsed(note.collapsed ?? false);
        // 自愈重放：frontmatter 是折叠状态的真相源，winstate 只记几何。
        // 两边脱钩时（外部改 .md / 历史脏数据）按笔记数据矫正窗口；
        // 主进程有幂等保护，状态一致时是 no-op
        void window.api.setNoteCollapsed(noteId, note.collapsed ?? false);
        setColor(note.color || 'yellow');
        setTags(note.tags ?? []);
        folderRef.current = note.folder ?? '';
        setFolder(note.folder ?? '');
      })
      .catch(() => {
        setTitle('新便签');
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

  /** 显示用标题：实时跟随内容首行（与服务端同算法），兜底已保存标题 */
  const displayTitle = useMemo(() => deriveTitle(content) || title, [content, title]);

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
        .save(noteId, { content, source: 'sticky', pin: pinned, color, tags, collapsed, folder: folderRef.current })
        .then((note) => {
          existsRef.current = true;
          lastSavedRef.current = note.content;
          setTitle(note.title);
          setSaveState('saved');
          window.api.notifyNotesChanged(); // 广播：主界面列表近实时刷新
        })
        .catch(() => setSaveState('error'));
    }, 1000);
    return () => clearTimeout(timer);
  }, [content, noteId, pinned, color, tags, collapsed]);

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
        editorRef.current?.insertImage(toMarkdownImageSrc(res.path, folderRef.current));
      })
      .catch(() => {});
  }, []);

  /** 复制全部正文到剪贴板；成功后图标短暂变 ✓ 反馈 */
  const copyAll = useCallback(() => {
    void navigator.clipboard
      .writeText(content)
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
      setPaletteOpen(false);
      if (existsRef.current) {
        notesApi.save(noteId, { color: next }).catch(() => {});
      }
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
  // axis: 'x' 右边缘 / 'y' 底边缘 / 'both' 右下角
  const startResize = useCallback(
    (e: React.PointerEvent, axis: 'x' | 'y' | 'both') => {
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
        raf = requestAnimationFrame(() => void window.api.noteResize(noteId, dx, dy));
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

  const stateText: Record<SaveState, string> = {
    loading: '加载中',
    idle: '',
    saving: '保存中…',
    saved: '已保存',
    error: '保存失败',
  };

  /** 编辑辅助区按钮：数组顺序即优先级（高 → 低），宽度不够时从尾部藏起，保底留加粗。
   *  mousedown preventDefault：不抢编辑器 DOM 焦点，命令作用于当前选区后可继续输入 */
  const editButtons = [
    {
      key: 'bold',
      tip: '加粗',
      icon: <TextBolderIcon />,
      act: () => editorRef.current?.toggleMark('strong'),
    },
    {
      key: 'strike',
      tip: '删除线',
      icon: <TextStrikethroughIcon />,
      act: () => editorRef.current?.toggleMark('strikethrough'),
    },
    {
      key: 'task',
      tip: '任务列表',
      icon: <ListChecksIcon />,
      act: () => editorRef.current?.toggleTaskList(),
    },
    {
      key: 'image',
      tip: '添加图像',
      icon: <ImageIcon />,
      act: () => imageInputRef.current?.click(),
    },
  ] as const;
  const visibleEditButtons = editButtons.slice(0, editButtons.length - hiddenEdit);

  /** 文件夹面板的路径筛选结果（大小写不敏感子串） */
  const filteredFolders = useMemo(() => {
    const q = folderFilter.trim().toLowerCase();
    return q ? allFolders.filter((f) => f.toLowerCase().includes(q)) : allFolders;
  }, [allFolders, folderFilter]);

  const overlayOpen =
    paletteOpen || menuOpen || newMenuOpen || tagPanelOpen || folderPanelOpen || groupMenuOpen;

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
            placeholder="组名"
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
            data-tip={groupState.name ? `组「${groupState.name}」· 拖动整组 · 双击改名 · 右键菜单` : '拖动整组 · 双击命名 · 右键菜单'}
            data-tip-align="left"
            aria-label="拖动整组"
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
      className={`sticky-note${active ? ' is-active' : ''}${collapsed ? ' is-collapsed' : ''}${collapseAnim ? ' is-collapse-anim' : ''}${groupHover ? ' is-group-hover' : ''}${groupState && groupState.role !== 'solo' ? ` is-grouped is-group-${groupState.role}` : ''}`}
      data-color={color}
      onMouseDownCapture={() => setActive(true)} /* 兜底：点击即激活，不依赖 focus 事件 */
    >
      <div className="sticky-note__titlebar">
        {/* 顺序：置顶 - 标题 - 新建 - 颜色 - 折叠 - 关闭；data-tip 驱动 CSS tooltip；
            折叠态隐藏 新建/颜色，只留 置顶/折叠/关闭 */}
        <button
          className={`sticky-note__btn sticky-note__pin${pinned ? ' is-pinned' : ''}`}
          data-tip={pinned ? '取消置顶' : '置顶'}
          data-tip-align="left"
          aria-label={pinned ? '取消置顶' : '置顶'}
          onClick={togglePin}
        >
          <PinIcon />
        </button>
        <span className="sticky-note__title">{displayTitle}</span>
        {/* 折叠态只留核心按钮：新建/颜色收起（底部栏已卸载，新建落点菜单无从依附） */}
        {!collapsed && (
          <button
            className="sticky-note__btn"
            data-tip="新建便签"
            aria-label="新建便签"
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
          </button>
        )}
        {!collapsed && (
          <button
            className="sticky-note__btn sticky-note__color"
            data-tip="选择颜色"
            data-tip-align="right"
            aria-label="选择颜色"
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
          data-tip={collapsed ? '展开便签' : '收起便签'}
          data-tip-align="right"
          aria-label={collapsed ? '展开便签' : '收起便签'}
          onClick={toggleCollapse}
        >
          {collapsed ? <CaretDownIcon /> : <CaretUpIcon />}
        </button>
        <button
          className="sticky-note__btn sticky-note__close"
          data-tip="关闭"
          data-tip-align="right"
          aria-label="关闭"
          onClick={() => window.close()}
        >
          <XIcon />
        </button>
      </div>

      {!collapsed && (
        <div className="sticky-note__body" onMouseDown={handleBodyMouseDown}>
          {saveState !== 'loading' && (
            <Editor
              ref={editorRef}
              content={content}
              onChange={handleChange}
              mode="sticky"
              folder={folderRef.current}
            />
          )}
        </div>
      )}

      {/* 透明捕获层：点击任意处收起色板/菜单 */}
      {overlayOpen && (
        <button
          className="sticky-note__backdrop"
          aria-label="收起"
          onClick={() => {
            setPaletteOpen(false);
            setMenuOpen(false);
            setNewMenuOpen(false);
            setTagPanelOpen(false);
            setFolderPanelOpen(false);
            setGroupMenuOpen(false);
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
            新建到 {shortenFolder(folder, 14)}
          </button>
          <button
            className="sticky-note__menu-item"
            onClick={() => {
              setNewMenuOpen(false);
              void window.api.createNote();
            }}
          >
            <PlusIcon />
            新建到根目录
          </button>
        </div>
      )}

      {/* 颜色条：点 🎨 后从右向左依次弹出；当前色钉红色图钉（呼应 logo） */}
      <div className={`sticky-note__palette${paletteOpen ? ' is-open' : ''}`}>
        {COLORS.map((c, i) => (
          <button
            key={c.key}
            className={`sticky-note__palette-strip${color === c.key ? ' is-current' : ''}`}
            title={c.label}
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
            data-tip="标签"
            data-tip-place="top"
            data-tip-align="left"
            aria-label="标签"
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
            data-tip={folder ? `文件夹：${shortenFolder(folder, 24)}` : '文件夹'}
            data-tip-place="top"
            data-tip-align="left"
            aria-label="文件夹"
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
          {hiddenAux < 2 && (
            <span className="sticky-note__toolbar-state">{stateText[saveState]}</span>
          )}
          {hiddenAux < 1 && (
            <button
              className="sticky-note__btn"
              data-tip={copied ? '已复制' : '复制全部'}
              data-tip-place="top"
              data-tip-align="right"
              aria-label="复制全部"
              onClick={copyAll}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
          <button
            className="sticky-note__btn"
            data-tip="更多"
            data-tip-place="top"
            data-tip-align="right"
            aria-label="更多"
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
        accept="image/*"
        hidden
        onChange={pickImage}
      />

      {/* 卡片边缘缩放热区：右缘 ↔ / 底缘 ↕ / 右下角 ↘（透明不可见，光标提示）。
          折叠态不渲染（主进程同步禁了 resizable） */}
      {!collapsed && (
        <>
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
            data-tip="拖拽调整大小"
            data-tip-place="top"
            data-tip-align="right"
            onPointerDown={(e) => startResize(e, 'both')}
          />
        </>
      )}

      {/* 标签面板：chips + 输入框，Enter/✓ 添加，Backspace 删尾 */}
      {tagPanelOpen && (
        <div className="sticky-note__tagpanel">
          {tags.map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button
                className="tag-chip__x"
                aria-label={`移除标签 ${t}`}
                onClick={() => saveTags(tags.filter((x) => x !== t))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="sticky-note__taginput"
            value={tagInput}
            placeholder="添加标签…"
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
            data-tip="添加"
            data-tip-place="top"
            data-tip-align="right"
            aria-label="添加标签"
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
              {!folder && <span className="sticky-note__folderpath-root">（根目录）</span>}
            </span>
            <button
              className="sticky-note__folderopen"
              onClick={() => void window.api.openNoteFolder(folder)}
            >
              打开目录
            </button>
          </div>
          <div className="sticky-note__folderlist-title">移动到文件夹</div>
          {/* 路径筛选：目录多的时候快速定位；大小写不敏感子串匹配 */}
          {allFolders.length > 5 && (
            <input
              className="sticky-note__folderfilter"
              value={folderFilter}
              placeholder="搜索目录"
              onChange={(e) => setFolderFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFolderPanelOpen(false);
              }}
            />
          )}
          <div className="sticky-note__folderlist">
            {(!folderFilter.trim() || '根目录'.includes(folderFilter.trim())) && (
              <button
                className={`sticky-note__folderitem${folder === '' ? ' is-current' : ''}`}
                disabled={folder === ''}
                onClick={() => moveToFolder('')}
              >
                根目录
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
              <div className="sticky-note__folderempty">还没有子文件夹，去主界面创建</div>
            )}
            {allFolders.length > 0 && filteredFolders.length === 0 && (
              <div className="sticky-note__folderempty">没有匹配「{folderFilter.trim()}」的目录</div>
            )}
          </div>
        </div>
      )}

      {/* ⋯ 菜单 */}
      {menuOpen && (
        <div className="sticky-note__menu">
          <button
            className="sticky-note__menu-item"
            onClick={() => {
              setMenuOpen(false);
              void window.api.showMainWindow();
            }}
          >
            <ListBulletsIcon />
            便签列表
          </button>
          <button
            className={`sticky-note__menu-item${confirmDelete ? ' is-danger' : ''}`}
            onClick={handleDelete}
          >
            <TrashIcon />
            {confirmDelete ? '确认删除？' : '删除便签'}
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
            解散此组
          </button>
        </div>
      )}
      </div>
    </>
  );
}

import { forwardRef, useImperativeHandle } from 'react';
import {
  commandsCtx,
  defaultValueCtx,
  Editor as MilkdownCore,
  editorViewCtx,
  editorViewOptionsCtx,
  marksCtx,
  nodeViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  schemaCtx,
  serializerCtx,
} from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import {
  commonmark,
  toggleStrongCommand,
  wrapInBulletListCommand,
} from '@milkdown/preset-commonmark';
import { gfm, insertTableCommand, toggleStrikethroughCommand } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { nord } from '@milkdown/theme-nord';
import { $prose } from '@milkdown/utils';
import {
  SearchQuery,
  findNext as pmFindNext,
  findPrev as pmFindPrev,
  getSearchState,
  replaceAll as pmReplaceAll,
  replaceNext as pmReplaceNext,
  search as pmSearch,
  setSearchState,
} from 'prosemirror-search';
// 命令签名从真实命令推导（pnpm 严格隔离下跨包 type-only import prosemirror-state 也不可用）：
// findNext/findPrev/replaceNext/replaceAll 同一 Command 签名
type PmSearchCommand = typeof pmFindNext;
import { createTaskCapableListItemView } from './task-item-view';
import { createImageView, handleImageDrop, handleImagePaste } from './image-support';
import { toCompactMarkdown } from '../../utils/compact-markdown';
import TableBar from './table-bar';

/** prosemirror-search 官方插件（命中装饰 + find/replace 命令）：
 *  $prose 包装成 Milkdown 插件挂链，与 nodeViewCtx 直注同层机制，不动现有插件结构 */
const pmSearchPlugin = $prose(() => pmSearch());

/** 行内样式改非包容（inclusive: false）：Milkdown 的 strong/emphasis/inlineCode/
 *  link/strike_through 全部默认 inclusive（连 link 都是），光标停在样式文本
 *  边界外继续输入会继承样式，粘贴带格式文本后尤为困扰。
 *  改非包容后：边界外输入一律纯文本（对齐 Obsidian/Typora 手感）；边界内部
 *  （前后同一样式）仍继承；工具栏/快捷键显式 toggle 走 storedMarks，不受影响。 */
const NON_INCLUSIVE_MARKS = new Set(['strong', 'emphasis', 'inlineCode', 'link', 'strike_through']);

/** 粘贴后清 storedMarks：PM 粘贴默认把片尾样式设为待用样式，粘贴完原地继续
 *  输入会无视 inclusive 直接套用——清掉后样式完全由边界位置决定（配合上面的
 *  非包容样式 = 纯文本）。无文档变更，不触发 markdownUpdated/保存。 */
const pasteClearMarksPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('pinslip-paste-clear-marks'),
      appendTransaction: (transactions, _prev, next) => {
        if (!next.storedMarks) return null;
        if (!transactions.some((tr) => tr.getMeta('paste'))) return null;
        return next.tr.setStoredMarks(null);
      },
    }),
);

export interface EditorProps {
  /** 初始 Markdown 内容（仅初始化时使用一次） */
  content: string;
  /** 内容变化回调（Markdown 文本） */
  onChange: (markdown: string) => void;
  /** sticky = 便签小窗模式，full = 完整编辑模式 */
  mode?: 'sticky' | 'full';
  /** 笔记所在子文件夹（notes/ 相对路径）：粘贴图片时按深度生成 ../ 前缀 */
  folder?: string;
}

/** clipboardTextSerializer 参数的最小结构类型（避免仅为类型引入 prosemirror 值依赖） */
interface ClipboardSliceLike {
  content: {
    size: number;
    textBetween(from: number, to: number, blockSeparator?: string): string;
  };
}

/** 搜索状态快照：total = 命中总数；active = 当前命中序号（1 起；0 = 无当前命中） */
export interface FindStatus {
  total: number;
  active: number;
}

/** 统计当前 query 的命中总数与「选区恰为某命中」的序号（prosemirror-search 的
 *  当前命中装饰以选区与命中区间完全重合判定，这里保持同一口径） */
function countFindMatches(view: { state: Parameters<typeof getSearchState>[0] }): FindStatus {
  const st = getSearchState(view.state);
  if (!st || !st.query.valid) return { total: 0, active: 0 };
  const { from, to } = view.state.selection;
  let total = 0;
  let active = 0;
  let pos = 0;
  for (;;) {
    const r = st.query.findNext(view.state, pos);
    if (!r) break;
    total += 1;
    if (r.from === from && r.to === to) active = total;
    pos = Math.max(r.to, pos + 1); // 防零长命中死循环（与包内装饰构建同手法）
  }
  return { total, active };
}

/** 把当前选区（命中）滚进可视区：PM 的 scrollToSelection 要求 DOM 选区在编辑器内，
 *  焦点在搜索框时它空转（domSelectionRange 不在 view.dom 里）——所以自己滚：
 *  取选区两端坐标相对滚动容器（.ProseMirror，overflow-y:auto）计算，
 *  已在可视区内不滚，区外滚到上 1/3 处 */
function scrollMatchIntoView(view: {
  state: { selection: { from: number; to: number } };
  dom: HTMLElement;
  coordsAtPos(pos: number): { top: number; bottom: number };
}): void {
  const scroller = view.dom;
  const box = scroller.getBoundingClientRect();
  const top = view.coordsAtPos(view.state.selection.from).top;
  const bottom = view.coordsAtPos(view.state.selection.to).bottom;
  if (top >= box.top && bottom <= box.bottom) return; // 已完整可见
  const target = scroller.scrollTop + top - box.top - scroller.clientHeight / 3;
  scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

/** 对外暴露的编辑器句柄 */
export interface EditorHandle {
  /** 聚焦编辑器并把光标移到文末（窗口激活/点空白区时直接可输入）。
   *  返回是否成功——编辑器尚未就绪时返回 false，调用方可稍后重试 */
  focusEnd(): boolean;
  /** 切换行内格式（加粗/删除线），作用于当前选区；无选区时影响后续输入 */
  toggleMark(mark: 'strong' | 'strikethrough'): void;
  /** 任务列表切换：非列表 → 包成无序列表并转为任务项；
   *  普通列表 → 选区内列表项转任务项；全为任务项 → 转回普通列表 */
  toggleTaskList(): void;
  /** 在光标处插入表格（默认 3 列 2 行含表头，行列数随后用表格操作条调整） */
  insertTable(): void;
  /** 在当前光标或给定视口坐标处插入图片节点。坐标不在编辑器内时追加到正文末尾。 */
  insertImages(
    images: { src: string; alt?: string }[],
    at?: { left: number; top: number },
  ): void;
  /** 编辑器显示态 DOM 的 innerHTML（导出图片用：所见即所得，
   *  含任务勾选态与 pinslip-img 协议图片 src）；编辑器未就绪时返回 null */
  getHTML(): string | null;
  /** 设置搜索 query（大小写不敏感、字面量、无正则——v1 写死的约定）并返回命中快照；
   *  搜索词变化时自动选中下一处命中并滚入可视区；replace 仅随 query 存储，
   *  供 replaceNext/replaceAll 取用。编辑器未就绪时返回 null */
  setFindQuery(search: string, replace?: string): FindStatus | null;
  /** 跳到下一处命中（到底回绕），返回命中快照 */
  findNext(): FindStatus | null;
  /** 跳到上一处命中（到顶回绕），返回命中快照 */
  findPrev(): FindStatus | null;
  /** 替换当前选中命中并选中下一处（无选中命中时仅选中下一处），返回命中快照 */
  replaceNext(): FindStatus | null;
  /** 替换全部命中，返回命中快照（替换后通常归零） */
  replaceAll(): FindStatus | null;
  /** 关闭搜索：清空 query（命中装饰随之消失）并把焦点还回编辑器（不动光标位置） */
  closeFind(): void;
  /** 当前选区的单行纯文本（唤出搜索条时带入查询框）；空选区/跨块选区/未就绪返回 '' */
  getSelectedText(): string;
}

const MilkdownEditor = forwardRef<EditorHandle, EditorProps>(function MilkdownEditor(
  { content, onChange, folder = '' },
  ref,
) {
  const [loading, getEditor] = useInstance();

  useImperativeHandle(
    ref,
    () => {
      /** 执行 prosemirror-search 命令并返回最新命中快照；编辑器未就绪返回 null */
      const runFind = (cmd: PmSearchCommand): FindStatus | null => {
        if (loading) return null;
        let status: FindStatus | null = null;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          cmd(view.state, view.dispatch as (tr: unknown) => void, view);
          // PM 的 tr.scrollIntoView 在焦点位于搜索框时空转（DOM 选区不在编辑器内），
          // 自行滚动到命中（已在可视区不滚）
          scrollMatchIntoView(view);
          status = countFindMatches(view);
        });
        return status;
      };
      return {
      focusEnd() {
        if (loading) return false;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const dom = view.dom as HTMLElement;
          dom.focus();
          // 通过 DOM Selection 把光标压到文末，ProseMirror 会自动同步回内部状态
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(dom);
            sel.collapseToEnd();
          }
        });
        return true;
      },
      toggleMark(mark) {
        if (loading) return;
        getEditor().action((ctx) => {
          // .key 在插件运行时才挂上（$command 工厂内赋值），action 执行时必定就绪
          ctx
            .get(commandsCtx)
            .call(mark === 'strong' ? toggleStrongCommand.key : toggleStrikethroughCommand.key);
        });
      },
      toggleTaskList() {
        if (loading) return;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          interface ListItemRef {
            pos: number;
            attrs: Record<string, unknown>;
          }
          /** 收集选区覆盖到的所有 list_item（快照 attrs，供 setNodeMarkup 用） */
          const collectItems = (): ListItemRef[] => {
            const items: ListItemRef[] = [];
            const { from, to } = view.state.selection;
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (node.type.name === 'list_item') {
                items.push({ pos, attrs: { ...node.attrs } });
              }
            });
            return items;
          };

          let items = collectItems();
          // 全是任务项 → 转回普通列表（清掉 checked，GFM 以此区分任务/普通项）
          if (items.length > 0 && items.every((i) => i.attrs.checked != null)) {
            const tr = view.state.tr;
            for (const { pos, attrs } of items) {
              tr.setNodeMarkup(pos, undefined, { ...attrs, checked: null });
            }
            view.dispatch(tr);
            return;
          }
          if (items.length === 0) {
            // 不在列表里：先包成无序列表（命令内部会 dispatch，state 已更新）
            const wrapped = ctx.get(commandsCtx).call(wrapInBulletListCommand.key);
            if (!wrapped) return;
            items = collectItems();
          }
          // 普通列表 → 任务项：只动 checked == null 的项（已是任务的保持原勾选态）
          const tr = view.state.tr;
          for (const { pos, attrs } of items) {
            if (attrs.checked == null) {
              tr.setNodeMarkup(pos, undefined, { ...attrs, checked: false });
            }
          }
          view.dispatch(tr);
        });
      },
      insertTable() {
        if (loading) return;
        getEditor().action((ctx) => {
          // 3 列 2 行（首行为表头），行/列数之后用表格操作条增删
          ctx.get(commandsCtx).call(insertTableCommand.key, { row: 2, col: 3 });
        });
      },
      insertImages(images, at) {
        if (loading || images.length === 0) return;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (!at) {
            let tr = view.state.tr;
            if (!tr.selection.empty) tr = tr.deleteSelection();
            // 逐张在选区后插入并手动步进:replaceSelectionWith 会把选区设为
            // 刚插入的 atom 节点,第二张图会覆盖第一张
            let pos = tr.selection.to;
            for (const image of images) {
              const node = view.state.schema.nodes.image.create({
                src: image.src,
                alt: image.alt ?? '',
              });
              tr = tr.insert(pos, node);
              pos += node.nodeSize;
            }
            view.dispatch(tr);
            return;
          }

          const hit = view.posAtCoords(at);
          let insertPos: number | null = null;
          if (hit) {
            const $hit = view.state.doc.resolve(hit.pos);
            if ($hit.parent.isTextblock && !$hit.parent.type.spec.code) insertPos = hit.pos;
          }
          // 拖到标题栏/工具栏也算拖进这张便签:追加到最后一个文本块,
          // 而不是让 Chromium 把窗口导航到文件路径
          if (insertPos === null) {
            view.state.doc.descendants((node, pos) => {
              if (node.isTextblock && !node.type.spec.code) {
                insertPos = pos + 1 + node.content.size;
              }
            });
          }
          if (insertPos === null) {
            const nodes = images.map((image) =>
              view.state.schema.nodes.image.create({ src: image.src, alt: image.alt ?? '' }),
            );
            const paragraph = view.state.schema.nodes.paragraph.create(null, nodes);
            view.dispatch(view.state.tr.insert(view.state.doc.content.size, paragraph));
            return;
          }
          let tr = view.state.tr;
          let offset = 0;
          for (const image of images) {
            const node = view.state.schema.nodes.image.create({
              src: image.src,
              alt: image.alt ?? '',
            });
            tr = tr.insert(insertPos + offset, node);
            offset += node.nodeSize;
          }
          view.dispatch(tr);
        });
      },
      getHTML() {
        if (loading) return null;
        let html = '';
        getEditor().action((ctx) => {
          html = (ctx.get(editorViewCtx).dom as HTMLElement).innerHTML;
        });
        return html;
      },
      setFindQuery(search, replace = '') {
        if (loading) return null;
        let status: FindStatus | null = null;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const query = new SearchQuery({ search, replace });
          const prev = getSearchState(view.state);
          if (prev && prev.query.eq(query)) {
            status = countFindMatches(view);
            return;
          }
          view.dispatch(setSearchState(view.state.tr, query));
          // 只有搜索词变化才跳命中（输入替换词不应挪动选区）；
          // PM 自带的 scrollIntoView 在焦点位于搜索框时空转，自行滚动兜底
          if (query.valid && (!prev || prev.query.search !== search)) {
            pmFindNext(view.state, view.dispatch, view);
            scrollMatchIntoView(view);
          }
          status = countFindMatches(view);
        });
        return status;
      },
      findNext() {
        return runFind(pmFindNext);
      },
      findPrev() {
        return runFind(pmFindPrev);
      },
      replaceNext() {
        return runFind(pmReplaceNext);
      },
      replaceAll() {
        return runFind(pmReplaceAll);
      },
      closeFind() {
        if (loading) return;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const cur = getSearchState(view.state);
          if (cur && cur.query.valid) {
            view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: '' })));
          }
          (view.dom as HTMLElement).focus(); // 焦点还回编辑器，光标留在原处
        });
      },
      getSelectedText() {
        if (loading) return '';
        let text = '';
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to, empty } = view.state.selection;
          if (empty) return;
          const raw = view.state.doc.textBetween(from, to, '\n');
          // 跨块选区不带入（编辑器惯例：单行选区才作查询种子）
          if (!raw.includes('\n')) text = raw.trim().slice(0, 100);
        });
        return text;
      },
      };
    },
    [loading, getEditor],
  );

  useEditor((root) =>
    MilkdownCore.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        // 序列化无序列表统一用 "-"：mdast 默认输出 "*"，Obsidian 只认 "-" 的任务列表
        // （"*" 的任务在 Obsidian 里显示为普通符号 + 字面 [x]）
        ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: '-' as const }));
        // 任务列表可点击 checkbox：直接向 nodeViewCtx 注册 nodeview。
        // 不走 $view——它的定时器注册在我们的插件链里没有触发（工厂函数从未执行）；
        // config 阶段早于 editorView 创建，写入即生效。
        ctx.update(nodeViewCtx, (views) => [
          ...views,
          ['list_item', createTaskCapableListItemView] as (typeof views)[number],
          ['image', createImageView] as (typeof views)[number],
        ]);
        // 粘贴图片：上传 vault attachments/ 后插入 image 节点（markdown 存相对路径，前缀深度随文件夹）
        // Ctrl+C 复制 = 紧凑 markdown：slice 包成文档节点走 remark 序列化（与磁盘落盘同一管线，
        // 标题/加粗/链接/表格/引用/分割线等语法全保留），再折叠块分隔空行——
        // 与便签「复制全部」、主界面列表「复制全部」同一口径（toCompactMarkdown）
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          // 关掉拼写检查：代码/命令里的英文词会被拼写检查画满红波浪线
          attributes: {
            ...(typeof options.attributes === 'object' ? options.attributes : {}),
            spellcheck: 'false',
          },
          handlePaste: handleImagePaste(folder),
          // 拖入图片文件时拦下 PM 默认 drop（它会把 dataTransfer 里的外链 <img>
          // 再插一份，与外层上传通道重复成两张图），由 NoteView 统一上传插入
          handleDrop: handleImageDrop(),
          clipboardTextSerializer: (slice: ClipboardSliceLike) => {
            try {
              const schema = ctx.get(schemaCtx);
              const serializer = ctx.get(serializerCtx);
              const doc = schema.topNodeType.create(null, slice.content as never);
              return toCompactMarkdown(serializer(doc));
            } catch {
              // slice 包不进文档节点（理论不会：PM 复制切片总是块级）——退回纯文本，保证复制不空
              return slice.content.textBetween(0, slice.content.size, '\n');
            }
          },
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, _prev) => {
          onChange(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      // 非包容样式覆写：同步段在 commonmark/gfm 注册之后、schema 组装之前执行
      // （插件 handler 并发加载，但 await 前的同步代码按挂链顺序跑完）
      .use((ctx) => async () => {
        ctx.update(marksCtx, (prev) =>
          prev.map(([id, spec]): [string, typeof spec] =>
            NON_INCLUSIVE_MARKS.has(id) ? [id, { ...spec, inclusive: false }] : [id, spec],
          ),
        );
      })
      .use(history)
      .use(listener)
      .use(pmSearchPlugin)
      .use(pasteClearMarksPlugin),
  []);

  return <Milkdown />;
});

/** Markdown 所见即所得编辑器（Milkdown 封装，对外只暴露 Markdown 字符串） */
const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  return (
    <div className={`pinslip-editor pinslip-editor--${props.mode ?? 'sticky'}`}>
      <MilkdownProvider>
        <MilkdownEditor {...props} ref={ref} />
        {/* 表格操作条：选区进入表格时浮现（自身经 useInstance 订阅选区） */}
        <TableBar />
      </MilkdownProvider>
    </div>
  );
});

export default Editor;

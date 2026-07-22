import { forwardRef, useImperativeHandle } from 'react';
import {
  commandsCtx,
  defaultValueCtx,
  Editor as MilkdownCore,
  editorViewCtx,
  editorViewOptionsCtx,
  nodeViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import {
  commonmark,
  toggleStrongCommand,
  wrapInBulletListCommand,
} from '@milkdown/preset-commonmark';
import { gfm, toggleStrikethroughCommand } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { nord } from '@milkdown/theme-nord';
import { createTaskCapableListItemView } from './task-item-view';
import { createImageView, handleImagePaste } from './image-support';

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
  /** 在当前光标处插入图片节点（src 为写进 markdown 的相对路径） */
  insertImage(src: string): void;
}

const MilkdownEditor = forwardRef<EditorHandle, EditorProps>(function MilkdownEditor(
  { content, onChange, folder = '' },
  ref,
) {
  const [loading, getEditor] = useInstance();

  useImperativeHandle(
    ref,
    () => ({
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
      insertImage(src) {
        if (loading) return;
        getEditor().action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const imageNode = view.state.schema.nodes.image.create({ src });
          view.dispatch(view.state.tr.replaceSelectionWith(imageNode));
        });
      },
    }),
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
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          handlePaste: handleImagePaste(folder),
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, _prev) => {
          onChange(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener),
  []);

  return <Milkdown />;
});

/** Markdown 所见即所得编辑器（Milkdown 封装，对外只暴露 Markdown 字符串） */
const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  return (
    <div className={`pinslip-editor pinslip-editor--${props.mode ?? 'sticky'}`}>
      <MilkdownProvider>
        <MilkdownEditor {...props} ref={ref} />
      </MilkdownProvider>
    </div>
  );
});

export default Editor;

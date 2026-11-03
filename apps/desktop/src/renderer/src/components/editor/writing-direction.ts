import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import type { WritingDirection } from '@shared/types';

export const writingDirectionKey = new PluginKey<WritingDirection>('pinslip-writing-direction');
const containers = new Set(['list_item', 'blockquote', 'table_cell', 'table_header']);

/** 仅装饰显示 DOM，不向文档 schema 或 Markdown 写入方向信息。 */
export const writingDirectionPlugin = $prose(() => new Plugin<WritingDirection>({
  key: writingDirectionKey,
  state: {
    init: () => 'auto',
    apply: (tr, previous) => tr.getMeta(writingDirectionKey) ?? previous,
  },
  props: {
    attributes: state => ({ dir: writingDirectionKey.getState(state) === 'rtl' ? 'rtl' : 'ltr' }),
    decorations(state) {
      const mode = writingDirectionKey.getState(state) ?? 'auto';
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos, parent, index) => {
        let dir: WritingDirection | undefined;
        if (node.type.name === 'code_block' || node.type.name === 'table') dir = 'ltr';
        else if (containers.has(node.type.name)) dir = mode;
        else if (node.isTextblock) {
          // 首段继承容器方向：dir=auto 会跳过自身带 dir 的子树，
          // 若首段也加 auto，li/引用/单元格便无法从它推导方向。
          if (!parent || !containers.has(parent.type.name) || index !== 0) dir = mode;
        }
        if (dir) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }));
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
}));

/**
 * 列表项自定义 nodeview：给 GFM 任务列表一个真实可点击的 checkbox。
 *
 * 背景：Milkdown 的 GFM 预设只输出 <li data-item-type="task" data-checked>，
 * 不含任何可交互元素。这里接管 list_item 的渲染：
 * - 普通列表项：contentDOM 就是 li 本身，与默认渲染完全一致；
 * - 任务项：li 内放一个 checkbox 元素 + 独立 contentDOM 容器。
 *   checkbox 必须在 contentDOM 之外——contentDOM 的子节点由 ProseMirror 全权管理，
 *   外来子节点会被当作脏 DOM 清掉。
 *
 * 注册方式：不走 $view（其定时器机制在我们的插件链里没有触发工厂函数），
 * 而是在 config 阶段直接 ctx.update(nodeViewCtx, ...)（见 Editor.tsx），
 * 时机早于 editorView 创建，确定性强。
 *
 * 类型说明：为避免仅为类型新增 prosemirror 直接依赖，这里用最小结构化类型，
 * 与 prosemirror-view 的 NodeViewConstructor 结构兼容（参数更宽、返回值结构一致）。
 */

interface ListItemNodeLike {
  type: unknown;
  attrs: {
    label?: string;
    listType?: string;
    spread?: unknown;
    checked?: boolean | null;
  };
}

interface TransactionLike {
  setNodeMarkup(pos: number, type: undefined, attrs: Record<string, unknown>): TransactionLike;
}

interface EditorViewLike {
  state: { tr: TransactionLike };
  dispatch(tr: TransactionLike): void;
}

/** prosemirror-view 新版 getPos 是 () => number | undefined；旧版可能是 boolean（兼容判断） */
type GetPosLike = (() => number | undefined) | boolean;

export function createTaskCapableListItemView(
  initialNode: ListItemNodeLike,
  editorView: EditorViewLike,
  getPos: GetPosLike,
) {
  let node = initialNode;
  const dom = document.createElement('li');

  /** 与 schema toDOM 保持一致的 data-* 属性同步 */
  const syncAttrs = (n: ListItemNodeLike): void => {
    dom.dataset.label = String(n.attrs.label ?? '');
    dom.dataset.listType = String(n.attrs.listType ?? '');
    dom.dataset.spread = String(n.attrs.spread ?? '');
    if (n.attrs.checked != null) {
      dom.dataset.itemType = 'task';
      dom.dataset.checked = String(n.attrs.checked);
    } else {
      delete dom.dataset.itemType;
      delete dom.dataset.checked;
    }
  };
  syncAttrs(node);

  const isTask = node.attrs.checked != null;
  let contentDOM: HTMLElement = dom;
  let check: HTMLSpanElement | null = null;
  if (isTask) {
    check = document.createElement('span');
    check.className = 'pinslip-task-check';
    check.contentEditable = 'false';
    dom.appendChild(check);
    contentDOM = document.createElement('div');
    contentDOM.className = 'pinslip-task-content';
    dom.appendChild(contentDOM);
  }

  const onCheckMouseDown = (e: MouseEvent): void => {
    e.preventDefault(); // 不抢编辑器焦点/选区
    e.stopPropagation();
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos == null) return;
    const tr = editorView.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      checked: !node.attrs.checked,
    });
    editorView.dispatch(tr);
  };
  check?.addEventListener('mousedown', onCheckMouseDown);

  return {
    dom,
    contentDOM,
    update(updated: ListItemNodeLike) {
      if (updated.type !== node.type) return false;
      // 普通项 <-> 任务项 的 DOM 结构不同，返回 false 让 ProseMirror 整体重建
      if ((updated.attrs.checked != null) !== isTask) return false;
      node = updated;
      syncAttrs(updated);
      return true;
    },
    destroy() {
      check?.removeEventListener('mousedown', onCheckMouseDown);
    },
  };
}

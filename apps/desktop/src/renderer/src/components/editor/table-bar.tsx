import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { CmdKey } from '@milkdown/core';
import { listenerCtx } from '@milkdown/plugin-listener';
import { useInstance } from '@milkdown/react';
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  deleteSelectedCellsCommand,
  selectColCommand,
  selectRowCommand,
  selectTableCommand,
} from '@milkdown/preset-gfm';
import { findTable, isInTable, selectedRect } from '@milkdown/prose/tables';
import RowsPlusBottomIcon from '~icons/ph/rows-plus-bottom';
import RowsPlusTopIcon from '~icons/ph/rows-plus-top';
import ColumnsPlusRightIcon from '~icons/ph/columns-plus-right';
import ColumnsPlusLeftIcon from '~icons/ph/columns-plus-left';
import RowsIcon from '~icons/ph/rows';
import ColumnsIcon from '~icons/ph/columns';
import TrashIcon from '~icons/ph/trash';
import CopyIcon from '~icons/ph/copy';
import CheckIcon from '~icons/ph/check';

/** 操作条几何状态：top/left 相对 .pinslip-editor 容器（CSS px） */
interface BarState {
  top: number;
  left: number;
  /** 上方加行可用性：表头行（row 0）禁用——schema 要求 table 首行必须是
   *  table_header_row，在 0 位插入 table_row 会造成非法文档，序列化后表格解体 */
  canAddRowBefore: boolean;
  /** 删行可用性：表头行不可删；删完只剩表头也不合法（schema 要求 table_row+） */
  canDeleteRow: boolean;
  /** 删列可用性：至少留一列 */
  canDeleteCol: boolean;
}

/** 条高 26 + 与表格的 4px 缝 */
const BAR_OFFSET = 30;

/** 表格操作条：选区进入表格时浮现在表格块上方（编辑器区域内 absolute，findbar 同款浮层纪律）。
 *  结构操作（增删行列/删表）为 GFM 预设命令经 commandsCtx 调用（.key 只在插件运行时挂载，
 *  必须 action 内用）；删行/删列 = 先 selectRow/Col 把选区扩成 CellSelection，再
 *   deleteSelectedCells；复制按钮直读文档节点写剪贴板（TSV），不经命令。
 *  选区离开表格即消失；删表为红色确认态（再点一次生效，不弹窗）。 */
export default function TableBar() {
  const { t } = useTranslation();
  const [loading, getEditor] = useInstance();
  const [bar, setBar] = useState<BarState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 复制成功反馈态：图标变对勾 + 提示「已复制」，定时恢复 */
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  /** 按当前选区重算操作条位置/可用性；不在表格内则隐藏。 */
  const update = useCallback(() => {
    if (loading) return;
    getEditor().action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const state = view.state;
      const hide = () => {
        setBar(null);
        setConfirmDelete(false);
      };
      if (!isInTable(state)) {
        hide();
        return;
      }
      const table = findTable(state.selection.$from);
      const dom = table ? view.nodeDOM(table.pos) : null;
      const container = (view.dom as HTMLElement).closest('.pinslip-editor');
      if (!(dom instanceof HTMLElement) || !(container instanceof HTMLElement)) {
        hide();
        return;
      }
      // CSS zoom（内容缩放）下 gBCR 与 style 长度同一坐标系；scale 兜底：
      // zoom 若在布局层实现（offsetWidth 未缩放）则用它还原，否则比值恒为 1 无副作用
      const contRect = container.getBoundingClientRect();
      const scale = contRect.width / container.offsetWidth || 1;
      const rect = dom.getBoundingClientRect();
      const sel = selectedRect(state);
      const rowsAfterDelete = sel.map.height - (sel.bottom - sel.top);
      // 上方放不下（表格顶到编辑器顶部）时改放表格下方——clamp 到 0 会压住
      // 表头/首行输入（实测反馈），下方通常是内容空白区
      const topAbove = (rect.top - contRect.top) / scale - BAR_OFFSET;
      const top =
        topAbove >= 0 ? topAbove : (rect.bottom - contRect.top) / scale + 4;
      setBar({
        top,
        left: Math.max(0, (rect.left - contRect.left) / scale),
        canAddRowBefore: sel.top > 0,
        canDeleteRow: sel.top > 0 && rowsAfterDelete >= 2,
        canDeleteCol: sel.map.width - (sel.right - sel.left) >= 1,
      });
    });
  }, [loading, getEditor]);

  // 选区监听（listener 插件事件期读取数组，挂载后注册也生效——alive 标志兜底卸载期）；
  // 滚动/窗口缩放时按现选区重定位（表格块随内容滚动，浮层要跟上）。
  // 两个坑(均实测):① selectionUpdated 在 state.apply 内触发,此刻 view.state 是
  // 旧选区,必须延一拍读(否则显隐慢一拍);② 命令派发(insertTable 等)不触发
  // selectionUpdated,表格结构变化走 updated 通道(doc-changed,200ms 防抖,届时
  // view.state 已提交)兜底浮现/消隐
  const scrollerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (loading) return;
    let alive = true;
    const onReflow = () => {
      if (alive) update();
    };
    getEditor().action((ctx) => {
      const mgr = ctx.get(listenerCtx);
      mgr.selectionUpdated(() => {
        // listener 插件在 state.apply 内触发——此刻 view.state 还是旧选区，
        // 立即读会出现「点第一下不出现、点第二下才出现」的错位一拍。
        // 延一拍（宏任务）读取，事务已提交
        if (alive) setTimeout(update, 0);
      });
      mgr.updated(() => {
        if (alive) update();
      });
      const dom = ctx.get(editorViewCtx).dom as HTMLElement;
      dom.addEventListener('scroll', onReflow, { passive: true });
      scrollerRef.current = dom;
    });
    window.addEventListener('resize', onReflow);
    update(); // 兜底：挂载时选区已在表格内（注册晚于首次 selectionUpdated）也能浮现
    return () => {
      alive = false;
      scrollerRef.current?.removeEventListener('scroll', onReflow);
      window.removeEventListener('resize', onReflow);
    };
  }, [loading, getEditor, update]);

  /** 增行/增列：单命令直调 */
  const callCommand = useCallback(
    (key: CmdKey<unknown>) => {
      if (loading) return;
      getEditor().action((ctx) => {
        ctx.get(commandsCtx).call(key);
      });
      update();
    },
    [loading, getEditor, update],
  );

  /** 删行/删列：先把当前行/列扩成 CellSelection，再 deleteSelectedCells。
   *  schema 约束场景（表头行等）由按钮禁用拦截，try/catch 兜底防无效内容抛错 */
  const deleteLine = useCallback(
    (kind: 'row' | 'col') => {
      if (loading) return;
      getEditor().action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!isInTable(view.state)) return;
        const rect = selectedRect(view.state);
        const cmds = ctx.get(commandsCtx);
        try {
          cmds.call(kind === 'row' ? selectRowCommand.key : selectColCommand.key, {
            index: kind === 'row' ? rect.top : rect.left,
          });
          cmds.call(deleteSelectedCellsCommand.key);
        } catch {
          /* no-op */
        }
      });
      update();
    },
    [loading, getEditor, update],
  );

  /** 删表：确认态二段击；全选表格 → deleteSelectedCells 即 deleteTable 分支 */
  const deleteTable = useCallback(() => {
    if (loading) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    getEditor().action((ctx) => {
      const cmds = ctx.get(commandsCtx);
      cmds.call(selectTableCommand.key);
      cmds.call(deleteSelectedCellsCommand.key);
    });
    update();
  }, [loading, getEditor, confirmDelete, update]);

  /** 复制整表数据：直读文档节点（不经序列化器，行内标记不带出），TSV 写剪贴板——
   *  制表符分列、换行分行（Excel/记事本直粘），单元格内 \t/\n 合并为空格防错位；
   *  操作条 mousedown 已拦截默认行为，点击时表格选区仍在 */
  const copyTable = useCallback(() => {
    if (loading) return;
    getEditor().action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!isInTable(view.state)) return;
      const found = findTable(view.state.selection.$from);
      if (!found) return;
      const rows: string[] = [];
      found.node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(cell.textContent.replace(/[\t\n\r]+/g, ' ').trim()));
        rows.push(cells.join('\t'));
      });
      navigator.clipboard
        .writeText(rows.join('\n'))
        .then(() => {
          setCopied(true);
          if (copiedTimer.current) clearTimeout(copiedTimer.current);
          copiedTimer.current = setTimeout(() => setCopied(false), 1200);
        })
        .catch(() => {});
    });
  }, [loading, getEditor]);

  if (!bar) return null;

  const buttons = [
    {
      key: 'addRowAfter',
      tip: t('note.table.addRowAfter'),
      icon: <RowsPlusBottomIcon />,
      act: () => callCommand(addRowAfterCommand.key),
      disabled: false,
      // 操作条贴表格左缘，最左按钮的居中 tooltip 会溢出窗口左缘——左对齐防裁
      tipAlign: 'left',
    },
    {
      key: 'addColAfter',
      tip: t('note.table.addColAfter'),
      icon: <ColumnsPlusRightIcon />,
      act: () => callCommand(addColAfterCommand.key),
      disabled: false,
    },
    { key: 'd1', divider: true },
    {
      key: 'addRowBefore',
      tip: t('note.table.addRowBefore'),
      icon: <RowsPlusTopIcon />,
      act: () => callCommand(addRowBeforeCommand.key),
      disabled: !bar.canAddRowBefore,
    },
    {
      key: 'addColBefore',
      tip: t('note.table.addColBefore'),
      icon: <ColumnsPlusLeftIcon />,
      act: () => callCommand(addColBeforeCommand.key),
      disabled: false,
    },
    { key: 'd2', divider: true },
    {
      key: 'deleteRow',
      tip: t('note.table.deleteRow'),
      icon: <RowsIcon />,
      act: () => deleteLine('row'),
      disabled: !bar.canDeleteRow,
    },
    {
      key: 'deleteCol',
      tip: t('note.table.deleteCol'),
      icon: <ColumnsIcon />,
      act: () => deleteLine('col'),
      disabled: !bar.canDeleteCol,
    },
    { key: 'd3', divider: true },
    {
      key: 'copyTable',
      tip: copied ? t('note.table.copied') : t('note.table.copyTable'),
      icon: copied ? <CheckIcon /> : <CopyIcon />,
      act: copyTable,
      disabled: false,
    },
    { key: 'd4', divider: true },
    {
      key: 'deleteTable',
      tip: confirmDelete ? t('note.table.deleteTableConfirm') : t('note.table.deleteTable'),
      icon: <TrashIcon />,
      act: deleteTable,
      disabled: false,
      danger: confirmDelete,
    },
  ] as const;

  return (
    /* mousedown 拦截：preventDefault 保编辑器焦点/选区，stopPropagation 防
       .sticky-note__body 的空白点击聚焦把光标压到文末（选区出表 → 条消失 → 点击落空） */
    <div
      className="pinslip-editor__tablebar"
      style={{ top: bar.top, left: bar.left }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {buttons.map((b) =>
        'divider' in b ? (
          <span key={b.key} className="pinslip-editor__tablebar-divider" />
        ) : (
          <button
            key={b.key}
            className={`sticky-note__btn${'danger' in b && b.danger ? ' is-danger' : ''}`}
            data-tip={b.tip}
            data-tip-align={'tipAlign' in b ? b.tipAlign : undefined}
            aria-label={b.tip}
            disabled={b.disabled}
            onClick={b.act}
          >
            {b.icon}
          </button>
        ),
      )}
    </div>
  );
}

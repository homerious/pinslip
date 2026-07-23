import { useEffect, useState } from 'react';
import WarningIcon from '~icons/ph/warning';
import CheckIcon from '~icons/ph/check';
import { resolveConflicts } from '../utils/conflict';

interface ConflictResolverProps {
  /** 便签内容（含 conflict markers 的原文；外部重载/保存回包会更新它） */
  content: string;
  /** 保存飞行中（复用 NoteView 的 saveState === 'saving'） */
  saving: boolean;
  /** 点「保存解决」：把编辑区全文交给 NoteView 走 notesApi.save */
  onSave: (text: string) => void;
}

/** 便签冲突解决视图：替代 Milkdown 的原始文本编辑模式。
 *  布局 = 琥珀冲突横幅（含「全部用本地/远端」快捷按钮）+ 等宽 textarea 原文编辑区
 *  + 底部「保存解决」栏。不走自动保存，只有点保存才落盘；
 *  编辑草稿是本组件内部 state，不回写 NoteView 的 content（避免触发 autosave） */
export default function ConflictResolver({ content, saving, onSave }: ConflictResolverProps) {
  const [text, setText] = useState(content);

  // 外部内容进来（applyExternal 重载 / 保存回包）时直接替换编辑区草稿
  useEffect(() => {
    setText(content);
  }, [content]);

  return (
    <>
      {/* 冲突横幅：沿用现有琥珀样式，右侧加两个快捷剥取按钮 */}
      <div className="sticky-note__banner sticky-note__banner--conflict">
        <WarningIcon />
        <span>此便签有同步冲突，请解决后保存</span>
        <div className="sticky-note__banner-actions">
          <button
            className="sticky-note__banner-btn"
            onClick={() => setText((t) => resolveConflicts(t, 'local'))}
          >
            全部用本地
          </button>
          <button
            className="sticky-note__banner-btn"
            onClick={() => setText((t) => resolveConflicts(t, 'remote'))}
          >
            全部用远端
          </button>
        </div>
      </div>

      {/* 原文编辑区：等宽字体直接显示含 markers 的全文，自由编辑 */}
      <div className="sticky-note__body sticky-note__body--conflict">
        <textarea
          className="sticky-note__conflict-textarea"
          value={text}
          autoFocus
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {/* 底部保存栏：只有这里落盘 */}
      <div className="sticky-note__conflict-footer">
        <button
          className="sticky-note__conflict-save"
          disabled={saving}
          onClick={() => onSave(text)}
        >
          <CheckIcon />
          {saving ? '保存中…' : '保存解决'}
        </button>
      </div>
    </>
  );
}

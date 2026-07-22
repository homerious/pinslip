import { useState } from 'react';
import { notesApi } from '../api/notes';

/** 速记浮窗视图：全局快捷键呼出，Enter 保存到 inbox 后自动关闭 */
export default function QuickCaptureView() {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await notesApi.quick(text.trim());
      window.api.notifyNotesChanged(); // 广播：主界面列表近实时刷新
      window.close();
    } catch (err) {
      console.error('速记保存失败:', err);
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSave();
    }
    if (e.key === 'Escape') {
      window.close();
    }
  };

  return (
    <div className="quick-capture">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入速记内容…"
        autoFocus
        disabled={saving}
      />
      <div className="quick-capture__hint">
        {saving ? '保存中…' : 'Enter 保存 · Shift+Enter 换行 · Esc 关闭'}
      </div>
    </div>
  );
}

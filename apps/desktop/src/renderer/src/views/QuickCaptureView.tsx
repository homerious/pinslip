import { useEffect, useRef, useState } from 'react';
import { notesApi, settingsApi } from '../api/notes';
import { attachmentsApi } from '../api/attachments';
import { toMarkdownImageSrc } from '../components/editor/image-support';

/**
 * 速记浮窗视图：全局快捷键呼出。
 * - Enter 保存到 inbox 并关窗；Ctrl/Cmd+Enter 保存但不关窗（继续记）；
 * - 失焦 / Esc 自动保存并关窗（DevTools 打开时失焦豁免，方便调试）；
 * - 支持直接粘贴图片（走 attachments 上传，插入相对路径 markdown）；
 * - 设置开启时带入剪贴板文本并全选（默认开启）。
 */
export default function QuickCaptureView() {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // blur/Esc 回调里读最新值，避开闭包捕获旧 state
  const textRef = useRef('');
  textRef.current = text;
  const savingRef = useRef(false);
  savingRef.current = saving;

  // 挂载：按设置带入剪贴板文本并全选
  useEffect(() => {
    let alive = true;
    settingsApi
      .get()
      .then((s) => {
        if (!(s.quickCaptureClipboard ?? true)) return '';
        return navigator.clipboard.readText().catch(() => '');
      })
      .then((clip) => {
        if (!alive || typeof clip !== 'string' || !clip.trim()) return;
        setText(clip);
        requestAnimationFrame(() => textareaRef.current?.select());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const save = async (close: boolean) => {
    const content = textRef.current.trim();
    if (!content || savingRef.current) return;
    setSaving(true);
    try {
      await notesApi.quick(content);
      window.api.notifyNotesChanged(); // 广播：主界面列表近实时刷新
      if (close) {
        window.close();
        return;
      }
      // 保存但不关窗：清空并提示「已保存，继续记」
      setText('');
      setSavedFlash(true);
      setSaving(false);
      setTimeout(() => setSavedFlash(false), 1500);
      textareaRef.current?.focus();
    } catch (err) {
      console.error('速记保存失败:', err);
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;

  // 失焦 / Esc：有内容先存再关，空内容直接关
  const closeWithSave = () => {
    if (textRef.current.trim()) void saveRef.current(true);
    else window.close();
  };
  const closeWithSaveRef = useRef(closeWithSave);
  closeWithSaveRef.current = closeWithSave;

  // 失焦自动保存关窗（原 main 进程 blur 逻辑挪到渲染层；DevTools 开着时豁免）
  useEffect(() => {
    const onBlur = () => {
      window.api
        .isDevToolsOpen()
        .then((open) => {
          if (!open) closeWithSaveRef.current();
        })
        .catch(() => closeWithSaveRef.current());
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save(!(e.ctrlKey || e.metaKey)); // Ctrl+Enter 保存不关窗
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeWithSave();
    }
  };

  // 粘贴图片：上传 attachments 并在光标处插入相对路径 markdown
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return; // 无图片走默认粘贴
    e.preventDefault();
    const el = textareaRef.current;
    const start = el?.selectionStart ?? textRef.current.length;
    const end = el?.selectionEnd ?? start;
    void (async () => {
      let inserted = '';
      for (const file of files) {
        const res = await attachmentsApi.upload(file).catch(() => null);
        if (!res) continue;
        // 速记落 inbox/，与 notes/ 同为一级目录，`../` 前缀恒定
        inserted += `![](${toMarkdownImageSrc(res.path, '')})`;
      }
      if (!inserted) return;
      const cur = textRef.current;
      const next = cur.slice(0, start) + inserted + cur.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        const pos = start + inserted.length;
        textareaRef.current?.setSelectionRange(pos, pos);
        textareaRef.current?.focus();
      });
    })();
  };

  return (
    <div className="quick-capture">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="输入速记内容…"
        autoFocus
        disabled={saving}
      />
      <div className="quick-capture__hint">
        {saving
          ? '保存中…'
          : savedFlash
            ? '已保存，继续记'
            : 'Enter 保存 · Ctrl+Enter 保存并继续 · Shift+Enter 换行 · Esc 关闭'}
      </div>
    </div>
  );
}

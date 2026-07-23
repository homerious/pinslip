import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { notesApi, settingsApi } from '../api/notes';
import { attachmentsApi } from '../api/attachments';
import { resolveImageSrc, toMarkdownImageSrc } from '../components/editor/image-support';

/** 文本里的 attachments 图片引用（与 image-support 的相对路径写法一致） */
const IMAGE_REF_RE = /!\[[^\]]*\]\(((?:\.\.\/)*attachments\/[^)\s]+)\)/g;

/**
 * 速记浮窗视图：全局快捷键呼出。
 * - Enter 保存到 inbox 并关窗；Ctrl/Cmd+Enter 保存但不关窗（继续记）；
 * - 失焦 / Esc 自动保存并关窗（DevTools 打开时失焦豁免，方便调试）；
 * - 支持直接粘贴图片（走 attachments 上传，插入相对路径 markdown）；
 * - 设置开启时带入剪贴板文本并全选（默认开启）。
 */
export default function QuickCaptureView() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // blur/Esc 回调里读最新值，避开闭包捕获旧 state
  const textRef = useRef('');
  textRef.current = text;
  const savingRef = useRef(false);
  savingRef.current = saving;

  // 已贴图片缩略图：从文本派生（删掉引用即消失），不单独维护状态
  const thumbs = useMemo(() => {
    const srcs: string[] = [];
    for (const m of text.matchAll(IMAGE_REF_RE)) srcs.push(m[1]);
    return srcs;
  }, [text]);

  // 聚焦兜底：保存期间 textarea 被 disabled，同步 focus 会在 DOM 提交前落空——
  // 等一帧再聚焦，确保禁用已解除、焦点确实回到输入框
  const refocusTextarea = () => {
    requestAnimationFrame(() => {
      setTimeout(() => textareaRef.current?.focus(), 0);
    });
  };

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
      refocusTextarea();
    } catch (err) {
      console.error('速记保存失败:', err);
      setSaving(false);
      refocusTextarea(); // 失败也要把焦点还回输入框，内容不丢、可立即重试
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
        placeholder={t('quick.placeholder')}
        autoFocus
        disabled={saving}
      />
      {thumbs.length > 0 && (
        <div className="quick-capture__thumbs">
          {thumbs.map((src, i) => (
            <img key={`${src}-${i}`} src={resolveImageSrc(src)} alt="" />
          ))}
        </div>
      )}
      <div className="quick-capture__hint">
        {saving ? t('quick.saving') : savedFlash ? t('quick.saved') : t('quick.hint')}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import XIcon from '~icons/ph/x';
import ArrowsClockwiseIcon from '~icons/ph/arrows-clockwise';
import type { Note, RuntimeInfo, SyncStatus } from '@shared/types';
import { notesApi } from '../api/notes';
import { syncApi } from '../api/sync';
import { translateServerError } from '../i18n';
import { noteDirectory } from '../utils/path';

interface Props {
  noteId: string;
  title: string;
  folder: string;
  hasSaved: boolean;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: T };

/** 只读快照：打开/手动刷新时读取；文件广播只刷新笔记，不增加同步轮询。 */
export default function NoteInfo({ noteId, title, folder, hasSaved, returnFocus, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const knownSaved = useRef(hasSaved);
  const [note, setNote] = useState<Load<Note | null>>({ state: 'loading' });
  const [runtime, setRuntime] = useState<Load<RuntimeInfo>>({ state: 'loading' });
  const [sync, setSync] = useState<Load<SyncStatus>>({ state: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [noteRevision, setNoteRevision] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal(); // 原生 modal 提供焦点约束和键盘导航。
    return () => {
      dialog.close();
      returnFocus?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  useEffect(() => window.api.onNotesChanged(() => setNoteRevision((n) => n + 1)), []);

  useEffect(() => {
    let alive = true;
    setNote({ state: 'loading' });
    notesApi.get(noteId).then((data) => {
      if (!alive) return;
      knownSaved.current = true;
      setNote({ state: 'ready', data });
    }).catch((error: unknown) => {
      if (!alive) return;
      const unsaved = !hasSaved && !knownSaved.current && error instanceof Error && error.message.startsWith('API 404:');
      setNote(unsaved ? { state: 'ready', data: null } : { state: 'error' });
    });
    return () => { alive = false; };
  }, [noteId, hasSaved, refresh, noteRevision]);

  useEffect(() => {
    let alive = true;
    setRuntime({ state: 'loading' });
    setSync({ state: 'loading' });
    window.api.getRuntimeInfo().then((data) => {
      if (alive) setRuntime({ state: 'ready', data });
    }).catch(() => { if (alive) setRuntime({ state: 'error' }); });
    syncApi.getStatus().then((data) => {
      if (alive) setSync({ state: 'ready', data });
    }).catch(() => { if (alive) setSync({ state: 'error' }); });
    return () => { alive = false; };
  }, [refresh]);

  const formatDate = (value?: string) => {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime()) || date.getFullYear() <= 1) return null;
    return date.toLocaleString(i18n.language, { year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const pending = t('noteInfo.loading');
  const failed = t('noteInfo.loadFailed');
  const saved = note.state === 'ready' ? note.data : null;
  const notePlaceholder = note.state === 'loading' ? pending : note.state === 'error' ? failed : t('noteInfo.unsaved');
  const location = runtime.state === 'ready' && runtime.data.vaultPath && note.state === 'ready'
    ? noteDirectory(runtime.data.vaultPath, runtime.data.platform, saved?.inbox ?? false, saved?.folder ?? folder)
    : runtime.state === 'loading' || note.state === 'loading' ? pending : failed;
  const status = sync.state === 'ready' ? sync.data : null;
  const lastSuccess = formatDate(status?.lastSyncAt);
  const syncText = sync.state === 'loading' ? pending : sync.state === 'error' ? failed
    : !status?.configured ? t('noteInfo.syncNotConfigured')
      : !status.enabled ? t('noteInfo.syncDisabled')
        : status.lastError ? t('noteInfo.syncFailed')
          : lastSuccess ? t('noteInfo.syncSucceeded') : t('noteInfo.syncNever');
  const error = status?.lastError
    ? translateServerError(t, status.lastErrorCode, status.lastError) : null;
  const rows = [
    [t('noteInfo.id'), noteId],
    [t('noteInfo.title'), title],
    [t('noteInfo.location'), location],
    [t('noteInfo.created'), saved ? formatDate(saved.createdAt) ?? '—' : notePlaceholder],
    [t('noteInfo.saved'), saved ? formatDate(saved.updatedAt) ?? '—' : notePlaceholder],
    [t('noteInfo.sync'), syncText],
    ...(error ? [[t('noteInfo.syncError'), error]] : []),
    [t('noteInfo.lastSync'), sync.state === 'loading' ? pending : sync.state === 'error' ? failed : lastSuccess ?? t('noteInfo.syncNever')],
  ];

  return (
    <dialog ref={dialogRef} className="note-info" aria-labelledby="note-info-heading"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="note-info__panel">
        <header className="note-info__header">
          <h2 id="note-info-heading">{t('noteInfo.heading')}</h2>
          <button type="button" className="note-info__button" aria-label={t('noteInfo.close')} onClick={onClose} autoFocus>
            <XIcon />
          </button>
        </header>
        <div className="note-info__body">
          <dl className="note-info__fields">
            {rows.map(([label, value]) => (
              <div className="note-info__row" key={label}>
                <dt>{label}</dt><dd>{value}</dd>
              </div>
            ))}
          </dl>
          {note.state === 'ready' && !saved && <p className="note-info__hint">{t('noteInfo.plannedLocation')}</p>}
          <p className="note-info__hint">{t('noteInfo.syncScope')}</p>
          <button type="button" className="note-info__refresh" onClick={() => setRefresh((n) => n + 1)}>
            <ArrowsClockwiseIcon />{t('noteInfo.refresh')}
          </button>
        </div>
      </section>
    </dialog>
  );
}

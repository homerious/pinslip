import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NoteInfo from '../src/renderer/src/components/NoteInfo';
import MainView from '../src/renderer/src/views/MainView';
import NoteView from '../src/renderer/src/views/NoteView';
import i18n from '../src/renderer/src/i18n';
import '../src/renderer/src/styles/global.css';

const root = createRoot(document.getElementById('root')!);
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(fn: () => unknown) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await wait(); }
  throw new Error('Timed out waiting for view');
}
const baseNote = { id: '12345678aaaaaaaa', title: '同名便签', titleManual: true, content: '正文', folder: '', inbox: false,
  createdAt: '2026-10-20T08:00:00+08:00', updatedAt: '2026-10-26T10:20:30+08:00',
  tags: ['工作'], color: 'yellow', source: 'sticky', pin: true, collapsed: false, group: '', wordCount: 2, excerpt: '正文' };
let note = { ...baseNote };
let noteError = 0;
let syncError = false;
let runtimeError = false;
let runtime = { goPort: 17639, platform: 'win32', vaultPath: 'D:\\知识库', isPackaged: false, version: '1.1.0' };
let sync = { configured: true, enabled: true, lastSyncAt: '2026-10-26T09:00:00+08:00', lastError: '', lastErrorCode: '',
  ahead: 0, behind: 0, conflictedFiles: [], pushIntervalMin: 10, syncOnChange: false };
const listeners = new Set<() => void>();
const opened: string[] = [];
let rememberLayout = false;
let layoutFailure = false;
let noteShortcut = 'off';
let noteClipboard = false;
let clipboardFailure = false;
let initialContent: string | null = null;
let initialReads = 0;
const writes: Array<Record<string, unknown>> = [];
let resets = 0;
const layoutChanges: boolean[] = [];
const requests: Array<{ path: string; method: string }> = [];
(window as any).api = new Proxy({}, { get: (_, key: string) => {
  if (key === 'onNotesChanged') return (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  if (key.startsWith('on')) return () => () => {};
  if (key === 'getRuntimeInfo') return () => runtimeError ? Promise.reject(new Error('IPC unavailable')) : Promise.resolve(runtime);
  if (key === 'getAdvanced') return async () => ({ managerTheme: 'light', toolbarButtons: [], trayIcon: true, taskbarIcon: true,
    rememberManagerLayout: rememberLayout, blankNoteShortcut: noteShortcut, blankNoteClipboard: noteClipboard, quickCaptureShortcut: 'ctrl+shift+n' });
  if (key === 'setAdvanced') return async (patch: { rememberManagerLayout?: boolean; blankNoteShortcut?: string; blankNoteClipboard?: boolean }) => {
    if (layoutFailure || clipboardFailure) throw new Error('Settings unavailable');
    if (patch.rememberManagerLayout !== undefined) { rememberLayout = patch.rememberManagerLayout; layoutChanges.push(rememberLayout); }
    if (patch.blankNoteShortcut !== undefined) noteShortcut = patch.blankNoteShortcut;
    if (patch.blankNoteClipboard !== undefined) noteClipboard = patch.blankNoteClipboard;
    return { rememberManagerLayout: rememberLayout, blankNoteShortcut: noteShortcut, blankNoteClipboard: noteClipboard };
  };
  if (key === 'takeInitialNoteContent') return async () => { initialReads++; const text = initialContent; initialContent = null; return text; };
  if (key === 'resetManagerLayout') return async () => { if (layoutFailure) throw new Error('Layout unavailable'); resets++; };
  if (key === 'getUpdateState') return async () => ({ status: 'idle' });
  if (key === 'getGroupState') return async () => null;
  if (key === 'createNote') return async (id: string) => { opened.push(id); };
  return async () => false;
} });
window.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  requests.push({ path, method: init?.method ?? 'GET' });
  if (path.startsWith('/api/notes/') && init?.method === 'PUT') {
    const patch = JSON.parse(String(init.body)); writes.push(patch);
    note = { ...baseNote, ...patch, title: 'Clipboard heading', titleManual: false };
    return new Response(JSON.stringify(note));
  }
  if (path === '/api/sync/status') {
    if (syncError) throw new Error('Network unavailable');
    return new Response(JSON.stringify(sync));
  }
  if (path === '/api/notes') return new Response(JSON.stringify([note, { ...note, id: '12345678bbbbbbbb' }]));
  if (path === '/api/folders') return new Response(JSON.stringify({ folders: [] }));
  if (path === '/api/settings') return new Response(JSON.stringify({ trashRetentionDays: 30, mcpEnabled: true }));
  if (path === '/api/trash/stats') return new Response(JSON.stringify({ count: 0, bytes: 0 }));
  if (path.startsWith('/api/notes/')) return new Response(JSON.stringify(noteError ? { error: 'read failed' } : note), { status: noteError || 200 });
  throw new Error('Unexpected request: ' + path);
};
const emit = () => listeners.forEach((fn) => fn());
function Harness({ saved = true, folder = '' }: { saved?: boolean; folder?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return <><button ref={button} id="opener" onClick={() => setOpen(true)}>信息</button>
    {open && <NoteInfo noteId={note.id} title={note.title} folder={folder} hasSaved={saved} returnFocus={button.current} onClose={() => setOpen(false)} />}</>;
}
async function unmount() { root.render(<div />); await wait(); }
async function mount(saved = true, folder = '') {
  await unmount(); root.render(<Harness saved={saved} folder={folder} />);
  await until(() => document.getElementById('opener'));
  document.getElementById('opener')!.focus(); document.getElementById('opener')!.click();
  await until(() => document.querySelector('dialog[open]'));
  await until(() => !document.querySelector('.note-info')!.textContent!.includes(i18n.t('noteInfo.loading')));
}
function field(key: string) {
  return Array.from(document.querySelectorAll('.note-info__row')).find((r) => r.querySelector('dt')!.textContent === i18n.t('noteInfo.' + key))?.querySelector('dd')!.textContent ?? '';
}
async function refresh() {
  document.querySelector<HTMLButtonElement>('.note-info__refresh')!.click();
  await wait();
  await until(() => !document.querySelector('.note-info')!.textContent!.includes(i18n.t('noteInfo.loading')));
}

(window as any).runNoteInfoTests = async () => {
  const results: Array<{ name: string; error?: string }> = [];
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name }); } catch (e) { results.push({ name, error: String(e) }); }
  };
  await test('Three views: short ID, full hover, duplicate prefixes open distinct notes', async () => {
    root.render(<MainView />); await until(() => document.querySelectorAll('.note-list__id').length === 2);
    for (const tab of ['list', 'folders', 'tags']) {
      const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.main-view__tab')).find((b) => b.textContent?.trim() === i18n.t('tabs.' + tab))!;
      btn.click(); await wait();
      const ids = Array.from(document.querySelectorAll('.note-list__id'));
      check(ids.length === 2 && ids.every((id) => id.textContent === '12345678'), tab + ' short IDs');
      check(ids[0].getAttribute('title') === 'id：12345678aaaaaaaa' && ids[1].getAttribute('title') === 'id：12345678bbbbbbbb', 'Full ID tooltips');
    }
    const rows = document.querySelectorAll('.note-list__note');
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    check(opened.join(',') === '12345678aaaaaaaa,12345678bbbbbbbb', 'Full IDs must be used');
  });
  await test('Advanced layout switch: default off, enable, reset retains preference, disable, IPC failure', async () => {
    document.querySelector<HTMLButtonElement>('[title="' + i18n.t('header.settings') + '"]')!.click();
    await until(() => document.querySelector('.settings-panel__section--toggle'));
    document.querySelector<HTMLButtonElement>('.settings-panel__section--toggle')!.click();
    await until(() => document.querySelector('[aria-labelledby="manager-layout-label"]'));
    const toggle = document.querySelector<HTMLButtonElement>('[aria-labelledby="manager-layout-label"]')!;
    check(toggle.getAttribute('aria-checked') === 'false', 'Layout memory defaults off');
    toggle.click(); await wait(); check(toggle.getAttribute('aria-checked') === 'true', 'Enable succeeds');
    const reset = Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-panel__btn')).find((b) => b.textContent === i18n.t('settings.resetManagerLayout'))!;
    reset.click(); await wait(); check(resets === 1 && rememberLayout, 'Reset preserves preference');
    toggle.click(); await wait(); check(layoutChanges.join(',') === 'true,false', 'Disable persists false');
    layoutFailure = true; toggle.click(); await wait();
    check(toggle.getAttribute('aria-checked') === 'false' && document.body.textContent!.includes(i18n.t('settings.managerLayoutError')), 'IPC failure preserves current state and is visible');
    layoutFailure = false;
  });
  await test('Clipboard child setting: disabled parent, default off, enable, retain preference, failure rollback', async () => {
    const toggle = document.querySelector<HTMLButtonElement>('[aria-labelledby="note-clipboard-label"]')!;
    const select = document.querySelector<HTMLSelectElement>('[aria-label="' + i18n.t('settings.blankNoteShortcut') + '"]')!;
    check(toggle.disabled && toggle.getAttribute('aria-checked') === 'false', 'Parent off disables child');
    select.value = 'ctrl+alt+n'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait();
    check(!toggle.disabled && toggle.getAttribute('aria-checked') === 'false', 'Enabling parent does not auto-enable child');
    toggle.click(); await wait(); check(noteClipboard && toggle.getAttribute('aria-checked') === 'true', 'Child preference saved');
    select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait();
    check(toggle.disabled && noteClipboard && toggle.getAttribute('aria-checked') === 'true', 'Parent off retains child preference');
    select.value = 'ctrl+alt+n'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait();
    check(!toggle.disabled && toggle.getAttribute('aria-checked') === 'true', 'Re-enable restores saved child');
    clipboardFailure = true; toggle.click(); await wait();
    check(toggle.getAttribute('aria-checked') === 'true' && document.querySelector('[role="alert"]')?.textContent === i18n.t('settings.blankNoteClipboardError'), 'Failure visible and preference intact');
    clipboardFailure = false; toggle.click(); await wait(); check(!noteClipboard, 'Can retry');
  });
  await test('Saved fields: ID, title, actual directory, server timestamps', async () => {
    await mount();
    check(field('id') === note.id && field('title') === note.title, 'Identity');
    check(field('location') === 'D:\\知识库\\notes', 'Root directory');
    check(field('saved').includes('2026') && field('created').includes('2026'), 'Saved dates');
  });
  await test('Broadcast refresh reads nested/inbox location and latest save time', async () => {
    note = { ...note, folder: '工作/项目', updatedAt: '2026-10-26T12:34:56+08:00' }; emit(); await wait(60);
    check(field('location') === 'D:\\知识库\\notes\\工作\\项目' && field('saved').includes('12:34:56'), 'Nested directory / latest save');
    note = { ...note, inbox: true }; emit(); await wait(60);
    check(field('location') === 'D:\\知识库\\inbox', 'Inbox directory');
  });
  await test('Unsaved blank note keeps ID and planned directory without fabricated times', async () => {
    noteError = 404; await mount(false, '新目录');
    check(field('id') === note.id && field('saved') === i18n.t('noteInfo.unsaved'), 'Unsaved fields');
    check(field('location') === 'D:\\知识库\\notes\\新目录', 'Planned directory');
    noteError = 0;
  });
  await test('Read failures are distinct from unsaved/unconfigured and can retry', async () => {
    noteError = 503; syncError = true; runtimeError = true; await mount(false);
    check(field('saved') === i18n.t('noteInfo.loadFailed') && field('sync') === i18n.t('noteInfo.loadFailed'), 'Explicit read failures');
    noteError = 0; syncError = false; runtimeError = false; await refresh();
    check(field('saved').includes('2026') && field('sync') === i18n.t('noteInfo.syncSucceeded'), 'Retry recovers');
  });
  await test('Sync: unconfigured, disabled, never synced, success, failure with previous success', async () => {
    const cases = [
      [{ configured: false, enabled: false }, 'syncNotConfigured'],
      [{ configured: true, enabled: false }, 'syncDisabled'],
      [{ enabled: true, lastSyncAt: '0001-01-01T00:00:00Z' }, 'syncNever'],
      [{ lastSyncAt: 'invalid' }, 'syncNever'],
      [{ lastSyncAt: '2026-10-26T09:00:00+08:00' }, 'syncSucceeded'],
      [{ lastError: 'Offline', lastErrorCode: 'SYNC_PUSH_FAILED' }, 'syncFailed'],
    ] as const;
    for (const [change, key] of cases) {
      Object.assign(sync, change); await refresh();
      check(field('sync') === i18n.t('noteInfo.' + key), key);
    }
    check(field('syncError') === i18n.t('serverError.SYNC_PUSH_FAILED') && field('lastSync').includes('2026'), 'Failure details retain last success');
    sync.lastError = ''; sync.lastErrorCode = '';
  });
  await test('Cancel/close/backdrop dismiss modal and restore opener focus', async () => {
    for (const close of ['cancel','button','backdrop']) {
      await mount();
      const d = document.querySelector('dialog')!;
      if (close === 'cancel') d.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }));
      else if (close === 'button') document.querySelector<HTMLButtonElement>('.note-info__button')!.click();
      else d.click();
      await until(() => !document.querySelector('dialog'));
      check(document.activeElement?.id === 'opener', close + ' restores focus');
    }
  });
  await test('macOS/Linux paths and all seven locale keys', async () => {
    runtime = { ...runtime, platform: 'darwin', vaultPath: '/Users/test/Vault/' };
    note = { ...baseNote, folder: 'folder/deeper' }; await mount();
    check(field('location') === '/Users/test/Vault/notes/folder/deeper', 'POSIX directory');
    for (const lang of ['zh-CN','en','ja','ko','es','de','fr']) {
      await i18n.changeLanguage(lang); await wait();
      check(document.querySelector('h2')!.textContent === i18n.t('noteInfo.heading'), 'Heading translated: ' + lang);
      check(!document.querySelector('.note-info')!.textContent!.includes('noteInfo.'), 'No missing keys: ' + lang);
    }
    await i18n.changeLanguage('zh-CN');
    runtime = { ...runtime, platform: 'win32', vaultPath: 'D:\\知识库' };
  });
  await test('Actual note view exposes information in More and preserves window caption', async () => {
    await unmount();
    root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
    await until(() => document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]'));
    await wait(200);
    document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click();
    await wait();
    const entry = Array.from(document.querySelectorAll<HTMLButtonElement>('.sticky-note__menu-item')).find((b) => b.textContent === i18n.t('noteInfo.heading'));
    check(entry, 'Permanent More entry'); entry.click();
    await until(() => document.querySelector('dialog[open]'));
    check(document.title === note.title, 'System title stays unchanged');
    await wait(70);
    check(field('id') === note.id, 'Correct note ID in integrated modal');
  });
  await test('Viewing information never writes notes or starts synchronization', async () => {
    check(requests.every((r) => r.method === 'GET'), 'Only GET requests are allowed');
  });
  await test('Shortcut prefill survives StrictMode, initializes editor and autosaves without typing', async () => {
    await unmount();
    initialContent = '# Clipboard heading\n\nClipboard body'; initialReads = 0; writes.length = 0;
    const start = requests.length;
    root.render(<React.StrictMode><MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter></React.StrictMode>);
    await until(() => document.querySelector('.ProseMirror')?.textContent?.includes('Clipboard body'));
    await until(() => writes.length > 0);
    check(initialReads === 1, 'StrictMode must only consume bootstrap once');
    check(writes.length === 1 && String(writes[0].content).includes('Clipboard body'), 'Autosave includes initial content without typing');
    check(writes[0].source === 'sticky' && writes[0].folder === '' && writes[0].pin === true, 'Normal new note save defaults');
    check(!requests.slice(start).some(r => r.method === 'GET' && r.path === '/api/notes/' + note.id), 'No missing-note load to wipe prefill');
    check(document.title === 'Clipboard heading', 'Existing title derivation used');
    await unmount();
  });
  // 留下中文长路径信息视图供截图与最小尺寸布局检查。
  note = { ...baseNote, folder: '工作/一个很长的项目目录/调研资料' };
  await unmount();
  root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
  await until(() => document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]'));
  await wait(200);
  document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click();
  await wait();
  Array.from(document.querySelectorAll<HTMLButtonElement>('.sticky-note__menu-item')).find((b) => b.textContent === i18n.t('noteInfo.heading'))!.click();
  await until(() => document.querySelector('dialog[open]'));
  await until(() => field('location').includes('调研资料'));
  return results;
};
(window as any).showNoteListPreview = async () => {
  await unmount(); root.render(<MainView />);
  await until(() => document.querySelector('.note-list__id')); await wait();
};

(window as any).showManagerLayoutSettings = async (lang: string) => {
  await unmount(); await i18n.changeLanguage(lang); rememberLayout = true;
  root.render(<MainView />);
  await until(() => document.querySelector('[title="' + i18n.t('header.settings') + '"]'));
  document.querySelector<HTMLButtonElement>('[title="' + i18n.t('header.settings') + '"]')!.click();
  await until(() => document.querySelector('.settings-panel__section--toggle'));
  document.querySelector<HTMLButtonElement>('.settings-panel__section--toggle')!.click();
  await until(() => document.getElementById('manager-layout-label'));
  const row = document.getElementById('manager-layout-label')!.parentElement!;
  row.scrollIntoView({ block: 'center' }); await wait(100);
  check(row.scrollWidth <= row.clientWidth, 'Layout label/switch must fit: ' + lang);
};

(window as any).showClipboardSettings = async (lang: string) => {
  noteShortcut = 'ctrl+alt+n'; noteClipboard = true;
  await (window as any).showManagerLayoutSettings(lang);
  const row = document.getElementById('note-clipboard-label')!.parentElement!;
  row.scrollIntoView({ block: 'center' }); await wait(100);
  check(row.scrollWidth <= row.clientWidth, 'Clipboard label/switch must fit: ' + lang);
};

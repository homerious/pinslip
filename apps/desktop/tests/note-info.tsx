import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NoteInfo from '../src/renderer/src/components/NoteInfo';
import MainView from '../src/renderer/src/views/MainView';
import NoteView from '../src/renderer/src/views/NoteView';
import i18n from '../src/renderer/src/i18n';
import { copyText, toPlainText } from '../src/renderer/src/utils/copy-text';
import { TOOLBAR_BUTTON_DEFAULT_ORDER } from '../src/shared/toolbar';
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
let copyDefault = 'markdown';
let copySettingFailure = false;
let copyWriteFailure = false;
const copiedTexts: string[] = [];
const advancedListeners = new Set<(value: any) => void>();
let menuToolbarOrder: string[] = [];
const advanced = () => ({ managerTheme: 'light', toolbarButtons: menuToolbarOrder, trayIcon: true, taskbarIcon: true,
  rememberManagerLayout: rememberLayout, blankNoteShortcut: noteShortcut, blankNoteClipboard: noteClipboard,
  quickCaptureShortcut: 'ctrl+shift+n', copyAllFormat: copyDefault });
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text: string) => { if (copyWriteFailure) throw new Error('Clipboard unavailable'); copiedTexts.push(text); },
} });
let initialContent: string | null = null;
let initialReads = 0;
let flushHandler: (() => Promise<void>) | null = null;
let resumeHandler: (() => void) | null = null;
let saveFailure = false;
let holdSave: Promise<void> | null = null;
let initialGate: Promise<void> | null = null;
const closedNotes: Array<{ id: string; discard: boolean }> = [];
const writes: Array<Record<string, unknown>> = [];
let resets = 0;
const layoutChanges: boolean[] = [];
const requests: Array<{ path: string; method: string }> = [];
(window as any).api = new Proxy({}, { get: (_, key: string) => {
  if (key === 'onNotesChanged') return (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  if (key === 'onAdvancedChanged') return (fn: (value: any) => void) => { advancedListeners.add(fn); return () => advancedListeners.delete(fn); };
  if (key === 'onNoteFlushRequested') return (save: () => Promise<void>, resume: () => void) => {
    flushHandler = save; resumeHandler = resume;
    return () => { if (flushHandler === save) { flushHandler = null; resumeHandler = null; } };
  };
  if (key.startsWith('on')) return () => () => {};
  if (key === 'getRuntimeInfo') return () => runtimeError ? Promise.reject(new Error('IPC unavailable')) : Promise.resolve(runtime);
  if (key === 'getAdvanced') return async () => advanced();
  if (key === 'setAdvanced') return async (patch: { rememberManagerLayout?: boolean; blankNoteShortcut?: string; blankNoteClipboard?: boolean; copyAllFormat?: string }) => {
    if (layoutFailure || clipboardFailure || copySettingFailure) throw new Error('Settings unavailable');
    if (patch.rememberManagerLayout !== undefined) { rememberLayout = patch.rememberManagerLayout; layoutChanges.push(rememberLayout); }
    if (patch.blankNoteShortcut !== undefined) noteShortcut = patch.blankNoteShortcut;
    if (patch.blankNoteClipboard !== undefined) noteClipboard = patch.blankNoteClipboard;
    if (patch.copyAllFormat !== undefined) copyDefault = patch.copyAllFormat;
    const next = advanced(); advancedListeners.forEach(fn => fn(next)); return next;
  };
  if (key === 'takeInitialNoteContent') return async () => { initialReads++; const text = initialContent; initialContent = null; if (initialGate) await initialGate; return text; };
  if (key === 'closeNote') return async (id: string, discard: boolean) => { closedNotes.push({ id, discard }); };
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
    if (holdSave) await holdSave;
    if (saveFailure) return new Response('{"error":"disk unavailable"}', { status: 503 });
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
  await test('Plain text conversion: formatting, escaping, code, links, references, tasks, tables and deliberate blank lines', async () => {
    const cases = [
      ['# Heading\n\n**bold** and ~~old~~\n\n> quoted', 'Heading\nbold and old\nquoted'],
      ['\\*literal\\* and `# **code**`', '*literal* and # **code**'],
      ['```js\nconst x = "**#**";\n\nprint(x);\n```', 'const x = "**#**";\n\nprint(x);'],
      ['[site](https://example.com) and ![plot](../attachments/x.png)', 'site (https://example.com) and plot (../attachments/x.png)'],
      ['[site][A]\n\n[A]: https://example.com', 'site (https://example.com)'],
      ['3. Three\n4. Four', '3. Three\n4. Four'],
      ['- [x] done\n  - [ ] todo', '☑ done\n  ☐ todo'],
      ['| A | B |\n|---|---|\n| **one** | `#two` |', 'A\tB\none\t#two'],
      ['first\n\n<br/>\n\nlast', 'first\n\nlast'],
      ['first\r\n\r\nsecond', 'first\nsecond'],
    ];
    for (const [source, expected] of cases) check(toPlainText(source) === expected, JSON.stringify({ source, expected, actual: toPlainText(source) }));
    check(copyText('# H\n\n**B**', 'markdown') === '# H\n**B**', 'Existing compact Markdown unchanged');
  });
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
  await test('Copy all default setting: Markdown legacy default, failure preserves preference and broadcasts plain text', async () => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="' + i18n.t('copyFormat.defaultLabel') + '"]')!;
    check(select.value === 'markdown', 'Legacy default is Markdown');
    copySettingFailure = true; select.value = 'plain'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait();
    check(select.value === 'markdown' && document.body.textContent!.includes(i18n.t('copyFormat.settingFailed')), 'Failure must preserve old preference');
    copySettingFailure = false; select.value = 'plain'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait();
    check(select.value === 'plain' && copyDefault === 'plain', 'Default stored successfully');
    document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('settings.close') + '"]')!.click(); await wait(350);
  });
  await test('Manager Copy all: default, context override, no row click, viewport fit, keyboard focus and failure retry', async () => {
    note = { ...baseNote, content: '# Heading\n\n**Body**' }; emit(); await wait(60);
    const button = document.querySelector<HTMLButtonElement>('.note-list__copy-all')!;
    copiedTexts.length = 0; button.click(); await until(() => copiedTexts.length > 0);
    check(copiedTexts.at(-1) === 'Heading\nBody', 'Default plain text uses full content');
    const expanded = document.querySelectorAll('.note-list__preview.is-expanded').length;
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 1, clientY: innerHeight - 1 }));
    await until(() => document.querySelector('.copy-format-menu'));
    const rect = document.querySelector('.copy-format-menu')!.getBoundingClientRect();
    check(rect.right <= innerWidth && rect.bottom <= innerHeight && rect.left >= 0 && rect.top >= 0, 'Menu inside viewport');
    check(document.querySelectorAll('.note-list__preview.is-expanded').length === expanded, 'Right-click does not expand row');
    document.querySelector<HTMLButtonElement>('.copy-format-menu button')!.click(); await wait();
    check(copiedTexts.at(-1) === '# Heading\n**Body**' && copyDefault === 'plain', 'Temporary Markdown does not persist');
    button.click(); await wait(); check(copiedTexts.at(-1) === 'Heading\nBody', 'Next click still uses default');
    button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); await wait();
    const menu = document.querySelector<HTMLElement>('.copy-format-menu')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(document.activeElement?.textContent === i18n.t('copyFormat.asPlain'), 'Arrow navigation');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
    check(!document.querySelector('.copy-format-menu') && document.activeElement === button, 'Esc restores copy focus');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })); await wait();
    document.querySelector('.copy-format-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait();
    check(!document.querySelector('.copy-format-menu') && copiedTexts.at(-1) === '# Heading\n**Body**' && copyDefault === 'plain', 'Menu key and Enter copy temporarily');
    copyWriteFailure = true; const before = copiedTexts.length; button.click(); await wait();
    check(copiedTexts.length === before && button.title === i18n.t('copyFormat.failed'), 'Failure visible and no success');
    copyWriteFailure = false; button.click(); await wait(); check(copiedTexts.length === before + 1, 'Retry succeeds');
    note = { ...baseNote }; copyDefault = 'markdown'; advancedListeners.forEach(fn => fn(advanced())); emit(); await wait();
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
      for (const key of ['choose','asMarkdown','asPlain','markdown','plain','tip','failed','defaultLabel','defaultHint','settingFailed']) {
        check(Boolean(i18n.getResource(lang, 'translation', 'copyFormat.' + key)), 'Copy translation: ' + lang + '/' + key);
      }
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
  const mountNote = async (text: string | null = null, missing = false, body = baseNote.content) => {
    await unmount(); note = { ...baseNote, content: body }; noteError = missing ? 404 : 0; initialContent = text; writes.length = 0;
    root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
    await until(() => flushHandler && document.querySelector('.ProseMirror'));
  };
  await test('Close flush: untouched saved/blank notes do not write; clipboard prefill saves immediately', async () => {
    await mountNote(); await flushHandler!(); check(writes.length === 0, 'Opening and closing must not normalize/rewrite existing Markdown');
    await mountNote(null, true); await flushHandler!(); check(writes.length === 0, 'Blank new note stays unsaved');
    await mountNote('# Clipboard heading\n\nImmediate close', true);
    await flushHandler!(); check(writes.length === 1 && String(writes[0].content).includes('Immediate close'), 'Prefill saved before debounce');
    check(document.querySelector<HTMLElement>('.sticky-note')!.inert, 'Successful prepare pauses editing');
    resumeHandler!(); check(!document.querySelector<HTMLElement>('.sticky-note')!.inert, 'Cancelled close resumes editing');
  });
  await test('Close flush captures typing before Milkdown listener and retries failed saves', async () => {
    await mountNote();
    const pm = document.querySelector<HTMLElement>('.ProseMirror')!;
    pm.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'Last keystroke');
    saveFailure = true;
    let rejected = false; try { await flushHandler!(); } catch { rejected = true; }
    check(rejected && !document.querySelector<HTMLElement>('.sticky-note')!.inert, 'Failure preserves window and releases editing');
    check(String(writes.at(-1)!.content).includes('Last keystroke'), 'Real editor contents bypass listener delay');
    saveFailure = false; await flushHandler!();
    check(String(writes.at(-1)!.content).includes('Last keystroke'), 'Retry retains last input');
  });
  await test('Close requested during initial clipboard loading waits for content before saving', async () => {
    await unmount(); noteError = 404; initialContent = 'Clipboard during startup'; writes.length = 0;
    let release!: () => void; initialGate = new Promise<void>(resolve => { release = resolve; });
    root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
    await until(() => flushHandler);
    let done = false; const closing = flushHandler!().then(() => { done = true; });
    await wait(60); check(!done && writes.length === 0, 'Must await initial content');
    initialGate = null; release(); await closing;
    check(writes.length === 1 && writes[0].content === 'Clipboard during startup', 'Initialization text saved before close');
    noteError = 0;
  });
  await test('Close flush waits for an old save then persists the newest editor contents', async () => {
    await mountNote('# Clipboard heading\n\nOld snapshot', true);
    let release!: () => void; holdSave = new Promise<void>(resolve => { release = resolve; });
    await until(() => writes.length === 1);
    const pm = document.querySelector<HTMLElement>('.ProseMirror')!;
    pm.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'Newest snapshot');
    let done = false; const closing = flushHandler!().then(() => { done = true; });
    await wait(70); check(!done && writes.length === 1, 'Must wait for in-flight save');
    holdSave = null; release(); await closing;
    check(writes.length === 2 && String(writes[1].content).includes('Newest snapshot'), 'Last snapshot is saved last');
    noteError = 0;
  });
  await test('Conflict resolution draft remains explicit and prevents close until saved', async () => {
    await unmount(); noteError = 0; note = { ...baseNote, content: '<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> branch' };
    root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
    await until(() => flushHandler && document.querySelector('.sticky-note__conflict-textarea'));
    const textarea = document.querySelector<HTMLTextAreaElement>('.sticky-note__conflict-textarea')!;
    textarea.value += '\nUncommitted resolution';
    writes.length = 0; let rejected = false; try { await flushHandler!(); } catch { rejected = true; }
    check(rejected && writes.length === 0 && textarea.value.includes('Uncommitted resolution'), 'Draft preserved without silent save');
  });
  await test('Confirmed deletion bypasses close flush and cancels pending autosave', async () => {
    await mountNote('Delete this unsaved prefill', true); closedNotes.length = 0;
    document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click(); await wait();
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.sticky-note__menu-item')).find(b => b.textContent?.trim() === i18n.t('note.deleteNote'))!;
    check(button, 'Delete action exists'); button.click(); await wait(); button.click();
    await until(() => closedNotes.length > 0); await wait(1050);
    check(closedNotes[0].discard === true && writes.length === 0, 'No flush/upsert for deliberately deleted note');
    noteError = 0;
  });
  await test('Note Copy all: shared live default, More formats, fresh editor content and no save side effect', async () => {
    await mountNote(null, false, '# Heading\n\n**Body**'); copiedTexts.length = 0;
    const more = () => document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click();
    const entry = (format: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.sticky-note__menu--more button')).find(b => b.textContent?.trim() === i18n.t('copyFormat.' + format))!;
    more(); await wait(); check(entry('asPlain') && entry('asMarkdown'), 'Both fallback entries always available');
    entry('asPlain').click(); await wait(); check(copiedTexts.at(-1) === 'Heading\nBody' && copyDefault === 'markdown', 'More choice is temporary');
    copyDefault = 'plain'; advancedListeners.forEach(fn => fn(advanced())); await wait();
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.copyAll') + '"]');
    check(copy, 'Wide note exposes the toolbar copy button');
    if (copy) {
      copy.click(); await wait(); check(copiedTexts.at(-1) === 'Heading\nBody', 'Live default used by existing note');
      copy.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await wait();
      document.querySelector<HTMLButtonElement>('.copy-format-menu button')!.click(); await wait();
      check(copiedTexts.at(-1) === '# Heading\n**Body**', 'Toolbar context chooses Markdown');
    }
    const pm = document.querySelector<HTMLElement>('.ProseMirror')!;
    pm.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, '# Fresh **typing**');
    // 让浏览器的 DOM observer 提交这次输入，但不等待 listener 的 200ms 防抖。
    await Promise.resolve();
    if (copy) copy.click();
    else { more(); await wait(); entry('asPlain').click(); }
    await wait(); check(copiedTexts.at(-1)!.includes('Fresh **typing**'), 'Fresh literal input preserved before listener: ' + copiedTexts.at(-1));
    check(writes.length === 0, 'Copy must not force save');
    copyDefault = 'markdown'; advancedListeners.forEach(fn => fn(advanced()));
    await unmount();
  });
  await test('Popup menus: shared appearance, export follows reordered button, keyboard dismissal', async () => {
    await mountNote(); await wait(100);
    document.querySelector('.sticky-note')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await wait(200);
    const look = (menu: Element) => {
      const box = getComputedStyle(menu); const item = getComputedStyle(menu.querySelector('button')!);
      return JSON.stringify([box.backgroundColor, box.border, box.borderRadius, box.boxShadow, box.padding,
        item.fontSize, item.padding, item.borderRadius, item.color]);
    };
    document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click(); await wait();
    const existing = look(document.querySelector('.sticky-note__menu--more')!);
    document.querySelector<HTMLButtonElement>('.sticky-note__backdrop')!.click(); await wait();
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.copyAll') + '"]')!;
    copy.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await wait();
    check(look(document.querySelector('.copy-format-menu')!) === existing, 'Copy matches existing menu appearance');
    document.querySelector('.copy-format-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
    menuToolbarOrder = ['export', ...TOOLBAR_BUTTON_DEFAULT_ORDER.filter(id => id !== 'export')];
    advancedListeners.forEach(fn => fn(advanced())); await wait(100);
    const button = () => document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.exportImage') + '"]')!;
    button().click(); await wait();
    const first = document.querySelector('.sticky-note__menu--export')!;
    check(look(first) === existing, 'Export matches existing menu appearance');
    const firstLeft = first.getBoundingClientRect().left;
    check(Math.abs(firstLeft - button().getBoundingClientRect().left) < 1, 'Export starts at actual first button');
    menuToolbarOrder = [...TOOLBAR_BUTTON_DEFAULT_ORDER]; advancedListeners.forEach(fn => fn(advanced())); await wait(100);
    const menu = document.querySelector('.sticky-note__menu--export')!;
    const r = menu.getBoundingClientRect(); const b = button().getBoundingClientRect();
    check(r.left > firstLeft + 80 && Math.abs(r.left - b.left) < 1 && r.bottom <= b.top - 3, 'Open export follows reorder and stays above button');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(document.activeElement?.textContent?.includes(i18n.t('note.exportSave')), 'Export keyboard selection');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
    check(!document.querySelector('.sticky-note__menu--export') && document.activeElement === button(), 'Export Esc closes and restores focus');
    menuToolbarOrder = []; advancedListeners.forEach(fn => fn(advanced())); await unmount();
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

(window as any).showCopyMenuPreview = async (lang: string) => {
  await unmount(); await i18n.changeLanguage(lang); note = { ...baseNote };
  root.render(<MainView />); await until(() => document.querySelector('.note-list__copy-all'));
  const button = document.querySelector<HTMLButtonElement>('.note-list__copy-all')!;
  button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 12, clientY: innerHeight - 12 }));
  await until(() => document.querySelector('.copy-format-menu')); await wait();
  const r = document.querySelector('.copy-format-menu')!.getBoundingClientRect();
  check(r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, 'Copy menu preview fits: ' + lang);
};
(window as any).showCopySettingPreview = async (lang: string) => {
  await (window as any).showManagerLayoutSettings(lang);
  const select = document.querySelector<HTMLSelectElement>('[aria-label="' + i18n.t('copyFormat.defaultLabel') + '"]')!;
  select.parentElement!.scrollIntoView({ block: 'center' }); await wait();
  check(select.parentElement!.scrollWidth <= select.parentElement!.clientWidth, 'Copy setting fits: ' + lang);
};
(window as any).showNoteMorePreview = async (lang: string) => {
  await unmount(); await i18n.changeLanguage(lang); note = { ...baseNote }; noteError = 0;
  root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
  await until(() => document.querySelector('[aria-label="' + i18n.t('note.more') + '"]'));
  await wait(100); document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click(); await wait();
  const menu = document.querySelector<HTMLElement>('.sticky-note__menu--more')!;
  const r = menu.getBoundingClientRect();
  check(r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, 'More menu fits minimum window: ' + lang);
  check(menu.scrollHeight > menu.clientHeight, 'Long More menu scrolls');
};

(window as any).showExportMenuPreview = async (lang: string, first: boolean) => {
  await unmount(); await i18n.changeLanguage(lang); note = { ...baseNote }; noteError = 0;
  menuToolbarOrder = first ? ['export', ...TOOLBAR_BUTTON_DEFAULT_ORDER.filter(id => id !== 'export')] : [...TOOLBAR_BUTTON_DEFAULT_ORDER];
  root.render(<MemoryRouter initialEntries={['/note/' + note.id]}><Routes><Route path="/note/:noteId" element={<NoteView />} /></Routes></MemoryRouter>);
  await until(() => document.querySelector('[aria-label="' + i18n.t('note.exportImage') + '"]'));
  document.querySelector('.sticky-note')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await wait(200);
  const button = document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.exportImage') + '"]')!;
  button.click(); await until(() => document.querySelector('.sticky-note__menu--export')); await wait();
  const r = document.querySelector('.sticky-note__menu--export')!.getBoundingClientRect(); const b = button.getBoundingClientRect();
  check(r.width > 0 && r.height > 0 && r.left >= 8 && r.top >= 8 && r.right <= innerWidth && r.bottom <= innerHeight, 'Export fits viewport: ' + lang);
  check(Math.abs(r.left - Math.max(8, Math.min(b.left, innerWidth - r.width - 8))) < 1, 'Export follows anchor: ' + lang);
};
(window as any).checkHiddenExportMenu = async () => {
  await wait(200);
  check(!document.querySelector('.sticky-note__menu--export'), 'Resize closes export popup');
  check(!document.querySelector('[aria-label="' + i18n.t('note.exportImage') + '"]'), 'Narrow toolbar hides trailing export');
  document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')!.click(); await wait();
  const items = document.querySelector('.sticky-note__menu--more')!.textContent!;
  check(items.includes(i18n.t('note.exportCopy')) && items.includes(i18n.t('note.exportSave')), 'Both export actions remain in More');
  menuToolbarOrder = [];
};

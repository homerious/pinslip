import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Editor as MilkdownCore, editorViewCtx } from '@milkdown/core';
import Editor, { type EditorHandle } from '../src/renderer/src/components/editor/Editor';
import NoteView from '../src/renderer/src/views/NoteView';
import MainView from '../src/renderer/src/views/MainView';
import i18n from '../src/renderer/src/i18n';
import type { Note, WritingDirection } from '../src/shared/types';
import '../src/renderer/src/styles/global.css';

const root = createRoot(document.getElementById('root')!);
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function until(fn: () => unknown) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await wait(); }
  throw Error('Timed out: ' + document.body.innerText.slice(0, 300));
}
let activeEditor: MilkdownCore | undefined;
const make = MilkdownCore.make;
MilkdownCore.make = () => (activeEditor = make());
const sample = 'سلام 123 (hello)\n\nEnglish paragraph\n\n- سلام\n  - nested\n\n- [ ] سلام task\n\n> سلام\n\n```js\nconst a = 1\n```\n\n| سلام | English |\n| --- | --- |\n| مقدار | value |';
let note: Note = { id: 'direction01', title: 'Direction', content: sample, tags: [], color: 'yellow', pin: false,
  collapsed: false, source: 'sticky', group: '', folder: '', inbox: false, createdAt: '', updatedAt: '' };
let defaultDirection: WritingDirection = 'auto';
let settingsFailure = false;
let saveFailure = false;
let missing = false;
let flush: (() => Promise<void>) | null = null;
const writes: Record<string, unknown>[] = [];
const listeners = new Set<(a: any) => void>();
const noteListeners = new Set<() => void>();
const advanced = () => ({ writingDirection: defaultDirection, toolbarButtons: [], copyAllFormat: 'markdown',
  managerTheme: 'light', trayIcon: true, taskbarIcon: true, blankNoteShortcut: 'off', quickCaptureShortcut: 'ctrl+shift+n' });
(window as any).api = new Proxy({}, { get: (_, key: string) => {
  if (key === 'getRuntimeInfo') return async () => ({ goPort: 17639, vaultPath: 'D:\\test', platform: 'win32' });
  if (key === 'getAdvanced') return async () => advanced();
  if (key === 'setAdvanced') return async (patch: any) => {
    if (settingsFailure) throw Error('disk full');
    defaultDirection = patch.writingDirection ?? defaultDirection;
    const value = advanced(); listeners.forEach(fn => fn(value)); return value;
  };
  if (key === 'onAdvancedChanged') return (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); };
  if (key === 'onNotesChanged') return (fn: any) => { noteListeners.add(fn); return () => noteListeners.delete(fn); };
  if (key === 'notifyNotesChanged') return () => noteListeners.forEach(fn => fn());
  if (key === 'onNoteFlushRequested') return (fn: any) => { flush = fn; return () => { flush = null; }; };
  if (key.startsWith('on')) return () => () => {};
  if (key === 'getUpdateState') return async () => ({ status: 'idle' });
  if (key === 'getGroupState' || key === 'takeInitialNoteContent') return async () => null;
  return async () => false;
} });
window.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path.startsWith('/api/notes/') && init?.method === 'PUT') {
    const patch = JSON.parse(String(init.body)); writes.push(patch);
    if (saveFailure) return new Response('{}', { status: 503 });
    note = { ...note, ...patch }; missing = false; return Response.json(note);
  }
  if (path === '/api/notes') return Response.json([note]);
  if (path === '/api/folders') return Response.json({ folders: [] });
  if (path === '/api/settings') return Response.json({ trashRetentionDays: 30 });
  if (path === '/api/trash/stats') return Response.json({ count: 0, bytes: 0 });
  if (path === '/api/sync/status') return Response.json({ configured: false });
  if (path.startsWith('/api/notes/')) return Response.json(missing ? {} : note, { status: missing ? 404 : 200 });
  throw Error(path);
};
async function unmount() { root.render(<div />); await wait(50); }
async function mountNote() {
  await unmount();
  root.render(<MemoryRouter initialEntries={['/note/direction01']}><Routes>
    <Route path="/note/:noteId" element={<NoteView />} />
  </Routes></MemoryRouter>);
  await until(() => document.querySelector('.ProseMirror'));
  await wait(100);
}
const pm = () => document.querySelector<HTMLElement>('.ProseMirror')!;
const dir = (selector: string) => getComputedStyle(document.querySelector(selector)!).direction;
function key(target: Element, type: string, code: string, ctrlKey: boolean, shiftKey: boolean, extra = {}) {
  target.dispatchEvent(new KeyboardEvent(type, { code, key: code.startsWith('Control') ? 'Control' : code.startsWith('Shift') ? 'Shift' : code.slice(-1),
    ctrlKey, shiftKey, bubbles: true, cancelable: true, ...extra }));
}
function gesture(control: string, { reverse = false, combo = '', target = pm() } = {}) {
  if (reverse) {
    key(target, 'keydown', 'ShiftLeft', false, true);
    key(target, 'keydown', control, true, true);
  } else {
    key(target, 'keydown', control, true, false);
    key(target, 'keydown', 'ShiftRight', true, true);
  }
  if (combo) { key(target, 'keydown', combo, true, true); key(target, 'keyup', combo, true, true); }
  key(target, 'keyup', control, false, true);
  key(target, 'keyup', 'ShiftRight', false, false);
}
async function runDirectionTests() {
  const results: { name: string; error?: string }[] = [];
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name }); } catch (e) { results.push({ name, error: String(e) }); }
  };
  await i18n.changeLanguage('en');
  await test('Auto: paragraphs, list markers, tasks and quotes follow their content', async () => {
    await mountNote();
    check(dir('.ProseMirror > p:first-child') === 'rtl', 'Persian paragraph');
    check(dir('.ProseMirror > p:nth-child(2)') === 'ltr', 'English paragraph');
    check(dir('.ProseMirror li') === 'rtl', 'List marker direction');
    check(dir('.ProseMirror li li') === 'ltr', 'Nested item direction');
    const li = document.querySelector<HTMLElement>('li[data-item-type="task"]')!;
    const box = li.querySelector('.pinslip-task-check')!.getBoundingClientRect();
    check(getComputedStyle(li).direction === 'rtl' && box.left > li.getBoundingClientRect().left + li.clientWidth / 2, 'Task box at right');
    check(dir('.ProseMirror blockquote') === 'rtl', 'Quote direction');
    check(dir('.ProseMirror pre') === 'ltr' && dir('.ProseMirror table') === 'ltr', 'Code and column order');
    check(dir('.ProseMirror th') === 'rtl', 'Cell direction');
  });
  await test('Shortcuts apply to whole note, preserve Markdown, persist and survive reopening', async () => {
    const before = note.content;
    gesture('ControlRight'); await until(() => note.direction === 'rtl');
    check(dir('.ProseMirror > p:nth-child(2)') === 'rtl', 'Entire note forced RTL');
    check(note.content === before && writes.at(-1)?.direction === 'rtl', 'Only metadata saved');
    await mountNote(); check(dir('.ProseMirror') === 'rtl', 'Reopened RTL');
    gesture('ControlLeft', { reverse: true }); await until(() => note.direction === 'ltr');
    check(dir('.ProseMirror > p:first-child') === 'ltr', 'Shift-first LTR');
    const li = document.querySelector('li[data-item-type="task"]')!;
    check(li.querySelector('.pinslip-task-check')!.getBoundingClientRect().left < li.getBoundingClientRect().left + li.clientWidth / 2, 'Task box at left');
  });
  await test('Other Ctrl+Shift combinations, Alt, IME, blur and non-editor fields do not switch', async () => {
    const count = writes.length;
    gesture('ControlRight', { combo: 'KeyV' }); gesture('ControlRight', { combo: 'KeyZ' });
    const input = document.createElement('input'); document.body.append(input);
    gesture('ControlRight', { target: input }); input.remove();
    key(pm(), 'keydown', 'ControlRight', true, false);
    key(pm(), 'keydown', 'ShiftRight', true, true, { isComposing: true });
    key(pm(), 'keyup', 'ControlRight', false, true); key(pm(), 'keyup', 'ShiftRight', false, false);
    key(pm(), 'keydown', 'ControlRight', true, false);
    key(pm(), 'keydown', 'ShiftRight', true, true, { altKey: true });
    key(pm(), 'keyup', 'ControlRight', false, true); key(pm(), 'keyup', 'ShiftRight', false, false);
    key(pm(), 'keydown', 'ControlRight', true, false); key(pm(), 'keydown', 'ShiftRight', true, true);
    window.dispatchEvent(new Event('blur'));
    key(pm(), 'keyup', 'ControlRight', false, true); key(pm(), 'keyup', 'ShiftRight', false, false);
    await wait(); check(writes.length === count && note.direction === 'ltr', 'Unexpected direction save');
  });
  await test('Follow default clears override; broadcasts update inherited notes but preserve overrides', async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('note.more') + '"]')?.click();
    await until(() => document.querySelector('[role="menuitemradio"]'));
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click();
    await until(() => note.direction === '');
    defaultDirection = 'rtl'; listeners.forEach(fn => fn(advanced())); await wait(100);
    check(dir('.ProseMirror > p:nth-child(2)') === 'rtl', 'Inherited RTL broadcast');
    gesture('ControlLeft'); await until(() => note.direction === 'ltr');
    defaultDirection = 'auto'; listeners.forEach(fn => fn(advanced())); await wait(100);
    check(dir('.ProseMirror > p:first-child') === 'ltr', 'Manual override preserved');
  });
  await test('Failed metadata write is retried by close flush with latest direction', async () => {
    saveFailure = true; gesture('ControlRight'); await wait(80);
    check(note.direction === 'ltr', 'Failed save changed server');
    saveFailure = false; check(flush, 'Close flush missing'); await flush();
    check(note.direction === 'rtl', 'Flush lost latest direction');
    await mountNote();
  });
  await test('Default direction settings persist and display save failure without false success', async () => {
    await unmount(); root.render(<MainView />);
    await until(() => document.querySelector('.main-view'));
    const gear = document.querySelector<HTMLButtonElement>('[title="' + i18n.t('header.settings') + '"]');
    gear?.click(); await wait();
    const advancedButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.title === i18n.t('settings.advancedExpand'));
    advancedButton?.click(); await until(() => document.querySelector('#writing-direction'));
    const select = document.querySelector<HTMLSelectElement>('#writing-direction')!;
    select.value = 'rtl'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => defaultDirection === 'rtl');
    settingsFailure = true; select.value = 'ltr'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(80); check(defaultDirection === 'rtl' && select.value === 'rtl', 'Failed setting changed state');
    check(document.body.textContent?.includes(i18n.t('writingDirection.settingFailed')), 'Error feedback missing');
    settingsFailure = false;
  });
  await test('Decorations survive edits but never enter Markdown; table columns remain stable', async () => {
    await unmount();
    let saved = ''; const ref = createRef<EditorHandle>();
    root.render(<Editor content={sample} direction="rtl" onChange={s => { saved = s; }} ref={ref} />);
    await until(() => ref.current?.getHTML() != null); await wait(80);
    const view = activeEditor!.action(ctx => ctx.get(editorViewCtx));
    view.dispatch(view.state.tr.insertText('X', 1)); await wait(300);
    check(saved.includes('Xسلام') && !/<[^>]+>|[\u200e\u200f\u202a-\u202e]/.test(saved), 'Direction leaked into Markdown: ' + saved);
    check(dir('.ProseMirror table') === 'ltr' && dir('.ProseMirror pre') === 'ltr', 'Code/table changed');
    check(document.querySelectorAll('th')[0].textContent === 'سلام', 'Column order changed');
    root.render(<Editor content={sample} direction="auto" onChange={() => {}} ref={ref} />); await wait(80);
    check(dir('.ProseMirror > p:nth-child(2)') === 'ltr', 'Mode update failed');
  });
  await test('Unsaved blank note remembers direction for first content save', async () => {
    note = { ...note, content: '', direction: '' }; missing = true;
    const before = writes.length;
    await mountNote(); gesture('ControlRight'); await wait();
    check(writes.length === before, 'Direction alone created an empty file');
    const view = activeEditor!.action(ctx => ctx.get(editorViewCtx));
    view.dispatch(view.state.tr.insertText('سلام', 1));
    await until(() => !missing);
    check(note.direction === 'rtl' && note.content.includes('سلام'), 'Initial save lost direction');
  });
  await unmount(); return results;
}
(window as any).runDirectionTests = runDirectionTests;
(window as any).prepareNativeDirectionTest = async () => {
  note.direction = 'ltr'; defaultDirection = 'auto';
  await mountNote(); pm().focus();
  (window as any).nativeDirectionEvents = [];
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, (e: Event) => {
    const k = e as KeyboardEvent;
    (window as any).nativeDirectionEvents.push({ type, code: k.code, ctrl: k.ctrlKey, shift: k.shiftKey,
      target: (k.target as HTMLElement)?.className });
  });
};
(window as any).checkNativeDirection = async (expected: string) => {
  try { await until(() => note.direction === expected); }
  catch { throw Error('Native events: ' + JSON.stringify((window as any).nativeDirectionEvents)); }
  check(dir('.ProseMirror') === expected, 'Native key changed metadata but not layout');
};

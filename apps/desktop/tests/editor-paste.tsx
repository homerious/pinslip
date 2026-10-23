import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { undo } from '@milkdown/prose/history';
import { Editor as MilkdownCore, editorViewCtx, parserCtx } from '@milkdown/core';
import Editor, { type EditorHandle } from '../src/renderer/src/components/editor/Editor';
import { toCompactMarkdown } from '../src/renderer/src/utils/compact-markdown';

const root = createRoot(document.getElementById('root')!);
let activeEditor: MilkdownCore | undefined;
const make = MilkdownCore.make;
MilkdownCore.make = () => {
  activeEditor = make();
  return activeEditor;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function mount(content = '') {
  root.render(<div />);
  await wait(20);
  activeEditor = undefined;
  let markdown = content;
  const ref = createRef<EditorHandle>();
  root.render(<Editor content={content} onChange={(value) => { markdown = value; }} ref={ref} />);
  for (let i = 0; i < 100; i++) {
    const dom = document.querySelector('.ProseMirror') as HTMLElement;
    if (dom && activeEditor && ref.current?.getHTML() !== null) {
      const view = activeEditor.action((ctx) => ctx.get(editorViewCtx));
      return { view, dom, ref, markdown: () => markdown };
    }
    await wait(20);
  }
  throw new Error('Editor not ready');
}

function paste(view: EditorView, text: string, { html = '', plain = false, image = false } = {}) {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (html) data.setData('text/html', html);
  if (image) data.items.add(new File(['image'], 'paste.png', { type: 'image/png' }));
  // 通过真实 DOM 事件驱动 PM 的 preferPlain 分支，不直接调用解析回调。
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: plain, bubbles: true }));
  view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  view.dom.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', keyCode: 16, bubbles: true }));
}

async function runPasteTests() {
  const results: { name: string; error?: string }[] = [];
  async function test(name: string, run: () => Promise<void>) {
    try { await run(); results.push({ name }); }
    catch (error) { results.push({ name, error: String(error) }); }
  }
  const cases = [
    ['heading', '# 标题', 'h1'],
    ['strong', '**加粗**', 'strong'],
    ['emphasis', '*斜体*', 'em'],
    ['strikethrough', '~~删除~~', 'del'],
    ['inline code', '`const x = 1`', 'code'],
    ['link', '[链接](https://example.com)', 'a[href="https://example.com"]'],
    ['bullet list', '- 第一项\n- 第二项', 'ul > li'],
    ['ordered list', '1. 第一项\n2. 第二项', 'ol > li'],
    ['task list', '- [x] 完成\n- [ ] 待办', 'li[data-item-type="task"][data-checked="true"]'],
    ['blockquote', '> 引用', 'blockquote'],
    ['fenced code', '```js\nconst x = 1\n```', 'pre > code'],
    ['table', '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |', 'table'],
  ];
  for (const [name, text, selector] of cases) {
    await test(name, async () => {
      const { view, dom } = await mount();
      paste(view, text);
      check(dom.querySelector(selector), `${selector} missing: ${dom.innerHTML}`);
    });
  }
  await test('copy-all Markdown and save round trip', async () => {
    const source = '# 标题\n\n**重点**\n\n- [x] 完成\n- [ ] 待办';
    const { view, dom, markdown } = await mount();
    paste(view, toCompactMarkdown(source));
    check(dom.querySelector('h1') && dom.querySelector('strong'), dom.innerHTML);
    check(dom.querySelectorAll('li[data-item-type="task"]').length === 2, 'task list missing');
    await wait(300);
    check(markdown().includes('# 标题') && markdown().includes('- [x] 完成'), markdown());
    const reopened = await mount(markdown());
    check(reopened.dom.querySelector('h1') && reopened.dom.querySelector('strong'), 'saved format lost');
  });
  await test('Ctrl+Shift+V preserves source even with HTML', async () => {
    const { view, dom } = await mount();
    paste(view, '# 标题\n**加粗**', { plain: true, html: '<h1>标题</h1><strong>加粗</strong>' });
    check(!dom.querySelector('h1,strong') && dom.textContent === '# 标题**加粗**', dom.innerHTML);
  });
  await test('code block preserves source', async () => {
    const { view, dom } = await mount('```text\n原文\n```');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    paste(view, '# 标题\n**加粗**');
    check(!dom.querySelector('h1,strong') && dom.querySelector('code')?.textContent?.includes('**加粗**'), dom.innerHTML);
  });
  await test('HTML takes precedence', async () => {
    const { view, dom } = await mount();
    paste(view, '**源码标记**', { html: '<p><em>富文本</em></p>' });
    check(dom.querySelector('em')?.textContent === '富文本' && !dom.querySelector('strong'), dom.innerHTML);
  });
  await test('selection replacement and one-step undo', async () => {
    const { view, dom } = await mount('前文旧文后文');
    const before = view.state.doc.toJSON();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 5)));
    paste(view, '**新文**\n\n- 条目');
    check(dom.textContent?.includes('前文新文') && dom.textContent.includes('后文') && !dom.textContent.includes('旧文'), dom.innerHTML);
    check(dom.querySelector('strong') && dom.querySelector('li'), dom.innerHTML);
    check(undo(view.state, view.dispatch), 'undo failed');
    check(JSON.stringify(view.state.doc.toJSON()) === JSON.stringify(before), dom.innerHTML);
  });
  await test('plain prose and CRLF', async () => {
    const { view, dom } = await mount();
    paste(view, '普通正文\r\n\r\n第二段');
    check(dom.querySelectorAll('p').length === 2 && dom.textContent === '普通正文第二段', dom.innerHTML);
  });
  await test('parser failure preserves clipboard text', async () => {
    const { view, dom } = await mount();
    activeEditor!.action((ctx) => { ctx.set(parserCtx, () => { throw new Error('test parser failure'); }); });
    paste(view, '# 保留原文\n**加粗源码**');
    check(!dom.querySelector('h1,strong') && dom.textContent === '# 保留原文**加粗源码**', dom.innerHTML);
  });
  await test('image upload still takes precedence', async () => {
    const originalFetch = window.fetch;
    let uploaded = false;
    (window as any).api = { getRuntimeInfo: async () => ({ goPort: 1 }) };
    window.fetch = async () => {
      uploaded = true;
      return new Response(JSON.stringify({ path: 'attachments/test.png' }), { status: 200 });
    };
    try {
      const { view, dom, markdown } = await mount();
      paste(view, '# 不应插入', { image: true });
      await wait(300);
      check(uploaded && dom.querySelector('img') && !dom.querySelector('h1'), dom.innerHTML);
      check(markdown().includes('../attachments/test.png'), markdown());
    } finally { window.fetch = originalFetch; }
  });
  root.unmount();
  return results;
}

(window as any).runPasteTests = runPasteTests;

#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '../apps/desktop');
const local = createRequire(path.join(desktop, 'package.json'));
const esbuild = createRequire(local.resolve('vite'))('esbuild');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function load(file) {
  const result = esbuild.buildSync({ entryPoints: [path.join(desktop, 'src/renderer/src/components/preview', file)], bundle: true, platform: 'node', format: 'cjs', write: false });
  const mod = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module: mod, exports: mod.exports, require: local, console, setTimeout, clearTimeout, AbortController, URL });
  return mod.exports;
}
async function units() {
  const { parsePreview, attachmentSource } = load('parse.ts');
  const { PreviewStore } = load('store.ts');
  const walk = node => [node, ...(node.children || []).flatMap(walk)];
  const parsed = parsePreview('# Heading\n\n| A | B |\n|---|---|\n| one | two |\n\n- [x] Done\n\n<script>alert(1)</script>\n\n[link](javascript:alert(1))', true);
  const nodes = walk(parsed.tree);
  assert(nodes.some(n => n.type === 'table')); assert(nodes.some(n => n.type === 'listItem' && n.checked === true));
  assert(!nodes.some(n => n.type === 'html')); assert(!nodes.some(n => n.url?.startsWith('javascript:')));
  for (const expanded of [false, true]) {
    const result = parsePreview('- [x] item\n'.repeat(1000), expanded);
    assert(walk(result.tree).length <= (expanded ? 600 : 120)); assert(result.truncated);
  }
  assert.equal(attachmentSource('../attachments/a.png'), 'pinslip-img://attachments/a.png');
  for (const src of ['https://example.com/a.png', 'data:image/png;base64,abc', '../attachments/../a.png', '../attachments/%2e%2e%2Fa.png', 'pinslip-img://attachments/a.png']) assert.equal(attachmentSource(src), null);
  assert(parsePreview('complete\n\n| incomplete', false, true).truncated);
  console.log('PASS GFM tables/tasks, HTML exclusion, attachment boundaries and node budgets');

  const data = id => ({ id, markdown: id, revision: id, truncated: false });
  const parse = async item => ({ tree: { type: 'root', children: [{ type: 'text', value: item.markdown }] }, truncated: false });
  let calls = 0, active = 0, peak = 0;
  const store = new PreviewStore(async ids => { calls++; peak = Math.max(peak, ++active); assert(ids.length <= 8); await sleep(10); active--; return ids.map(data); }, parse, 3, 4096);
  const off = Array.from({ length: 20 }, (_, i) => store.subscribe('c:' + i, () => {}));
  await sleep(180);
  assert(peak <= 2); assert(calls <= 4); assert(store.stats().entries <= 3); assert(store.stats().bytes <= 4096); assert.equal(store.stats().active, 0);
  off.forEach(fn => fn()); store.dispose();
  console.log('PASS batch size/concurrency, bounded LRU and no eviction retry loop');

  let resolveOld, changedCalls = 0;
  const race = new PreviewStore(async ids => {
    changedCalls++;
    if (changedCalls === 1) return new Promise(resolve => { resolveOld = () => resolve(ids.map(id => ({ ...data(id), markdown: 'OLD' }))); });
    return ids.map(id => ({ ...data(id), markdown: 'NEW' }));
  }, parse);
  const disposeA = race.subscribe('c:a', () => {}), disposeDuplicate = race.subscribe('c:a', () => {});
  await sleep(40); assert.equal(changedCalls, 1); race.invalidate(); resolveOld(); await sleep(80);
  assert.equal(race.get('c:a').data.markdown, 'NEW'); assert.equal(changedCalls, 2);
  disposeA(); disposeDuplicate(); race.dispose();
  let aborted = false;
  const cancel = new PreviewStore((_ids, _expanded, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })), parse);
  const dispose = cancel.subscribe('c:a', () => {}); await sleep(40); dispose(); await sleep(20); assert(aborted); cancel.dispose();
  console.log('PASS duplicate subscribers, external invalidation, stale responses and offscreen abort');
}

async function native() {
  const { app, BrowserWindow } = require('electron');
  const root = process.env.PINSLIP_PREVIEW_TEST_DIR;
  assert(root && path.basename(root).startsWith('preview-test-'));
  app.setPath('userData', path.join(root, 'profile')); app.setAppPath(desktop);
  let manager;
  app.on('browser-window-created', (_e, win) => { if (!manager) {
    manager = win;
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('RENDERER', message); });
  } });
  require(path.join(desktop, 'out/main/index.js'));
  const check = async (expression, name, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (manager && !manager.isDestroyed()) try { if (await manager.webContents.executeJavaScript(expression)) { console.log('PASS ' + name); return; } } catch {}
      await sleep(100);
    }
    console.error(await manager.webContents.executeJavaScript(`JSON.stringify({url:location.href,text:document.body.textContent.slice(0,500),rows:document.querySelectorAll('[data-index]').length,list:document.querySelector('.virtual-note-list')?.getBoundingClientRect().toJSON(),parent:document.querySelector('.main-view')?.getBoundingClientRect().toJSON()})`));
    throw new Error('Timed out: ' + name);
  };
  const js = code => manager.webContents.executeJavaScript(code);
  const stableExpand = async (middle = false) => {
    const expansionFrames = await js(`new Promise(resolve => {
      const parent = document.querySelector('.main-view');
      const card = ${middle ? `[...document.querySelectorAll('li.note-list__note')].find(e => e.getBoundingClientRect().top > parent.getBoundingClientRect().top + 40)` : `document.querySelector('li.note-list__note')`};
      const fetchBefore = window.fetch;
      window.fetch = async (...args) => {
        if (String(args[0]).endsWith('/api/notes/previews') && JSON.parse(args[1]?.body || '{}').expanded) await new Promise(r => setTimeout(r, 250));
        return fetchBefore(...args);
      };
      const frames = [], start = performance.now();
      const sample = () => {
        frames.push({ table:!!card.querySelector('table'), height:card.getBoundingClientRect().height, top:card.getBoundingClientRect().top, scroll:parent.scrollTop });
        if (performance.now() - start < 600) requestAnimationFrame(sample);
        else { window.fetch = fetchBefore; resolve(frames); }
      };
      card.click(); requestAnimationFrame(sample);
    })`);
    console.log('Expansion states: ' + JSON.stringify(expansionFrames.filter((frame, i, all) => i === 0 || frame.table !== all[i-1].table || frame.height !== all[i-1].height || frame.scroll !== all[i-1].scroll)));
    assert(expansionFrames.every(frame => frame.table), 'expanding a ready Markdown preview must not flash the plain-text fallback');
    assert(Math.max(...expansionFrames.map(frame => frame.scroll)) - Math.min(...expansionFrames.map(frame => frame.scroll)) <= 1, 'expansion must preserve the list scroll offset');
    assert(Math.max(...expansionFrames.map(frame => frame.top)) - Math.min(...expansionFrames.map(frame => frame.top)) <= 1, 'expansion must keep the selected card anchored');
  };
  try {
    await check(`document.querySelector('.markdown-preview table') && document.querySelectorAll('li.note-list__note').length < 30`, '1000-note list mounts only visible cards and renders tables');
    console.log('Mounted cards at first paint: ' + await js(`document.querySelectorAll('li.note-list__note').length`));
    assert.equal(await js(`document.querySelectorAll('.markdown-preview img').length`), 0);
    assert(await js(`document.body.textContent.includes('characters')`));
    await stableExpand();
    await check(`document.querySelector('.markdown-preview.is-expanded table')`, 'single-click expanded Markdown preview');
    await check(`document.querySelector('.markdown-preview.is-expanded img')?.naturalWidth > 0`, 'expanded local image loads through attachment protocol');
    assert(await js(`document.querySelectorAll('.markdown-preview.is-expanded img').length <= 3 && [...document.querySelectorAll('.markdown-preview input')].every(e => e.disabled) && !document.querySelector('.markdown-preview a[href]')`));
    fs.writeFileSync(path.join(root, 'expanded-preview.png'), (await manager.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.main-view').scrollTop = 1400`);
    await check(`document.querySelector('.main-view').scrollTop > 1000 && [...document.querySelectorAll('li.note-list__note')].filter(e => e.getBoundingClientRect().top > 40 && e.getBoundingClientRect().top < 400).every(e => e.querySelector('table'))`, 'middle rows finish loading before expansion');
    await stableExpand(true);
    console.log('PASS delayed expansion preserves Markdown, selected card position and scroll offset');
    await js(`document.querySelector('.main-view').scrollTop = 1000000`);
    await check(`document.querySelector('.main-view').scrollTop > 10000 && document.querySelectorAll('li.note-list__note').length < 30`, 'scroll to bottom retains bounded DOM');
    await js(`document.querySelector('.main-view').scrollTop = 0`);
    await check(`document.querySelector('.main-view').scrollTop === 0 && document.querySelector('.markdown-preview table')`, 'return to first page reloads evicted previews');
    await js(`[...document.querySelectorAll('.main-view__tab')].find(e=>e.textContent.includes('Tags')).click()`);
    await check(`document.querySelector('.virtual-note-list__group') && document.querySelector('.markdown-preview table') && document.querySelectorAll('li.note-list__note').length < 30`, 'tag groups virtualize duplicate notes');
    await js(`document.querySelector('.main-view__grouphead').click()`);
    await check(`document.querySelectorAll('.virtual-note-list__group').length === 2`, 'collapsed tag group exposes next group');
    await js(`document.querySelector('.main-view__grouphead').click()`);
    await check(`document.querySelector('.markdown-preview table')`, 'tag group expands again');
    await js(`[...document.querySelectorAll('.main-view__tab')].find(e=>e.textContent.includes('Folders')).click()`);
    await check(`document.querySelector('.note-list__dir')`, 'folder navigation remains mounted');
    await js(`document.querySelector('.note-list__dir').click()`);
    await check(`document.querySelector('.markdown-preview table') && document.querySelectorAll('li.note-list__note').length < 30`, 'nested folder previews virtualize');
    const file = path.join(root, 'vault/notes/Folder/n0000.md');
    fs.appendFileSync(file, '\nExternal update marker\n');
    // 修改首行，验证 frontmatter 时间不变时仍失效，且可见预览重新请求。
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Cell 0', 'UPDATED EXTERNALLY'));
    await check(`document.querySelector('.markdown-preview')?.textContent.includes('UPDATED EXTERNALLY')`, 'external edit invalidates preview without frontmatter timestamp change');
    await js(`(() => { const source = [...document.querySelectorAll('li.note-list__note')].find(e => e.querySelector('.note-list__title-text')?.title === 'Note 1'); window.__previewDrag = new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer:window.__previewDrag })); })()`);
    await js(`(() => { const target = document.querySelector('.note-list__dir'); target.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer:window.__previewDrag })); target.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:window.__previewDrag })); document.querySelector('[draggable=true]')?.dispatchEvent(new DragEvent('dragend', { bubbles:true })); })()`);
    const movedDeadline = Date.now() + 5000;
    while (!fs.readdirSync(path.join(root, 'vault/notes/Folder/Target')).some(name => name.includes('n0001')) && Date.now() < movedDeadline) await sleep(100);
    assert(fs.readdirSync(path.join(root, 'vault/notes/Folder/Target')).some(name => name.includes('n0001')));
    console.log('PASS drag virtualized note into child folder');
    console.log('PASS native preview integration');
    fs.writeFileSync(path.join(root, 'native-passed'), 'ok');
    app.quit();
  } catch (error) { console.error(error); process.exitCode = 1; app.quit(); }
}

async function launch() {
  await units(); if (process.argv.includes('--unit')) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  fs.mkdirSync(path.join(root, 'profile')); fs.mkdirSync(path.join(root, 'vault/notes/Folder'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vault/notes/Folder/Target'));
  fs.mkdirSync(path.join(root, 'vault/attachments'));
  fs.writeFileSync(path.join(root, 'vault/attachments/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(root, 'vault/notes/Folder', `n${String(i).padStart(4, '0')}.md`),
    `---\nid: n${String(i).padStart(4, '0')}\ntitle: Note ${i}\ntags: [one, two]\ncreated_at: 2026-11-06T08:00:00Z\nupdated_at: 2026-11-06T08:00:00Z\n---\n\n| A | B |\n|---|---|\n| Cell ${i} | Value |\n\n- [x] Complete\n- [ ] Pending\n\n![local](../../attachments/pixel.png)\n\n![remote](https://example.invalid/pixel.png)\n`);
  fs.writeFileSync(path.join(root, 'profile/settings.json'), JSON.stringify({ vaultPath: path.join(root, 'vault'), language: 'en', advanced: { trayIcon: false, quickCaptureShortcut: 'off', blankNoteShortcut: 'off' } }));
  const portFile = path.join(os.tmpdir(), 'pinslip-port.json');
  const oldPort = fs.existsSync(portFile) ? fs.readFileSync(portFile) : null;
  try {
    const env = { ...process.env, PINSLIP_PREVIEW_TEST_DIR: root }; delete env.ELECTRON_RUN_AS_NODE;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(local('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else child.kill();
        reject(new Error('Native preview timeout'));
      }, 100000);
      child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('exit', code => { clearTimeout(timer); resolve(code ?? 1); });
    });
    if (code !== 0 || !fs.existsSync(path.join(root, 'native-passed'))) throw new Error('Native preview test failed: ' + code);
  } finally {
    // Windows 的异步退出钩子偶尔赶不及 taskkill；只清理本次临时 vault 记录的服务。
    const discovery = path.join(root, 'vault/.pinslip/mcp.json');
    if (fs.existsSync(discovery)) {
      const { pid } = JSON.parse(fs.readFileSync(discovery, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    if (oldPort) fs.writeFileSync(portFile, oldPort);
    else if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
    console.log('Isolated test artifacts: ' + root);
  }
}
(process.versions.electron ? native() : launch()).catch(error => { console.error(error); process.exitCode = 1; });

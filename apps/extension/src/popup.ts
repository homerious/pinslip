// Popup：速记进收集箱（quick 端点）+ 连接状态指示（绿点/灰点）。
import { health, quick } from './api';
import { msg } from './i18n';

const dot = document.getElementById('dot')!;
const status = document.getElementById('status')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const saved = document.getElementById('saved')!;

input.placeholder = msg('popupPlaceholder');
saveBtn.textContent = msg('popupSave');
saved.textContent = msg('saved');

async function refreshStatus(): Promise<boolean> {
  try {
    const h = await health();
    dot.classList.add('on');
    status.textContent = msg('connected', { version: h.version });
    return true;
  } catch {
    dot.classList.remove('on');
    status.textContent = msg('disconnected');
    return false;
  }
}

let connected = false;
void refreshStatus().then((ok) => {
  connected = ok;
  input.focus();
});

async function save(): Promise<void> {
  const content = input.value.trim();
  if (!content) return;
  saveBtn.disabled = true;
  try {
    await quick(content);
    input.value = '';
    saved.style.visibility = 'visible';
    setTimeout(() => (saved.style.visibility = 'hidden'), 1500);
    if (!connected) void refreshStatus().then((ok) => (connected = ok));
  } catch {
    status.textContent = msg('cannotConnect');
    dot.classList.remove('on');
    connected = false;
  } finally {
    saveBtn.disabled = false;
    input.focus();
  }
}

saveBtn.addEventListener('click', () => void save());
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    void save();
  }
});

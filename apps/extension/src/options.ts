// 选项页：连接状态（自动探测 /api/health）+ 端口设置（chrome.storage.sync）+ 重新检测。
import { DEFAULT_PORT, getPort, health, setPort } from './api';
import { msg } from './i18n';

document.getElementById('title')!.textContent = msg('optionsTitle');
document.getElementById('portLabel')!.textContent = msg('portLabel');
document.getElementById('portHint')!.textContent = msg('portHint');
document.getElementById('retest')!.textContent = msg('retest');

const dot = document.getElementById('dot')!;
const status = document.getElementById('status')!;
const guide = document.getElementById('guide')!;
const portInput = document.getElementById('port') as HTMLInputElement;
const retestBtn = document.getElementById('retest') as HTMLButtonElement;

async function probe(): Promise<void> {
  dot.className = 'dot';
  status.textContent = '…';
  guide.classList.remove('show');
  try {
    const h = await health();
    dot.classList.add('on');
    status.textContent = msg('connected', { version: h.version });
  } catch {
    dot.classList.add('bad');
    status.textContent = msg('disconnected');
    guide.textContent = `${msg('cannotConnect')}${msg('connectGuide')}`;
    guide.classList.add('show');
  }
}

// 端口改动即时落盘并重新探测（失焦/回车都算一次修改）
async function applyPort(): Promise<void> {
  const n = Number(portInput.value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    portInput.value = String(await getPort());
    return;
  }
  await setPort(n);
  await probe();
}

portInput.addEventListener('change', () => void applyPort());
retestBtn.addEventListener('click', () => void probe());

void (async () => {
  portInput.value = String(await getPort());
  portInput.placeholder = String(DEFAULT_PORT);
  await probe();
})();

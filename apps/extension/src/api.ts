// PinSlip 本地服务 HTTP 客户端：全部请求 5s 超时。
// 端口存 chrome.storage.sync（选项页可改），默认 17639（pinslipd 知名端口）。

export const DEFAULT_PORT = 17639;
const TIMEOUT_MS = 5000;

export async function getPort(): Promise<number> {
  const { port } = await chrome.storage.sync.get({ port: DEFAULT_PORT });
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export async function setPort(port: number): Promise<void> {
  await chrome.storage.sync.set({ port });
}

async function baseUrl(): Promise<string> {
  return `http://127.0.0.1:${await getPort()}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${await baseUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface Health {
  app: string;
  version: string;
}

/** 身份握手：确认对面是 PinSlip（知名端口可能被别的软件占用）。 */
export async function health(): Promise<Health> {
  const h = await req<Health>('/api/health');
  if (h.app !== 'pinslip') {
    throw new Error('not pinslip');
  }
  return h;
}

/** 速记进收集箱（POST /api/notes/quick）。 */
export function quick(content: string): Promise<unknown> {
  return req('/api/notes/quick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

/** 16 位十六进制便签 id（与 Go 侧 NewID 同形态）。 */
function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 新建便签到收集箱（PUT /api/notes/{id}，inbox 仅新建生效）。 */
export function createInboxNote(title: string, content: string): Promise<unknown> {
  return req(`/api/notes/${newId()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, title, source: 'web-clip', inbox: true }),
  });
}

/** 上传图片附件（raw body），返回 vault 相对路径 attachments/<name>。 */
export function uploadImage(blob: Blob, ext: string): Promise<{ path: string }> {
  return req<{ path: string }>(`/api/attachments?ext=${encodeURIComponent(ext)}`, {
    method: 'POST',
    body: blob,
  });
}

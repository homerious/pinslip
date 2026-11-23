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

export class PairingRequiredError extends Error {
  constructor() {
    super('PinSlip pairing required');
  }
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new PairingRequiredError();
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  return (await res.json()) as T;
}

// IndexedDB 属于扩展页面和后台的来源。凭证不进入同步存储或 content script 消息。
function credential(update?: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('pinslip-local', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('credentials');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('credentials', update === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('credentials');
      const req = update === undefined ? store.get('clipper') : store.put(update, 'clipper');
      tx.oncomplete = () => {
        db.close();
        resolve(update === undefined ? req.result as string | undefined : undefined);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export interface Health {
  app: string;
  version: string;
}

/** 先检查应用标识，再发配对码或业务凭证。 */
async function discover(): Promise<{ base: string; app: Health }> {
  const base = `http://127.0.0.1:${await getPort()}`;
  const h = await request<Health>(base, '/api/health');
  if (h.app !== 'pinslip') {
    throw new Error('not pinslip');
  }
  return { base, app: h };
}

async function authenticated<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const token = await credential();
  if (!token) throw new PairingRequiredError();
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return request(base, path, { ...init, headers });
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const { base } = await discover();
  return authenticated(base, path, init);
}

export async function health(): Promise<Health> {
  const { base, app } = await discover();
  await authenticated(base, '/api/clipper/status');
  return app;
}

export async function pair(code: string): Promise<void> {
  const { base } = await discover();
  const result = await request<{ token: string }>(base, '/api/clipper/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (typeof result.token !== 'string' || !result.token) throw new Error('Invalid PinSlip credential');
  await credential(result.token);
}

/** 速记进收集箱。 */
export function quick(content: string): Promise<unknown> {
  return req('/api/clipper/quick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

/** 新建便签到收集箱，由服务生成 ID。 */
export function createInboxNote(title: string, content: string): Promise<unknown> {
  return req('/api/clipper/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, title }),
  });
}

/** 上传图片附件（raw body），返回 vault 相对路径 attachments/<name>。 */
export function uploadImage(blob: Blob, ext: string): Promise<{ path: string }> {
  return req<{ path: string }>(`/api/clipper/attachments?ext=${encodeURIComponent(ext)}`, {
    method: 'POST',
    body: blob,
  });
}

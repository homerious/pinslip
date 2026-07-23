import type { RuntimeInfo } from '@shared/types';

// 渲染进程数据层：直接 HTTP 访问 Go 本地服务（与窗口 IPC 通道分离）。
// 端口经主进程 IPC 获取一次后缓存；这套 fetch 封装未来 Web 端可直接复用。

let runtimePromise: Promise<RuntimeInfo> | null = null;

function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (!runtimePromise) {
    runtimePromise = window.api.getRuntimeInfo();
  }
  return runtimePromise;
}

async function getBaseUrl(): Promise<string> {
  const info = await getRuntimeInfo();
  return `http://127.0.0.1:${info.goPort}`;
}

/** 统一 fetch 封装：JSON 编解码 + 错误归一化。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await getBaseUrl();
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/** 上传原始字节（附件场景）：不带 JSON Content-Type，body 即文件内容。 */
export async function postRaw<T>(path: string, body: Blob): Promise<T> {
  const base = await getBaseUrl();
  const res = await fetch(`${base}${path}`, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/** 把 request() 抛出的错误提炼成可读文案：Go 侧 4xx/5xx 响应体是
 *  {"error": "原因"} JSON，提取 error 字段；提取不了就回退原文。 */
export function apiErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^API \d+: ([\s\S]*)$/);
  if (m) {
    try {
      const j = JSON.parse(m[1]) as { error?: unknown };
      if (typeof j.error === 'string' && j.error) return j.error;
    } catch {
      /* 非 JSON 响应体：用原文 */
    }
  }
  return msg;
}

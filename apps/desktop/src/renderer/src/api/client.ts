import type { RuntimeInfo } from '@shared/types';

// 渲染进程数据层：直接 HTTP 访问 Go 本地服务（与窗口 IPC 通道分离）。
// 端口和令牌经主进程 IPC 获取后缓存，只有 Go 拒绝旧凭证时才重试当前请求。

let runtimePromise: Promise<RuntimeInfo> | null = null;
let watchingRuntime = false;

function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (!watchingRuntime) {
    window.api.onRuntimePortChanged?.(() => { runtimePromise = null; });
    watchingRuntime = true;
  }
  if (!runtimePromise) {
    runtimePromise = window.api.getRuntimeInfo();
  }
  return runtimePromise;
}

async function localFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const connection = getRuntimeInfo();
  const send = async (info: RuntimeInfo) => {
    const headers = new Headers(init.headers);
    if (info.goToken) headers.set('Authorization', `Bearer ${info.goToken}`);
    return fetch(`http://127.0.0.1:${info.goPort}${path}`, { ...init, headers, redirect: 'error' });
  };
  try {
    const initial = await connection;
    const res = await send(initial);
    if (res.status !== 401 || res.headers.get('WWW-Authenticate') !== 'Bearer') return res;
    if (runtimePromise === connection) runtimePromise = null;
    const refreshed = await getRuntimeInfo();
    if (refreshed.vaultPath !== initial.vaultPath) return res;
    if (refreshed.goToken === initial.goToken && refreshed.goPort === initial.goPort) return res;
    // 401 由本地授权中间件返回时业务尚未执行，可以安全重试。
    return await send(refreshed);
  } catch (error) {
    if (runtimePromise === connection && !init.signal?.aborted) runtimePromise = null;
    throw error;
  }
}

/** 统一 fetch 封装：JSON 编解码 + 错误归一化。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await localFetch(path, {
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
  const res = await localFetch(path, { method: 'POST', body });
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

/** 同 apiErrorMessage 的解析路径，提取 Go 侧响应体的稳定 code 字段
 *  （renderer 按 code 映射 i18n 文案）；无 code 返回 null。 */
export function apiErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^API \d+: ([\s\S]*)$/);
  if (m) {
    try {
      const j = JSON.parse(m[1]) as { code?: unknown };
      if (typeof j.code === 'string' && j.code) return j.code;
    } catch {
      /* 非 JSON 响应体：无 code */
    }
  }
  return null;
}

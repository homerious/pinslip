import { parsePreview } from './parse';

self.onmessage = (event: MessageEvent<{ token: number; markdown: string; expanded: boolean; truncated: boolean }>) => {
  const { token, markdown, expanded, truncated } = event.data;
  try { self.postMessage({ token, result: parsePreview(markdown, expanded, truncated) }); }
  catch { self.postMessage({ token, error: true }); }
};

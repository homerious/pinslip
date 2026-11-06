import { request } from '../../api/client';
import type { ParsedPreview } from './parse';
import { PreviewStore, type PreviewData } from './store';

let worker: Worker | undefined;
let token = 0;
const pending = new Map<number, { resolve: (value: ParsedPreview) => void; reject: () => void }>();
function parse(data: PreviewData, expanded: boolean): Promise<ParsedPreview> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const task = pending.get(event.data.token);
        pending.delete(event.data.token);
        if (event.data.error) task?.reject(); else task?.resolve(event.data.result);
      };
      worker.onerror = () => {
        for (const task of pending.values()) task.reject();
        pending.clear(); worker?.terminate(); worker = undefined;
      };
    }
    const id = ++token;
    pending.set(id, { resolve, reject: () => reject(new Error('preview parse failed')) });
    worker.postMessage({ token: id, markdown: data.markdown, expanded, truncated: data.truncated });
  });
}

export const previewStore = new PreviewStore((ids, expanded, signal) =>
  request<PreviewData[]>('/api/notes/previews', { method: 'POST', body: JSON.stringify({ ids, expanded }), signal }), parse);

window.addEventListener('pagehide', () => {
  previewStore.dispose(); worker?.terminate(); worker = undefined;
  for (const task of pending.values()) task.reject();
  pending.clear();
});

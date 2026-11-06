import type { ParsedPreview } from './parse';

export interface PreviewData { id: string; markdown: string; revision: string; direction?: 'ltr' | 'rtl'; truncated: boolean; error?: string }
export interface PreviewEntry { data: PreviewData; parsed: ParsedPreview; bytes: number }
type FetchBatch = (ids: string[], expanded: boolean, signal: AbortSignal) => Promise<PreviewData[]>;
type Parse = (data: PreviewData, expanded: boolean) => Promise<ParsedPreview>;
interface Request { controller: AbortController; keys: string[] }
export const previewKey = (id: string, expanded: boolean): string => `${expanded ? 'e' : 'c'}:${id}`;

export class PreviewStore {
  private cache = new Map<string, PreviewEntry>();
  private listeners = new Map<string, Set<() => void>>();
  private queued = new Set<string>();
  private pending = new Set<string>();
  private requests = new Set<Request>();
  private failures = new Set<string>();
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private bytes = 0;
  constructor(private fetchBatch: FetchBatch, private parse: Parse, private maxEntries = 50, private maxBytes = 8 * 1024 * 1024) {}

  get = (key: string): PreviewEntry | undefined => this.cache.get(key);
  subscribe(key: string, listener: () => void): () => void {
    let group = this.listeners.get(key);
    if (!group) this.listeners.set(key, group = new Set());
    group.add(listener);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); }
    this.want(key);
    return () => {
      group!.delete(listener);
      if (group!.size) return;
      this.listeners.delete(key); this.queued.delete(key); this.failures.delete(key);
      for (const request of this.requests) {
        if (request.keys.every(k => !this.listeners.has(k))) request.controller.abort();
      }
    };
  }
  private notify(key: string): void { for (const listener of this.listeners.get(key) ?? []) listener(); }
  private want(key: string): void {
    if (!this.cache.has(key) && !this.pending.has(key) && !this.failures.has(key) && this.listeners.has(key)) this.queued.add(key);
    if (!this.timer && this.queued.size) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 20);
  }
  invalidate(): void {
    this.epoch++; this.cache.clear(); this.bytes = 0; this.failures.clear();
    for (const request of this.requests) request.controller.abort();
    this.queued.clear();
    for (const key of this.listeners.keys()) { this.notify(key); this.want(key); }
  }
  private pump(): void {
    while (this.requests.size < 2 && this.queued.size) {
      const first = this.queued.values().next().value as string;
      const expanded = first.startsWith('e:');
      const keys = [...this.queued].filter(k => k.startsWith(expanded ? 'e:' : 'c:')).slice(0, 8);
      for (const key of keys) { this.queued.delete(key); this.pending.add(key); }
      const request: Request = { controller: new AbortController(), keys };
      this.requests.add(request);
      const epoch = this.epoch;
      void this.load(request, expanded, epoch);
    }
  }
  private async load(request: Request, expanded: boolean, epoch: number): Promise<void> {
    try {
      const items = await this.fetchBatch(request.keys.map(k => k.slice(2)), expanded, request.controller.signal);
      for (const key of request.keys) {
        if (epoch !== this.epoch || request.controller.signal.aborted) break;
        if (!this.listeners.has(key)) continue;
        const data = items.find(item => item.id === key.slice(2));
        if (!data || data.error) { this.failures.add(key); continue; }
        const parsed = await this.parse(data, expanded);
        if (epoch !== this.epoch || request.controller.signal.aborted) break;
        if (!this.listeners.has(key)) continue;
        const bytes = 2 * (JSON.stringify(parsed).length + JSON.stringify(data).length);
        if (bytes <= this.maxBytes) {
          const old = this.cache.get(key);
          if (old) this.bytes -= old.bytes;
          this.cache.delete(key); this.cache.set(key, { data, parsed, bytes }); this.bytes += bytes;
          while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
            const oldest = this.cache.keys().next().value as string;
            this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
          }
          this.notify(key);
        } else this.failures.add(key);
      }
    } catch {
      if (epoch === this.epoch && !request.controller.signal.aborted) {
        for (const key of request.keys) if (this.listeners.has(key)) this.failures.add(key);
      }
    } finally {
      this.requests.delete(request);
      const retry = epoch !== this.epoch || request.controller.signal.aborted;
      for (const key of request.keys) { this.pending.delete(key); if (retry) this.want(key); }
      this.pump();
    }
  }
  stats(): { entries: number; bytes: number; queued: number; active: number } {
    return { entries: this.cache.size, bytes: this.bytes, queued: this.queued.size, active: this.requests.size };
  }
  dispose(): void {
    this.epoch++; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.queued.clear(); this.listeners.clear(); this.cache.clear(); this.bytes = 0;
    for (const request of this.requests) request.controller.abort();
  }
}

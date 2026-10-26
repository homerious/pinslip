import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';

interface PendingFlush {
  id: number;
  sent: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Entry {
  win: BrowserWindow;
  ready: boolean;
  prepared: boolean;
  pending?: PendingFlush;
}

/** 一次关闭握手只接受所属窗口和当前请求的回复，不传输正文。 */
export class NoteCloseGuard {
  private entries = new Map<number, Entry>();
  private sequence = 0;

  add(win: BrowserWindow): void {
    this.entries.set(win.webContents.id, { win, ready: false, prepared: false });
  }

  isPrepared(win: BrowserWindow): boolean {
    if (win.isDestroyed()) return true;
    return this.entries.get(win.webContents.id)?.prepared ?? false;
  }

  ready(senderId: number, ready: boolean): void {
    const entry = this.entries.get(senderId);
    if (!entry) return;
    entry.ready = ready;
    if (ready) this.send(entry);
  }

  private send(entry: Entry): void {
    const pending = entry.pending;
    if (!entry.ready || !pending || pending.sent || entry.win.isDestroyed()) return;
    pending.sent = true;
    try { entry.win.webContents.send(IPC.NoteFlush, pending.id); }
    catch { this.finish(entry.win.webContents.id, pending.id, false); }
  }

  flush(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return Promise.resolve();
    const entry = this.entries.get(win.webContents.id);
    if (!entry || win.isDestroyed() || entry.prepared) return Promise.resolve();
    if (entry.pending) return entry.pending.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const id = ++this.sequence;
    const timer = setTimeout(() => this.finish(win.webContents.id, id, false), 8000);
    entry.pending = { id, sent: false, promise, resolve, reject, timer };
    this.send(entry);
    return promise;
  }

  finish(senderId: number, id: number, ok: boolean): void {
    const entry = this.entries.get(senderId);
    const pending = entry?.pending;
    if (!entry || !pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    entry.pending = undefined;
    entry.prepared = ok;
    if (ok) pending.resolve();
    else {
      this.resume(entry);
      pending.reject(new Error('Note save failed or timed out'));
    }
  }

  resumeAll(): void {
    for (const entry of this.entries.values()) {
      entry.prepared = false;
      this.resume(entry);
    }
  }

  private resume(entry: Entry): void {
    try {
      if (!entry.win.isDestroyed()) entry.win.webContents.send(IPC.NoteResumeEditing);
    } catch { /* 渲染进程已失效：仍必须拒绝关闭请求，不能卡住退出流程。 */ }
  }

  remove(senderId: number): void {
    const entry = this.entries.get(senderId);
    if (entry?.pending) {
      clearTimeout(entry.pending.timer);
      entry.pending.resolve(); // 显式删除后的 destroy 不阻塞其他窗口退出。
    }
    this.entries.delete(senderId);
  }
}

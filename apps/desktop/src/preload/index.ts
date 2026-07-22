import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { ElectronAPI, GroupState } from '../shared/types';

// preload 是主进程与渲染进程之间的唯一桥梁：
// 这里实现的 ElectronAPI 就是渲染进程能触达主进程的全部能力白名单。
const api: ElectronAPI = {
  getRuntimeInfo: () => ipcRenderer.invoke(IPC.RuntimeInfo),
  createNote: (noteId, folder) => ipcRenderer.invoke(IPC.WindowCreate, noteId, folder),
  closeNote: (noteId) => ipcRenderer.invoke(IPC.WindowClose, noteId),
  setNotePin: (noteId, pinned) => ipcRenderer.invoke(IPC.WindowSetPin, noteId, pinned),
  setNoteCollapsed: (noteId, collapsed) =>
    ipcRenderer.invoke(IPC.NoteSetCollapsed, noteId, collapsed),
  listWindows: () => ipcRenderer.invoke(IPC.WindowList),
  showMainWindow: () => ipcRenderer.invoke(IPC.MainWindowShow),
  noteResizeBegin: (noteId) => ipcRenderer.invoke(IPC.NoteResizeBegin, noteId),
  noteResize: (noteId, dx, dy) => ipcRenderer.invoke(IPC.NoteResize, noteId, dx, dy),
  noteResizeEnd: (noteId) => ipcRenderer.invoke(IPC.NoteResizeEnd, noteId),
  chooseVault: () => ipcRenderer.invoke(IPC.SettingsChooseVault),
  openVaultFolder: () => ipcRenderer.invoke(IPC.SettingsOpenVault),
  openTrashFolder: () => ipcRenderer.invoke(IPC.SettingsOpenTrash),
  openNoteFolder: (folder) => ipcRenderer.invoke(IPC.NoteOpenFolder, folder),
  getAutoStart: () => ipcRenderer.invoke(IPC.SettingsGetAutoStart),
  setAutoStart: (enabled) => ipcRenderer.invoke(IPC.SettingsSetAutoStart, enabled),
  notifyNotesChanged: () => ipcRenderer.send(IPC.NotesChanged),
  onNotesChanged: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC.NotesChanged, listener);
    return () => ipcRenderer.removeListener(IPC.NotesChanged, listener);
  },
  getGroupState: (noteId) => ipcRenderer.invoke(IPC.GroupGetState, noteId),
  onGroupHover: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, active: boolean): void => cb(active);
    ipcRenderer.on(IPC.GroupHover, listener);
    return () => ipcRenderer.removeListener(IPC.GroupHover, listener);
  },
  onGroupState: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, state: GroupState | null): void => cb(state);
    ipcRenderer.on(IPC.GroupState, listener);
    return () => ipcRenderer.removeListener(IPC.GroupState, listener);
  },
  groupDragBegin: (noteId) => ipcRenderer.invoke(IPC.GroupDragBegin, noteId),
  groupDragEnd: (noteId) => ipcRenderer.invoke(IPC.GroupDragEnd, noteId),
  groupRename: (noteId, name) => ipcRenderer.invoke(IPC.GroupRename, noteId, name),
  groupDissolve: (noteId) => ipcRenderer.invoke(IPC.GroupDissolve, noteId),
};

contextBridge.exposeInMainWorld('api', api);

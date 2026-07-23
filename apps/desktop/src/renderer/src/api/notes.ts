import type { Note, NoteMeta, SaveNoteInput, SearchHit } from '@shared/types';
import { request } from './client';

/** 笔记数据 API（对应 docs/api.md 契约） */
export const notesApi = {
  list: () => request<NoteMeta[]>('/api/notes'),

  get: (id: string) => request<Note>(`/api/notes/${id}`),

  /** upsert：id 由主进程生成，存在即更新，不存在即创建 */
  save: (id: string, input: SaveNoteInput) =>
    request<Note>(`/api/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  remove: (id: string) =>
    request<{ status: string }>(`/api/notes/${id}`, { method: 'DELETE' }),

  search: (q: string) =>
    request<SearchHit[]>(`/api/notes/search?q=${encodeURIComponent(q)}`),

  /** 速记：写入 inbox */
  quick: (content: string) =>
    request<Note>('/api/notes/quick', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  /** 移动笔记到 notes/ 下的文件夹（"" 为根目录） */
  move: (id: string, folder: string) =>
    request<{ status: string }>(`/api/notes/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ folder }),
    }),
};

/** 文件夹 API：notes/ 下的嵌套目录管理 */
export const foldersApi = {
  list: () => request<{ folders: string[] }>('/api/folders').then((r) => r.folders),

  create: (path: string) =>
    request<{ status: string }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** 重命名（同级改名，name 为单段名称） */
  rename: (path: string, name: string) =>
    request<{ status: string }>('/api/folders/rename', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),

  /** 删除：move = 便签移到根目录后删空文件夹；trash = 连同便签移入 .trash */
  remove: (path: string, mode: 'move' | 'trash') =>
    request<{ status: string }>('/api/folders/delete', {
      method: 'POST',
      body: JSON.stringify({ path, mode }),
    }),
};

/** 回收区统计（GET /api/trash/stats） */
export interface TrashStats {
  count: number; // 顶层条目数（每条 = 一次删除的文件夹）
  bytes: number; // 全部文件大小合计
}

/** 回收区 API：找回入口走 window.api.openTrashFolder（拖回 notes/ 即恢复索引） */
export const trashApi = {
  stats: () => request<TrashStats>('/api/trash/stats'),

  empty: () => request<{ status: string }>('/api/trash/empty', { method: 'POST' }),
};

/** vault 设置（对应 .pinslip/settings.json） */
export interface VaultSettings {
  trashRetentionDays: number; // 回收区保留天数；<= 0 = 不自动清理
  /** MCP 服务开关；缺省（字段缺失）= 开启。PUT 未带此键时 Go 侧保留现值 */
  mcpEnabled?: boolean;
  /** 速记落点：'note' 逐条新建（缺省）| 'daily' 聚合到「速记 YYYY-MM-DD」。PUT 未带此键时 Go 侧保留现值 */
  quickCaptureMode?: 'note' | 'daily';
  /** 速记窗打开时是否带入剪贴板文本；缺省 = true。PUT 未带此键时 Go 侧保留现值 */
  quickCaptureClipboard?: boolean;
}

/** vault 设置 API */
export const settingsApi = {
  get: () => request<VaultSettings>('/api/settings'),

  update: (settings: VaultSettings) =>
    request<{ status: string }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

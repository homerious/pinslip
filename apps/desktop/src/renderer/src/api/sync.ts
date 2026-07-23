import type { SaveSyncConfigInput, SyncStatus } from '@shared/types';
import { request } from './client';

/** git 同步 API（对应 Go 侧 internal/gitsync/api.go 契约）。
 *  token 只上行不下行：saveConfig 空串 = 不修改；status 永不含 token。 */
export const syncApi = {
  getStatus: () => request<SyncStatus>('/api/sync/status'),

  /** 配置仓库/凭证/分支/开关；保存后 Go 侧立即执行首次接入，失败抛错（message 含原因） */
  saveConfig: (input: SaveSyncConfigInput) =>
    request<SyncStatus>('/api/sync/config', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  /** 停用同步（保留 .git 与已存凭证，仅停止同步循环） */
  disable: () => request<{ status: string }>('/api/sync/config', { method: 'DELETE' }),

  /** 立即同步一轮（commit+pull+push）；失败不抛错，错误体现在返回状态的 lastError */
  syncNow: () => request<SyncStatus>('/api/sync/now', { method: 'POST' }),
};

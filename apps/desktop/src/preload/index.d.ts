import type { ElectronAPI } from '../shared/types';

declare global {
  interface Window {
    /** preload 暴露的 IPC 白名单 API */
    api: ElectronAPI;
  }
}

export {};

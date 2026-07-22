import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { getVaultPath } from '../settings';

let watchers: FSWatcher[] = [];
let debounceTimer: NodeJS.Timeout | null = null;

/** 监听保险库 notes/inbox 目录：外部修改（同步盘/手动编辑/其他设备）去抖后回调。
 *
 *  定位：驱动主界面列表近实时刷新（Go 服务有自己的 watcher 负责搜索索引，
 *  两边解耦）；自己 API 保存的文件写入也会触发——去抖后多刷一次，无害且兜底。
 *  recursive 在 Windows 上需要 Node ≥ 19.1（Electron 33 内置 Node 20，满足）。 */
export function startVaultWatch(onChanged: () => void): void {
  stopVaultWatch();
  const vault = getVaultPath();
  if (!vault) return;
  for (const sub of ['notes', 'inbox']) {
    try {
      const w = watch(path.join(vault, sub), { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(onChanged, 300);
      });
      w.on('error', () => {}); // 目录被删/无权限：静默，下次 start 重试
      watchers.push(w);
    } catch {
      // 目录不存在（如 inbox 尚未创建）：跳过
    }
  }
}

/** 停止全部监听（切换保险库前/退出前调用） */
export function stopVaultWatch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* 已关闭 */
    }
  }
  watchers = [];
}

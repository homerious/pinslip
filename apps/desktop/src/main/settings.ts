import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 应用设置（存 userData/settings.json，与 vault 数据分离——
 * 换 vault 时设置本身不跟着搬）。
 */
interface AppSettings {
  /** 保险库路径：便签 Markdown 文件的存储目录（Obsidian 式用户自选） */
  vaultPath?: string;
  /** 退出时打开着的便签 id（下次启动会话恢复） */
  openNotes?: string[];
  /** 界面语言偏好：'system'（跟随系统，缺省）或具体语言码（zh-CN/en/ja/ko/es/de/fr） */
  language?: string;
}

let cache: AppSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load(): AppSettings {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as AppSettings;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(load(), null, 2));
  } catch {
    /* 设置写失败仅本次不记忆 */
  }
}

export function getVaultPath(): string | null {
  return load().vaultPath ?? null;
}

export function setVaultPath(p: string): void {
  load().vaultPath = p;
  persist();
}

export function getOpenNotes(): string[] {
  return load().openNotes ?? [];
}

export function setOpenNotes(ids: string[]): void {
  load().openNotes = ids;
  persist();
}

/** 界面语言偏好（缺省 'system' = 跟随系统） */
export function getLanguage(): string {
  return load().language ?? 'system';
}

export function setLanguage(lang: string): void {
  load().language = lang;
  persist();
}

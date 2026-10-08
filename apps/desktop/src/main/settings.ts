import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AdvancedSettings, ResolvedAdvancedSettings } from '../shared/types';
import { sanitizeToolbarButtons, TOOLBAR_BUTTON_DEFAULT_ORDER } from '../shared/toolbar';

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
  /** 高级设置选项（全部字段有缺省值；旧 settings.json 无此字段时自然全缺省，零迁移） */
  advanced?: AdvancedSettings;
}

/** 高级设置各字段缺省值（= 简洁模型现状）；新增选项必须在此登记缺省 */
const ADVANCED_DEFAULTS: ResolvedAdvancedSettings = {
  trayIcon: true,
  taskbarIcon: true,
  notePlacement: 'cascade',
  managerTheme: 'light',
  blankNoteShortcut: 'off',
  quickCaptureShortcut: 'ctrl+shift+n',
  toolbarButtons: [...TOOLBAR_BUTTON_DEFAULT_ORDER],
};

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

/** 高级设置选项（整对象返回，缺省字段补默认值；toolbarButtons 过校验——
 *  过滤未知 id/去重/缺项补末尾，旧配置遇到新版本新增按钮自动衔接） */
export function getAdvanced(): ResolvedAdvancedSettings {
  const merged = { ...ADVANCED_DEFAULTS, ...(load().advanced ?? {}) };
  merged.toolbarButtons = sanitizeToolbarButtons(merged.toolbarButtons);
  return merged;
}

/** 按键部分更新高级设置选项（合并持久化，未提供的键保留原值）；
 *  toolbarButtons 落盘前先过校验，脏数据不进 settings.json */
export function setAdvanced(patch: AdvancedSettings): void {
  const clean: AdvancedSettings = { ...patch };
  if (patch.toolbarButtons !== undefined) {
    clean.toolbarButtons = sanitizeToolbarButtons(patch.toolbarButtons);
  }
  load().advanced = { ...(load().advanced ?? {}), ...clean };
  persist();
}

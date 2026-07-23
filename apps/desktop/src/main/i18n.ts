import { createInstance } from 'i18next';
import type { i18n as I18nInstance, TFunction } from 'i18next';
import { app } from 'electron';
import { resolveLanguage } from '../shared/languages';
import { getLanguage } from './settings';
import zhCN from '../renderer/src/i18n/locales/zh-CN.json';
import en from '../renderer/src/i18n/locales/en.json';
import ja from '../renderer/src/i18n/locales/ja.json';
import ko from '../renderer/src/i18n/locales/ko.json';
import es from '../renderer/src/i18n/locales/es.json';
import de from '../renderer/src/i18n/locales/de.json';
import fr from '../renderer/src/i18n/locales/fr.json';

/**
 * main 进程 i18n（托盘菜单 / 更新提示 / 其他主进程用户可见文案）：
 * i18next core 独立实例，与 renderer 共享同一份 locales JSON。
 * 初始化语言 = settings 里的偏好（'system' 按 app.getLocale() 映射，
 * 映射逻辑与 renderer 共用 @shared/languages）。
 */

let instance: I18nInstance | null = null;

/** app ready 后、创建托盘前调用一次 */
export function initMainI18n(): void {
  if (instance) return;
  instance = createInstance();
  void instance.init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
      ja: { translation: ja },
      ko: { translation: ko },
      es: { translation: es },
      de: { translation: de },
      fr: { translation: fr },
    },
    lng: resolveLanguage(getLanguage(), app.getLocale()),
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });
}

/** 语言切换：settings:set-language 的 handler 里调用，随后调用方重建托盘菜单 */
export function setMainLanguage(preference: string): void {
  if (!instance) return;
  void instance.changeLanguage(resolveLanguage(preference, app.getLocale()));
}

/** main 侧取文案（initMainI18n 之后使用；未初始化时兜底返回 key 本身） */
export function tMain(...args: Parameters<TFunction>): string {
  if (!instance) return String(args[0]);
  return instance.t(...args);
}

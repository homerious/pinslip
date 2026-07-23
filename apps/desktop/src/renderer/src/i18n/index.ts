import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import es from './locales/es.json';
import de from './locales/de.json';
import fr from './locales/fr.json';

/**
 * i18n 骨架（第①期：主界面 + 设置抽屉）。
 * - 资源直接 import 打包：Electron file:// 环境下不走 HTTP lazy load；
 * - 语言策略：默认跟随系统（main 进程 app.getLocale() 经 IPC 获取），
 *   设置里可固定语言，选择持久化到 userData/settings.json；
 * - key 规范：英文语义命名（settings.trash.emptyTrash），中文为基准语言。
 */

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en', 'ja', 'ko', 'es', 'de', 'fr'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** 语言偏好：'system' = 跟随系统 */
export type LanguagePreference = 'system' | Language;

/** 切换器选项的显示名（各语言的母语写法，不随界面语言变化） */
export const LANGUAGE_NATIVE_NAMES: Record<Language, string> = {
  'zh-CN': '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
};

/** 系统 locale → 支持的语言：zh*→zh-CN，ja/ko/es/de/fr 精确匹配，其余回退 en */
export function resolveSystemLanguage(locale: string): Language {
  const tag = locale.toLowerCase();
  if (tag.startsWith('zh')) return 'zh-CN';
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang !== 'zh-CN' && tag.startsWith(lang)) return lang;
  }
  return 'en';
}

let preference: LanguagePreference = 'system';
let systemLocale = 'en';

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
    ja: { translation: ja },
    ko: { translation: ko },
    es: { translation: es },
    de: { translation: de },
    fr: { translation: fr },
  },
  lng: 'zh-CN', // 启动瞬间的占位语言，initI18n() 完成后立刻校正
  fallbackLng: 'zh-CN', // 基准语言：其他语言缺 key 时回退中文
  interpolation: { escapeValue: false }, // React 自带 XSS 转义
  returnEmptyString: false,
});

function effectiveLanguage(): Language {
  return preference === 'system' ? resolveSystemLanguage(systemLocale) : preference;
}

/** 启动时调用一次：从主进程读语言偏好 + 系统 locale，校正当前语言 */
export async function initI18n(): Promise<void> {
  try {
    const info = await window.api.getLanguage();
    preference = SUPPORTED_LANGUAGES.includes(info.preference as Language)
      ? (info.preference as Language)
      : 'system';
    systemLocale = info.systemLocale;
  } catch {
    /* IPC 失败保持默认：跟随系统（en 回退） */
  }
  await i18n.changeLanguage(effectiveLanguage());
}

/** 设置页切换语言：持久化偏好并即时生效（不重启） */
export async function applyLanguagePreference(next: LanguagePreference): Promise<void> {
  preference = next;
  await i18n.changeLanguage(effectiveLanguage());
  window.api.setLanguage(next).catch(() => {});
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

export default i18n;

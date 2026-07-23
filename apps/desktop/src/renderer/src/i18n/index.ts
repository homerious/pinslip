import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  resolveLanguage,
  resolveSystemLanguage,
  SUPPORTED_LANGUAGES,
} from '@shared/languages';
import type { Language, LanguagePreference } from '@shared/languages';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import es from './locales/es.json';
import de from './locales/de.json';
import fr from './locales/fr.json';

/**
 * i18n 骨架（renderer 侧：主界面/设置抽屉/便签窗/速记窗共用，每个窗口独立实例）。
 * - 资源直接 import 打包：Electron file:// 环境下不走 HTTP lazy load；
 * - 语言策略：默认跟随系统（main 进程 app.getLocale() 经 IPC 获取），
 *   设置里可固定语言，选择持久化到 userData/settings.json；
 * - key 规范：英文语义命名（settings.trash.emptyTrash），中文为基准语言；
 * - 语言常量与系统映射逻辑在 @shared/languages（main 进程 i18n 共用同一份）。
 */

export { LANGUAGE_NATIVE_NAMES, SUPPORTED_LANGUAGES } from '@shared/languages';
export type { Language, LanguagePreference } from '@shared/languages';

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
  return resolveLanguage(preference, systemLocale);
}

/** 启动时调用一次：从主进程读语言偏好 + 系统 locale，校正当前语言；
 *  并订阅语言切换广播（任一窗口改了语言，其他已开窗口即时跟进） */
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
  window.api.onLanguageChanged((lang) => {
    void i18n.changeLanguage(
      SUPPORTED_LANGUAGES.includes(lang as Language)
        ? (lang as Language)
        : resolveSystemLanguage(systemLocale),
    );
  });
}

/** 设置页切换语言：持久化偏好并即时生效（不重启）；main 侧收到 set-language
 *  后会同步托盘/更新文案并广播其他窗口（见 ipc handler） */
export async function applyLanguagePreference(next: LanguagePreference): Promise<void> {
  preference = next;
  await i18n.changeLanguage(effectiveLanguage());
  window.api.setLanguage(next).catch(() => {});
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

export default i18n;

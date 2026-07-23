/**
 * 三进程共享的语言常量与系统 locale → 界面语言映射。
 * renderer（i18n/index.ts）与 main（i18n.ts）共用，保证两侧解析结果一致。
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

/** 系统 locale → 支持的语言：zh*→zh-CN，ja/ko/es/de/fr 前缀匹配，其余回退 en */
export function resolveSystemLanguage(locale: string): Language {
  const tag = locale.toLowerCase();
  if (tag.startsWith('zh')) return 'zh-CN';
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang !== 'zh-CN' && tag.startsWith(lang)) return lang;
  }
  return 'en';
}

/** 偏好 + 系统 locale → 生效语言 */
export function resolveLanguage(preference: string, systemLocale: string): Language {
  return SUPPORTED_LANGUAGES.includes(preference as Language)
    ? (preference as Language)
    : resolveSystemLanguage(systemLocale);
}

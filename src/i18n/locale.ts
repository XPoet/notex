export type AppLanguage = 'zh-CN' | 'zh-TW' | 'en'

export const LANGUAGE_STORAGE_KEY = 'notex.language'

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en'
}

export function resolveSystemLanguage(language: string | undefined): AppLanguage {
  const parts = (language ?? '').trim().replaceAll('_', '-').toLowerCase().split('-')
  if (parts[0] !== 'zh') return 'en'
  if (parts.includes('hant')) return 'zh-TW'
  if (parts.includes('hans')) return 'zh-CN'
  return parts.some((part) => part === 'tw' || part === 'hk' || part === 'mo') ? 'zh-TW' : 'zh-CN'
}

export function getSystemLanguage(): AppLanguage {
  return resolveSystemLanguage(typeof navigator === 'undefined' ? undefined : navigator.language)
}

export function getInitialLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isAppLanguage(saved)) return saved
  } catch {
    // 缓存不可用时仍可按系统语言启动，正式设置由 Rust 持久化。
  }
  return getSystemLanguage()
}

export function cacheLanguage(language: AppLanguage | null): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language ?? '')
  } catch {
    // 缓存仅供解锁前使用，不影响数据库中的语言设置。
  }
}

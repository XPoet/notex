import type { AppLanguage } from '@/i18n/locale'

export type ThemePreference = 'light' | 'dark' | 'system'
export type NoteSort = 'updatedAt' | 'createdAt' | 'title'

export interface SettingsSnapshot {
  language: AppLanguage | null
  theme: ThemePreference
  noteSort: NoteSort
  editorFontSize: 14 | 15 | 16 | 17 | 18
  showCategoryCounts: boolean
  dataDirectory: string
  defaultExportDirectory: string
  hasCustomDefaultExportDirectory: boolean
  appVersion: string
  schemaVersion: number
}

export interface SaveSettingsRequest {
  language: AppLanguage
  theme: ThemePreference
  noteSort: NoteSort
  editorFontSize: 14 | 15 | 16 | 17 | 18
  showCategoryCounts: boolean
  defaultExportDirectory?: string | null
}

export type SettingsErrorCode =
  | 'SETTINGS_VALIDATION_FAILED'
  | 'SETTINGS_READ_FAILED'
  | 'SETTINGS_SAVE_FAILED'
  | 'SETTINGS_DIRECTORY_UNAVAILABLE'
  | 'SETTINGS_DIRECTORY_NOT_WRITABLE'
  | 'SETTINGS_OPEN_FAILED'

export interface SettingsError {
  code: SettingsErrorCode
  message: string
}

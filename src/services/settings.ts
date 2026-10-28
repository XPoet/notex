import { t } from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { SaveSettingsRequest, SettingsError, SettingsErrorCode, SettingsSnapshot } from '@/types/settings'

interface ErrorPayload {
  code?: unknown
  message?: unknown
}

const errorCodes: SettingsErrorCode[] = [
  'SETTINGS_VALIDATION_FAILED',
  'SETTINGS_READ_FAILED',
  'SETTINGS_SAVE_FAILED',
  'SETTINGS_DIRECTORY_UNAVAILABLE',
  'SETTINGS_DIRECTORY_NOT_WRITABLE',
  'SETTINGS_OPEN_FAILED',
]

function isSettingsErrorCode(value: unknown): value is SettingsErrorCode {
  return typeof value === 'string' && errorCodes.some((code) => code === value)
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return typeof value === 'object' && value !== null
}

export function toSettingsError(error: unknown): SettingsError {
  if (isErrorPayload(error) && isSettingsErrorCode(error.code) && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
    }
  }
  return { code: 'SETTINGS_READ_FAILED', message: '无法读取本地设置，请稍后重试。' }
}

async function call<T>(command: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_)
  } catch (error: unknown) {
    throw toSettingsError(error)
  }
}

export function getSettings(): Promise<SettingsSnapshot> {
  return call<SettingsSnapshot>('get_settings')
}

export function saveSettings(request: SaveSettingsRequest): Promise<SettingsSnapshot> {
  return call<SettingsSnapshot>('save_settings', { request })
}

export function openDataDirectory(): Promise<void> {
  return call<void>('open_data_directory')
}

export async function chooseDefaultExportDirectory(): Promise<string | undefined> {
  const directory = await open({
    title: t('选择默认 Markdown 导出目录'),
    directory: true,
    multiple: false,
    canCreateDirectories: true,
  })
  return typeof directory === 'string' ? directory : undefined
}

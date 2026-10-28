import { invoke } from '@tauri-apps/api/core'
import type { BootstrapError, BootstrapErrorCode, BootstrapSnapshot } from '@/types/bootstrap'

interface TauriErrorPayload {
  code?: unknown
  message?: unknown
}

function isTauriErrorPayload(value: unknown): value is TauriErrorPayload {
  return typeof value === 'object' && value !== null
}

function isBootstrapErrorCode(value: unknown): value is BootstrapErrorCode {
  return (
    value === 'DATA_DIRECTORY_UNAVAILABLE' ||
    value === 'DATA_DIRECTORY_NOT_WRITABLE' ||
    value === 'DATABASE_OPEN_FAILED' ||
    value === 'DATABASE_LOCKED' ||
    value === 'DATABASE_CORRUPTED' ||
    value === 'MIGRATION_FAILED' ||
    value === 'BOOTSTRAP_FAILED'
  )
}

export function toBootstrapError(error: unknown): BootstrapError {
  if (isTauriErrorPayload(error) && isBootstrapErrorCode(error.code) && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
    }
  }

  return {
    code: 'BOOTSTRAP_FAILED',
    message: '本地数据初始化失败，请检查应用数据目录后重试。',
  }
}

export async function bootstrapApp(): Promise<BootstrapSnapshot> {
  try {
    return await invoke<BootstrapSnapshot>('bootstrap_app')
  } catch (error: unknown) {
    throw toBootstrapError(error)
  }
}

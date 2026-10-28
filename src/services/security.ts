import { invoke } from '@tauri-apps/api/core'
import type {
  AccessError,
  AccessErrorCode,
  AccessSnapshot,
  ConfigurePasswordRequest,
} from '@/types/security'

const errorCodes: AccessErrorCode[] = [
  'APP_LOCKED',
  'PASSWORD_INCORRECT',
  'PASSWORD_VALIDATION_FAILED',
  'PASSWORD_READ_FAILED',
  'PASSWORD_SAVE_FAILED',
  'PASSWORD_BACKUP_SYNC_FAILED',
  'PASSWORD_TOO_MANY_ATTEMPTS',
]

export function toAccessError(error: unknown): AccessError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    const code = errorCodes.find((value) => value === error.code)
    if (code !== undefined) return { code, message: error.message }
  }
  return { code: 'PASSWORD_READ_FAILED', message: '无法读取开启密码配置，请重试。' }
}

async function call(
  command: string,
  arguments_: Record<string, unknown> = {},
): Promise<AccessSnapshot> {
  try {
    return await invoke<AccessSnapshot>(command, arguments_)
  } catch (error: unknown) {
    throw toAccessError(error)
  }
}

export function getAccessStatus(): Promise<AccessSnapshot> {
  return call('get_access_status')
}

export function unlockApp(password: string): Promise<AccessSnapshot> {
  return call('unlock_app', { password })
}

export function configureStartupPassword(
  request: ConfigurePasswordRequest,
): Promise<AccessSnapshot> {
  return call('configure_startup_password', { request })
}

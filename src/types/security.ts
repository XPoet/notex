export interface AccessSnapshot {
  passwordEnabled: boolean
  locked: boolean
}

export interface ConfigurePasswordRequest {
  currentPassword?: string
  newPassword: string | null
}

export type AccessErrorCode =
  | 'APP_LOCKED'
  | 'PASSWORD_INCORRECT'
  | 'PASSWORD_VALIDATION_FAILED'
  | 'PASSWORD_READ_FAILED'
  | 'PASSWORD_SAVE_FAILED'
  | 'PASSWORD_TOO_MANY_ATTEMPTS'

export interface AccessError {
  code: AccessErrorCode
  message: string
}

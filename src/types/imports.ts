export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_IMPORT_FILES = 100

export type ImportErrorCode =
  | 'IMPORT_VALIDATION_FAILED'
  | 'IMPORT_UNSUPPORTED_FORMAT'
  | 'IMPORT_FILE_TOO_LARGE'
  | 'IMPORT_INVALID_ENCODING'
  | 'IMPORT_READ_FAILED'
  | 'IMPORT_SAVE_FAILED'

export interface ImportError {
  code: ImportErrorCode
  message: string
}

export interface ImportItem {
  id: string
  file: File
  title: string
  status: 'pending' | 'importing' | 'succeeded' | 'failed'
  noteId?: string
  error?: ImportError
}

import { invoke } from '@tauri-apps/api/core'
import { MAX_IMPORT_FILE_BYTES, type ImportError, type ImportErrorCode } from '@/types/imports'
import type { NoteDetail } from '@/types/notes'

function isImportErrorCode(value: unknown): value is ImportErrorCode {
  return (
    value === 'IMPORT_VALIDATION_FAILED' ||
    value === 'IMPORT_UNSUPPORTED_FORMAT' ||
    value === 'IMPORT_FILE_TOO_LARGE' ||
    value === 'IMPORT_INVALID_ENCODING' ||
    value === 'IMPORT_READ_FAILED' ||
    value === 'IMPORT_SAVE_FAILED'
  )
}

export function toImportError(error: unknown): ImportError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    isImportErrorCode(error.code) &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return { code: error.code, message: error.message }
  }
  return { code: 'IMPORT_SAVE_FAILED', message: '笔记导入失败，请重试。' }
}

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject({ code: 'IMPORT_READ_FAILED', message: '无法读取文件，请重新选择。' })
    }
    reader.onerror = reader.onabort = () => {
      reject({ code: 'IMPORT_READ_FAILED', message: '无法读取文件，请重新选择。' })
    }
    reader.readAsArrayBuffer(file)
  })
}

export async function importNote(file: File): Promise<NoteDetail> {
  try {
    if (!/\.(md|txt)$/i.test(file.name)) {
      throw { code: 'IMPORT_UNSUPPORTED_FORMAT', message: '仅支持 MD 和 TXT 文件。' }
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      throw { code: 'IMPORT_FILE_TOO_LARGE', message: '文件超过 10 MiB，请拆分后导入。' }
    }
    const bytes = new Uint8Array(await readFile(file))
    return await invoke<NoteDetail>('import_note', {
      fileName: file.name,
      bytes: Array.from(bytes),
    })
  } catch (error: unknown) {
    throw toImportError(error)
  }
}

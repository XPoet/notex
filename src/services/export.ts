import { t } from '@/i18n'
import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { ExportError, ExportErrorCode, ExportProgress, ExportRequest, ExportResult } from '@/types/export'

interface ErrorPayload {
  code?: unknown
  message?: unknown
}

const errorCodes: ExportErrorCode[] = [
  'EXPORT_VALIDATION_FAILED',
  'EXPORT_SCOPE_NOT_FOUND',
  'EXPORT_TARGET_UNAVAILABLE',
  'EXPORT_SNAPSHOT_FAILED',
  'EXPORT_WRITE_FAILED',
  'EXPORT_PROGRESS_UNAVAILABLE',
  'EXPORT_TASK_NOT_FOUND',
  'EXPORT_OPEN_FAILED',
]

function isExportErrorCode(value: unknown): value is ExportErrorCode {
  return typeof value === 'string' && errorCodes.includes(value as ExportErrorCode)
}

export function toExportError(error: unknown): ExportError {
  if (
    typeof error === 'object' &&
    error !== null &&
    isExportErrorCode((error as ErrorPayload).code) &&
    typeof (error as ErrorPayload).message === 'string'
  ) {
    return {
      code: (error as ErrorPayload).code as ExportErrorCode,
      message: (error as ErrorPayload).message as string,
    }
  }
  return {
    code: 'EXPORT_WRITE_FAILED',
    message: '导出失败，请检查目标目录后重试。',
  }
}

async function call<T>(command: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_)
  } catch (error: unknown) {
    throw toExportError(error)
  }
}

export async function chooseExportDirectory(): Promise<string | undefined> {
  const selected = await open({
    title: t('选择 Markdown 导出位置'),
    directory: true,
    multiple: false,
    canCreateDirectories: true,
  })
  return typeof selected === 'string' ? selected : undefined
}

export function exportNotes(
  request: ExportRequest,
  onProgress: (progress: ExportProgress) => void,
): Promise<ExportResult> {
  const channel = new Channel<ExportProgress>()
  channel.onmessage = onProgress
  return call<ExportResult>('export_notes', { request, onProgress: channel })
}

export function cancelExport(jobId: string): Promise<void> {
  return call<void>('cancel_export', { jobId })
}

export function openExportDirectory(jobId: string): Promise<void> {
  return call<void>('open_export_directory', { jobId })
}

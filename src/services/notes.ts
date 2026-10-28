import { invoke } from '@tauri-apps/api/core'
import type { NoteDetail, NoteError, NoteErrorCode, NoteSaveRequest, NoteSummary } from '@/types/notes'

interface TauriErrorPayload {
  code?: unknown
  message?: unknown
}

const noteErrorCodes: NoteErrorCode[] = [
  'NOTE_NOT_FOUND',
  'NOTE_VALIDATION_FAILED',
  'NOTE_LIST_FAILED',
  'NOTE_SAVE_FAILED',
  'RECOVERY_DRAFT_SAVE_FAILED',
]

function isTauriErrorPayload(value: unknown): value is TauriErrorPayload {
  return typeof value === 'object' && value !== null
}

function isNoteErrorCode(value: unknown): value is NoteErrorCode {
  return typeof value === 'string' && noteErrorCodes.includes(value as NoteErrorCode)
}

export function toNoteError(error: unknown): NoteError {
  if (isTauriErrorPayload(error) && isNoteErrorCode(error.code) && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'NOTE_SAVE_FAILED',
    message: '笔记保存失败，当前内容仍保留在编辑器中。',
  }
}

async function call<T>(command: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_)
  } catch (error: unknown) {
    throw toNoteError(error)
  }
}

export function createNote(categoryId?: string): Promise<NoteDetail> {
  return call<NoteDetail>('create_note', { categoryId })
}

export function listNotes(): Promise<NoteSummary[]> {
  return call<NoteSummary[]>('list_notes')
}

export function getNote(id: string): Promise<NoteDetail> {
  return call<NoteDetail>('get_note', { id })
}

export function saveNote(request: NoteSaveRequest): Promise<NoteDetail> {
  return call<NoteDetail>('save_note', request)
}

export function setNotePinned(id: string, pinned: boolean): Promise<NoteDetail> {
  return call<NoteDetail>('set_note_pinned', { id, pinned })
}

export function cleanupEmptyNote(id: string): Promise<void> {
  return call<void>('cleanup_empty_note', { id })
}

export function saveRecoveryDraft(request: NoteSaveRequest, failureCode: string): Promise<void> {
  return call<void>('save_recovery_draft', { ...request, failureCode })
}

export const NOTE_DRAG_TYPE = 'application/x-notex-note-id'

export interface NoteSummary {
  id: string
  title: string
  contentPreview: string
  tagNames: string[]
  isPinned: boolean
  createdAt: string
  updatedAt: string
}

export interface NoteDetail {
  id: string
  title: string
  content: string
  categoryId?: string
  isPinned: boolean
  createdAt: string
  updatedAt: string
}

export interface NoteSaveRequest {
  id: string
  title: string
  content: string
}

export type NoteErrorCode =
  | 'NOTE_NOT_FOUND'
  | 'NOTE_VALIDATION_FAILED'
  | 'NOTE_LIST_FAILED'
  | 'NOTE_SAVE_FAILED'
  | 'RECOVERY_DRAFT_SAVE_FAILED'

export interface NoteError {
  code: NoteErrorCode
  message: string
}

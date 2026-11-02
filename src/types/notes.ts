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

export interface NoteSaveResult {
  id: string
  updatedAt: string
  summary: NoteSummary
}

export interface NoteListRequest {
  categoryId?: string
  uncategorized?: boolean
  tagIds?: string[]
  query?: string
  offset?: number
  limit?: number
}

export interface NotePage {
  items: NoteSummary[]
  total: number
  nextOffset: number | null
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

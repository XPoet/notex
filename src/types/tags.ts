import type { NoteSummary } from './notes'

export interface TagSummary {
  id: string
  name: string
  noteCount: number
}
export interface TagMergePreview {
  sourceId: string
  targetId: string
  affectedNoteCount: number
}
export interface RenameTagResult {
  tag?: TagSummary
  mergePreview?: TagMergePreview
}
export type TagErrorCode = 'TAG_NOT_FOUND' | 'TAG_VALIDATION_FAILED' | 'TAG_DUPLICATE_NAME' | 'TAG_OPERATION_FAILED'
export interface TagError {
  code: TagErrorCode
  message: string
}
export type TagFilteredNotes = NoteSummary[]

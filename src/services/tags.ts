import { invoke } from '@tauri-apps/api/core'
import type { NoteSummary } from '@/types/notes'
import type { RenameTagResult, TagError, TagErrorCode, TagSummary } from '@/types/tags'

interface ErrorPayload {
  code?: unknown
  message?: unknown
}
const errorCodes: TagErrorCode[] = [
  'TAG_NOT_FOUND',
  'TAG_VALIDATION_FAILED',
  'TAG_DUPLICATE_NAME',
  'TAG_OPERATION_FAILED',
]
export function toTagError(error: unknown): TagError {
  if (
    typeof error === 'object' &&
    error !== null &&
    errorCodes.includes((error as ErrorPayload).code as TagErrorCode) &&
    typeof (error as ErrorPayload).message === 'string'
  ) {
    return {
      code: (error as ErrorPayload).code as TagErrorCode,
      message: (error as ErrorPayload).message as string,
    }
  }
  return { code: 'TAG_OPERATION_FAILED', message: '标签操作失败，请稍后重试。' }
}
async function call<T>(command: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_)
  } catch (error: unknown) {
    throw toTagError(error)
  }
}
export const listTags = (): Promise<TagSummary[]> => call('list_tags')
export const listNoteTags = (noteId: string): Promise<TagSummary[]> => call('list_note_tags', { noteId })
export const createTag = (name: string): Promise<TagSummary> => call('create_tag', { name })
export const renameTag = (id: string, name: string): Promise<RenameTagResult> => call('rename_tag', { id, name })
export const mergeTag = (sourceId: string, targetId: string): Promise<void> => call('merge_tag', { sourceId, targetId })
export const deleteTag = (id: string): Promise<void> => call('delete_tag', { id })
export const setNoteTags = (noteId: string, tagIds: string[]): Promise<void> =>
  call('set_note_tags', { noteId, tagIds })
export const listNotesByTags = (tagIds: string[]): Promise<NoteSummary[]> => call('list_notes_by_tags', { tagIds })

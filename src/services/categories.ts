import { invoke } from '@tauri-apps/api/core'
import type {
  CategoryDeleteImpact,
  CategoryDeleteMode,
  CategoryError,
  CategoryErrorCode,
  CategoryNode,
} from '@/types/categories'
import type { NoteSummary } from '@/types/notes'

interface ErrorPayload {
  code?: unknown
  message?: unknown
}
const errorCodes: CategoryErrorCode[] = [
  'CATEGORY_NOT_FOUND',
  'CATEGORY_VALIDATION_FAILED',
  'CATEGORY_DUPLICATE_NAME',
  'CATEGORY_MAX_DEPTH_EXCEEDED',
  'CATEGORY_CYCLE_DETECTED',
  'CATEGORY_OPERATION_FAILED',
]
export function toCategoryError(error: unknown): CategoryError {
  if (
    typeof error === 'object' &&
    error !== null &&
    errorCodes.includes((error as ErrorPayload).code as CategoryErrorCode) &&
    typeof (error as ErrorPayload).message === 'string'
  ) {
    return {
      code: (error as ErrorPayload).code as CategoryErrorCode,
      message: (error as ErrorPayload).message as string,
    }
  }
  return { code: 'CATEGORY_OPERATION_FAILED', message: '分类操作失败，请稍后重试。' }
}
async function call<T>(command: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_)
  } catch (error: unknown) {
    throw toCategoryError(error)
  }
}
export const listCategories = (): Promise<CategoryNode[]> => call('list_categories')
export const createCategory = (name: string, parentId?: string): Promise<CategoryNode> =>
  call('create_category', { name, parentId })
export const renameCategory = (id: string, name: string): Promise<CategoryNode> => call('rename_category', { id, name })
export const moveCategory = (id: string, parentId: string | undefined, orderedIds: string[]): Promise<void> =>
  call('move_category', { id, parentId, orderedIds })
export const getCategoryDeleteImpact = (id: string): Promise<CategoryDeleteImpact> =>
  call('get_category_delete_impact', { id })
export const deleteCategory = (id: string, mode: CategoryDeleteMode): Promise<void> =>
  call('delete_category', { id, mode })
export const listNotesByCategory = (categoryId?: string): Promise<NoteSummary[]> =>
  call('list_notes_by_category', { categoryId })
export const setNoteCategory = (noteId: string, categoryId?: string): Promise<void> =>
  call('set_note_category', { noteId, categoryId })

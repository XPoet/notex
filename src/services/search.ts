import { invoke } from '@tauri-apps/api/core'
import type { SearchError, SearchErrorCode, SearchPage, SearchRequest } from '@/types/search'

interface ErrorPayload {
  code?: unknown
  message?: unknown
}

const errorCodes: SearchErrorCode[] = ['SEARCH_VALIDATION_FAILED', 'SEARCH_QUERY_FAILED', 'SEARCH_INDEX_REBUILD_FAILED']

function isSearchErrorCode(value: unknown): value is SearchErrorCode {
  return typeof value === 'string' && errorCodes.includes(value as SearchErrorCode)
}

export function toSearchError(error: unknown): SearchError {
  if (
    typeof error === 'object' &&
    error !== null &&
    isSearchErrorCode((error as ErrorPayload).code) &&
    typeof (error as ErrorPayload).message === 'string'
  ) {
    return {
      code: (error as ErrorPayload).code as SearchErrorCode,
      message: (error as ErrorPayload).message as string,
    }
  }
  return {
    code: 'SEARCH_QUERY_FAILED',
    message: '无法查询本地搜索索引，请重试或重建索引。',
  }
}

async function call<T>(command: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, arguments_)
  } catch (error: unknown) {
    throw toSearchError(error)
  }
}

export function searchNotes(request: SearchRequest): Promise<SearchPage> {
  return call<SearchPage>('search_notes', request)
}

export function rebuildSearchIndex(): Promise<void> {
  return call<void>('rebuild_search_index')
}

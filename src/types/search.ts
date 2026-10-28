export interface SearchResult {
  id: string
  title: string
  contentPreview: string
  categoryPath?: string
  tagNames: string[]
  updatedAt: string
}

export interface SearchPage {
  items: SearchResult[]
  total: number
  nextOffset: number | null
}

export interface SearchRequest {
  query: string
  offset?: number
  limit?: number
}

export type SearchErrorCode = 'SEARCH_VALIDATION_FAILED' | 'SEARCH_QUERY_FAILED' | 'SEARCH_INDEX_REBUILD_FAILED'

export interface SearchError {
  code: SearchErrorCode
  message: string
}

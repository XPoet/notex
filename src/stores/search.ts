import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { rebuildSearchIndex, searchNotes, toSearchError } from '@/services/search'
import type { SearchError, SearchResult } from '@/types/search'

export const useSearchStore = defineStore('search', () => {
  const query = shallowRef('')
  const results = shallowRef<SearchResult[]>([])
  const total = shallowRef(0)
  const nextOffset = shallowRef<number | null>(null)
  const error = shallowRef<SearchError>()
  const isLoading = shallowRef(false)
  const isLoadingMore = shallowRef(false)
  const isRebuilding = shallowRef(false)
  let requestVersion = 0

  async function search(value: string): Promise<void> {
    const normalized = value.trim()
    requestVersion += 1
    const version = requestVersion
    query.value = normalized
    isLoadingMore.value = false
    if (normalized === '') {
      resetResults()
      return
    }
    isLoading.value = true
    error.value = undefined
    try {
      const page = await searchNotes({ query: normalized })
      if (version !== requestVersion) {
        return
      }
      results.value = page.items
      total.value = page.total
      nextOffset.value = page.nextOffset
    } catch (failure: unknown) {
      if (version === requestVersion) {
        resetResults()
        error.value = toSearchError(failure)
      }
    } finally {
      if (version === requestVersion) {
        isLoading.value = false
      }
    }
  }

  async function loadNext(): Promise<void> {
    const offset = nextOffset.value
    if (offset === null || query.value === '' || isLoading.value || isLoadingMore.value) {
      return
    }
    const version = requestVersion
    isLoadingMore.value = true
    try {
      const page = await searchNotes({ query: query.value, offset })
      if (version !== requestVersion) {
        return
      }
      results.value = [...results.value, ...page.items]
      total.value = page.total
      nextOffset.value = page.nextOffset
    } catch (failure: unknown) {
      if (version === requestVersion) {
        error.value = toSearchError(failure)
      }
    } finally {
      if (version === requestVersion) {
        isLoadingMore.value = false
      }
    }
  }

  async function rebuild(): Promise<void> {
    isRebuilding.value = true
    error.value = undefined
    try {
      await rebuildSearchIndex()
      await search(query.value)
    } catch (failure: unknown) {
      error.value = toSearchError(failure)
    } finally {
      isRebuilding.value = false
    }
  }

  function reset(): void {
    requestVersion += 1
    query.value = ''
    resetResults()
  }

  function resetResults(): void {
    results.value = []
    total.value = 0
    nextOffset.value = null
    error.value = undefined
    isLoading.value = false
    isLoadingMore.value = false
  }

  return {
    query,
    results,
    total,
    nextOffset,
    error,
    isLoading,
    isLoadingMore,
    isRebuilding,
    search,
    loadNext,
    rebuild,
    reset,
  }
})

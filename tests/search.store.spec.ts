import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchPage } from '@/types/search'

const searchService = vi.hoisted(() => ({
  rebuildSearchIndex: vi.fn(),
  searchNotes: vi.fn(),
  toSearchError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/search', () => searchService)

import { useSearchStore } from '@/stores/search'

const firstPage = {
  items: [
    {
      id: 'note-1',
      title: '本地数据',
      contentPreview: '第一条结果',
      categoryPath: '工作',
      tagNames: ['紧急'],
      updatedAt: '2026-07-24T00:00:00Z',
    },
  ],
  total: 2,
  nextOffset: 1,
}

describe('search store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    searchService.rebuildSearchIndex.mockReset()
    searchService.searchNotes.mockReset()
    searchService.toSearchError.mockImplementation((error: unknown) => error)
  })

  it('忽略迟到的旧请求结果，并保留最新关键词对应的页面', async () => {
    let resolveOldPage: ((value: typeof firstPage) => void) | undefined
    const oldPage = new Promise<typeof firstPage>((resolve) => {
      resolveOldPage = resolve
    })
    searchService.searchNotes.mockReturnValueOnce(oldPage).mockResolvedValueOnce({
      ...firstPage,
      items: [{ ...firstPage.items[0], id: 'note-2', title: '新关键词结果' }],
      total: 1,
      nextOffset: null,
    })
    const store = useSearchStore()

    const oldSearch = store.search('旧关键词')
    await store.search('新关键词')
    resolveOldPage?.(firstPage)
    await oldSearch

    expect(store.query).toBe('新关键词')
    expect(store.results.map((item) => item.id)).toEqual(['note-2'])
    expect(store.total).toBe(1)
  })

  it('按受控 offset 追加下一页，并在重建后重新查询当前关键词', async () => {
    searchService.searchNotes
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({
        items: [{ ...firstPage.items[0], id: 'note-2', title: '第二条结果' }],
        total: 2,
        nextOffset: null,
      })
      .mockResolvedValueOnce({ ...firstPage, nextOffset: null })
    searchService.rebuildSearchIndex.mockResolvedValue(undefined)
    const store = useSearchStore()

    await store.search('本地')
    await store.loadNext()
    await store.rebuild()

    expect(searchService.searchNotes).toHaveBeenNthCalledWith(2, { query: '本地', offset: 1 })
    expect(searchService.rebuildSearchIndex).toHaveBeenCalledOnce()
    expect(store.results).toHaveLength(1)
    expect(store.nextOffset).toBeNull()
  })

  it('切换查询时释放旧分页状态，并且旧分页结束不清理新分页的加载状态', async () => {
    let resolveOldPage: ((value: SearchPage) => void) | undefined
    let resolveNewSearch: ((value: SearchPage) => void) | undefined
    let resolveNewPage: ((value: SearchPage) => void) | undefined
    const oldPage = new Promise<SearchPage>((resolve) => {
      resolveOldPage = resolve
    })
    const newSearch = new Promise<SearchPage>((resolve) => {
      resolveNewSearch = resolve
    })
    const newPage = new Promise<SearchPage>((resolve) => {
      resolveNewPage = resolve
    })
    searchService.searchNotes
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(oldPage)
      .mockReturnValueOnce(newSearch)
      .mockReturnValueOnce(newPage)
    const store = useSearchStore()

    await store.search('旧查询')
    const oldPagination = store.loadNext()
    const currentSearch = store.search('新查询')
    expect(store.isLoadingMore).toBe(false)
    await store.loadNext()
    expect(searchService.searchNotes).toHaveBeenCalledTimes(3)

    resolveNewSearch?.({ ...firstPage, items: [{ ...firstPage.items[0], id: 'new-first' }] })
    await currentSearch
    const newPagination = store.loadNext()
    expect(store.isLoadingMore).toBe(true)
    resolveOldPage?.(firstPage)
    await oldPagination
    expect(store.isLoadingMore).toBe(true)
    expect(store.results.map((item) => item.id)).toEqual(['new-first'])

    resolveNewPage?.({ ...firstPage, items: [{ ...firstPage.items[0], id: 'new-second' }], nextOffset: null })
    await newPagination
    expect(store.isLoadingMore).toBe(false)
    expect(store.results.map((item) => item.id)).toEqual(['new-first', 'new-second'])
  })
})

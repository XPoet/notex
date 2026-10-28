import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notesService = vi.hoisted(() => ({
  cleanupEmptyNote: vi.fn(),
  createNote: vi.fn(),
  getNote: vi.fn(),
  listNotes: vi.fn(),
  saveNote: vi.fn(),
  setNotePinned: vi.fn(),
  saveRecoveryDraft: vi.fn(),
  toNoteError: vi.fn((error: unknown) => error),
}))
const categoriesService = vi.hoisted(() => ({
  listNotesByCategory: vi.fn(),
}))

vi.mock('@/services/notes', () => notesService)
vi.mock('@/services/categories', () => categoriesService)

import { useNotesStore } from '@/stores/notes'

describe('notes store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const method of Object.values(notesService)) {
      if ('mockReset' in method) {
        method.mockReset()
      }
    }
    notesService.listNotes.mockResolvedValue([])
    categoriesService.listNotesByCategory.mockReset()
  })

  it('保存失败时保留草稿并允许后续保存队列继续执行', async () => {
    const store = useNotesStore()
    notesService.createNote.mockResolvedValue({
      id: 'note-1',
      title: '',
      content: '',
      createdAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:00Z',
      isPinned: false,
    })
    await store.create()
    store.updateDraft({ title: '标题', content: '正文' })

    const failure = { code: 'NOTE_SAVE_FAILED', message: '保存失败' }
    notesService.saveNote.mockRejectedValueOnce(failure).mockResolvedValueOnce({
      id: 'note-1',
      title: '标题',
      content: '正文',
      createdAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:01Z',
      isPinned: false,
    })
    notesService.toNoteError.mockImplementation((error: unknown) => error)

    await expect(store.flush()).rejects.toEqual(failure)
    expect(store.selectedNote?.content).toBe('正文')
    expect(store.saveStatus).toBe('failed')
    expect(notesService.saveRecoveryDraft).toHaveBeenCalled()

    await expect(store.flush()).resolves.toBeUndefined()
    expect(store.saveStatus).toBe('saved')
  })

  it('加载失败时保留可重试的错误状态，而不抛出未处理拒绝', async () => {
    const store = useNotesStore()
    const failure = { code: 'NOTE_LIST_FAILED', message: '无法读取笔记列表' }
    notesService.listNotes.mockRejectedValueOnce(failure)
    notesService.toNoteError.mockImplementation((error: unknown) => error)

    await expect(store.load()).resolves.toBeUndefined()
    expect(store.error).toEqual(failure)
    expect(store.saveStatus).toBe('failed')
  })

  it('置顶前先写入草稿，再刷新同一列表数据流', async () => {
    const store = useNotesStore()
    const note = {
      id: 'note-1',
      title: '标题',
      content: '正文',
      isPinned: false,
      createdAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:00Z',
    }
    notesService.createNote.mockResolvedValue(note)
    notesService.setNotePinned.mockResolvedValue({ ...note, isPinned: true })
    await store.create()

    await store.setPinned(true)

    expect(notesService.setNotePinned).toHaveBeenCalledWith('note-1', true)
    expect(store.selectedNote?.isPinned).toBe(true)
  })

  it('新建笔记时将当前分类传递给创建服务', async () => {
    const store = useNotesStore()
    notesService.createNote.mockResolvedValue({
      id: 'category-note',
      title: '',
      content: '',
      categoryId: 'category-1',
      isPinned: false,
      createdAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:00Z',
    })

    await store.create('category-1')

    expect(notesService.createNote).toHaveBeenCalledWith('category-1')
    expect(store.selectedNote?.categoryId).toBe('category-1')
  })

  it('选择或保存分类笔记后持续刷新当前分类列表', async () => {
    const store = useNotesStore()
    const note = {
      id: 'category-note',
      title: '分类笔记',
      content: '正文',
      categoryId: 'category-1',
      isPinned: false,
      createdAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:00Z',
    }
    const summary = {
      id: note.id,
      title: note.title,
      contentPreview: '正文',
      tagNames: [],
      isPinned: false,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }
    const firstSummary = { ...summary, id: 'first-category-note', title: '首条分类笔记' }
    const firstNote = { ...note, id: firstSummary.id, title: firstSummary.title }
    categoriesService.listNotesByCategory.mockResolvedValue([firstSummary, summary])
    notesService.getNote.mockImplementation((id: string) => Promise.resolve(id === note.id ? note : firstNote))
    notesService.saveNote.mockResolvedValue({ ...note, title: '已编辑分类笔记' })

    await store.loadByCategory('category-1')
    await store.selectNote(note.id)
    store.updateDraft({ title: '已编辑分类笔记', content: note.content })
    await store.flush()

    expect(categoriesService.listNotesByCategory).toHaveBeenCalledTimes(3)
    expect(categoriesService.listNotesByCategory).toHaveBeenLastCalledWith('category-1')
    expect(notesService.listNotes).not.toHaveBeenCalled()
  })

  it('删除中间笔记后保持当前分类筛选，并自动选中相邻下一条', async () => {
    const store = useNotesStore()
    const createdAt = '2026-07-23T00:00:00Z'
    const details = [
      { id: 'a-note', title: '首条', content: '正文' },
      { id: 'removed-note', title: '待删除', content: '正文' },
      { id: 'tail-note', title: '末条', content: '正文' },
    ].map((note) => ({
      ...note,
      categoryId: 'category-1',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    }))
    const toSummary = (detail: (typeof details)[number]) => ({
      id: detail.id,
      title: detail.title,
      contentPreview: '正文',
      tagNames: [],
      isPinned: false,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    })
    const summaries = details.map(toSummary)
    notesService.getNote.mockImplementation((id: string) => {
      const matched = details.find((note) => note.id === id)
      return Promise.resolve(matched ?? details[0])
    })
    categoriesService.listNotesByCategory.mockResolvedValue(summaries)

    await store.loadByCategory('category-1')
    expect(store.selectedNote?.id).toBe('a-note')

    const remainingSummaries = summaries.filter((item) => item.id !== 'removed-note')
    categoriesService.listNotesByCategory.mockResolvedValue(remainingSummaries)
    await store.reloadAfterTrash('removed-note')

    expect(categoriesService.listNotesByCategory).toHaveBeenLastCalledWith('category-1')
    expect(notesService.listNotes).not.toHaveBeenCalled()
    expect(store.notes.map((item) => item.id)).toEqual(['a-note', 'tail-note'])
    expect(store.selectedNote?.id).toBe('tail-note')
  })

  it('删除末条笔记时自动选中相邻上一条', async () => {
    const store = useNotesStore()
    const createdAt = '2026-07-23T00:00:00Z'
    const details = [
      { id: 'a-note', title: '首条', content: '正文' },
      { id: 'b-note', title: '中条', content: '正文' },
      { id: 'removed-tail-note', title: '末条', content: '正文' },
    ].map((note) => ({
      ...note,
      categoryId: 'category-1',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    }))
    const toSummary = (detail: (typeof details)[number]) => ({
      id: detail.id,
      title: detail.title,
      contentPreview: '正文',
      tagNames: [],
      isPinned: false,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    })
    const summaries = details.map(toSummary)
    notesService.getNote.mockImplementation((id: string) => {
      const matched = details.find((note) => note.id === id)
      return Promise.resolve(matched ?? details[0])
    })
    categoriesService.listNotesByCategory.mockResolvedValue(summaries)

    await store.loadByCategory('category-1')
    const remainingSummaries = summaries.filter((item) => item.id !== 'removed-tail-note')
    categoriesService.listNotesByCategory.mockResolvedValue(remainingSummaries)
    await store.reloadAfterTrash('removed-tail-note')

    expect(store.notes.map((item) => item.id)).toEqual(['a-note', 'b-note'])
    expect(store.selectedNote?.id).toBe('b-note')
  })

  it('删除列表中唯一条笔记后清空编辑器选中态', async () => {
    const store = useNotesStore()
    const createdAt = '2026-07-23T00:00:00Z'
    const only = {
      id: 'only-note',
      title: '唯一一条',
      content: '正文',
      categoryId: 'category-1',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    }
    const onlySummary = {
      id: only.id,
      title: only.title,
      contentPreview: '正文',
      tagNames: [],
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    }
    notesService.getNote.mockResolvedValue(only)
    categoriesService.listNotesByCategory.mockResolvedValue([onlySummary])

    await store.loadByCategory('category-1')
    expect(store.selectedNote?.id).toBe('only-note')

    categoriesService.listNotesByCategory.mockResolvedValue([])
    await store.reloadAfterTrash('only-note')

    expect(store.notes).toEqual([])
    expect(store.selectedNote).toBeUndefined()
    expect(store.saveStatus).toBe('idle')
  })
})

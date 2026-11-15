import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notePage, noteSaveResult, noteSummary } from './helpers/note-page'
import type { NoteDetail, NoteSaveRequest } from '@/types/notes'

const notesService = vi.hoisted(() => ({
  cleanupEmptyNote: vi.fn(),
  createNote: vi.fn(),
  getNote: vi.fn(),
  listNotePage: vi.fn(),
  saveNote: vi.fn(),
  setNotePinned: vi.fn(),
  saveRecoveryDraft: vi.fn(),
  toNoteError: vi.fn(),
}))
const categoriesService = vi.hoisted(() => ({ setNoteCategory: vi.fn() }))
vi.mock('@/services/notes', () => notesService)
vi.mock('@/services/categories', () => categoriesService)
import { useNotesStore } from '@/stores/notes'

function detail(id: string, categoryId?: string): NoteDetail {
  return {
    id,
    title: id,
    content: `${id} 正文`,
    categoryId,
    isPinned: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }
}
function deferred<T>() {
  let complete: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    complete = resolve
  })
  return { promise, complete }
}
let records: NoteDetail[]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  records = [detail('a', 'work'), detail('b', 'work'), detail('c', 'other')]
  notesService.toNoteError.mockImplementation((error: unknown) => error)
  notesService.listNotePage.mockImplementation(async (request: unknown) => notePage(records, request))
  notesService.getNote.mockImplementation(async (id: string) => ({
    ...(records.find((note) => note.id === id) ?? detail(id)),
  }))
  notesService.createNote.mockImplementation(async (categoryId?: string) => {
    const note = { ...detail('created', categoryId), title: '', content: '' }
    records.unshift(note)
    return note
  })
  notesService.saveNote.mockImplementation(async (draft: NoteSaveRequest) => {
    const note = {
      ...detail(draft.id),
      ...records.find((item) => item.id === draft.id),
      ...draft,
      updatedAt: '2026-11-01T00:00:01Z',
    }
    records = records.map((item) => (item.id === draft.id ? note : item))
    return noteSaveResult(note)
  })
  notesService.cleanupEmptyNote.mockResolvedValue(false)
  notesService.saveRecoveryDraft.mockResolvedValue(undefined)
})

describe('notes store 保存与导航', () => {
  it('保存失败保留草稿、写恢复草稿，重试后恢复保存状态', async () => {
    const store = useNotesStore()
    await store.load()
    store.updateDraft({ title: '新标题', content: '新正文' })
    const failure = { code: 'NOTE_SAVE_FAILED', message: '保存失败' }
    notesService.saveNote.mockRejectedValueOnce(failure)
    await expect(store.flush()).rejects.toEqual(failure)
    expect(store.selectedNote?.content).toBe('新正文')
    expect(store.isDirty).toBe(true)
    expect(store.saveStatus).toBe('failed')
    expect(notesService.saveRecoveryDraft).toHaveBeenCalledWith(
      { id: 'a', title: '新标题', content: '新正文' },
      failure.code,
    )
    await store.flush()
    expect(store.isDirty).toBe(false)
    expect(store.saveStatus).toBe('saved')
  })

  it('读取列表失败只报告列表错误，不将它误报为正文保存失败', async () => {
    const store = useNotesStore()
    await store.load()
    const failure = { code: 'NOTE_LIST_FAILED', message: '无法读取列表' }
    notesService.listNotePage.mockRejectedValueOnce(failure)
    await store.refreshList()
    expect(store.listError).toEqual(failure)
    expect(store.saveStatus).toBe('saved')
    expect(store.selectedNote?.id).toBe('a')
    expect(notesService.saveRecoveryDraft).not.toHaveBeenCalled()
  })

  it('保存局部更新摘要，普通切换不重新查询列表', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.selectNote('b')
    store.updateDraft({ title: '已编辑', content: '最新正文' })
    await store.flush()
    expect(notesService.listNotePage).toHaveBeenCalledTimes(1)
    expect(store.notes.find((note) => note.id === 'b')?.contentPreview).toBe('最新正文')
    expect(store.selectedNote?.content).toBe('最新正文')
  })

  it('并发 flush 合并，保存期间新编辑也在同一个保存循环落盘', async () => {
    const store = useNotesStore()
    await store.load()
    store.updateDraft({ title: '标题', content: '版本一' })
    const gate = deferred<ReturnType<typeof noteSaveResult>>()
    notesService.saveNote.mockReturnValueOnce(gate.promise)
    const first = store.flush()
    const second = store.flush()
    expect(notesService.saveNote).toHaveBeenCalledTimes(1)
    store.updateDraft({ title: '标题', content: '版本二' })
    gate.complete(noteSaveResult({ ...detail('a'), title: '标题', content: '版本一' }))
    await Promise.all([first, second])
    expect(notesService.saveNote).toHaveBeenCalledTimes(2)
    expect(notesService.saveNote).toHaveBeenLastCalledWith({ id: 'a', title: '标题', content: '版本二' })
    expect(store.selectedNote?.content).toBe('版本二')
    expect(store.isDirty).toBe(false)
  })

  it('切换分类前保存当前草稿', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    store.updateDraft({ title: 'A 修改', content: '必须保留' })
    await store.loadByCategory('other')
    expect(records.find((note) => note.id === 'a')?.content).toBe('必须保留')
    expect(store.selectedNote?.id).toBe('c')
    expect(store.isDirty).toBe(false)
  })

  it('选择加载期间继续输入，替换编辑器前再次保存最新内容', async () => {
    const store = useNotesStore()
    await store.load()
    const gate = deferred<NoteDetail>()
    notesService.getNote.mockReturnValueOnce(gate.promise)
    const selecting = store.selectNote('b')
    await Promise.resolve()
    store.updateDraft({ title: '仍在输入', content: '加载期间输入' })
    gate.complete(detail('b'))
    await selecting
    expect(records.find((note) => note.id === 'a')?.content).toBe('加载期间输入')
    expect(store.selectedNote?.id).toBe('b')
  })

  it('保存失败时阻止切换并保留当前草稿', async () => {
    const store = useNotesStore()
    await store.load()
    store.updateDraft({ title: '标题', content: '不能丢失' })
    notesService.saveNote.mockRejectedValueOnce({ code: 'NOTE_SAVE_FAILED', message: '保存失败' })
    await expect(store.selectNote('b')).rejects.toMatchObject({ code: 'NOTE_SAVE_FAILED' })
    expect(store.selectedNote?.id).toBe('a')
    expect(store.selectedNote?.content).toBe('不能丢失')
  })

  it('快速选择时忽略旧详情的迟到响应', async () => {
    const store = useNotesStore()
    await store.load()
    const gate = deferred<NoteDetail>()
    notesService.getNote.mockReturnValueOnce(gate.promise)
    const old = store.selectNote('b')
    await Promise.resolve()
    await store.selectNote('c')
    gate.complete(detail('b'))
    await old
    expect(store.selectedNote?.id).toBe('c')
  })

  it('快速切分类时旧列表响应不覆盖新分类', async () => {
    const store = useNotesStore()
    await store.load()
    const gate = deferred<ReturnType<typeof notePage>>()
    notesService.listNotePage.mockReturnValueOnce(gate.promise)
    const old = store.loadByCategory('work')
    await Promise.resolve()
    await store.loadByCategory('other')
    gate.complete(notePage(records, { categoryId: 'work' }))
    await old
    expect(store.selectedNote?.id).toBe('c')
    expect(store.notes.map((note) => note.id)).toEqual(['c'])
  })

  it('从搜索直达未在首屏的目标只加载一次详情和一次摘要页', async () => {
    const store = useNotesStore()
    await store.load('off-page')
    expect(notesService.listNotePage).toHaveBeenCalledTimes(1)
    expect(notesService.getNote).toHaveBeenCalledExactlyOnceWith('off-page')
    expect(store.selectedNote?.id).toBe('off-page')
  })

  it('新建传递分类，创建后保持选中', async () => {
    const store = useNotesStore()
    await store.create('work')
    expect(notesService.createNote).toHaveBeenCalledWith('work')
    expect(store.selectedNote?.id).toBe('created')
    expect(store.selectedNote?.categoryId).toBe('work')
  })

  it('清理空笔记时按实际删除结果移除摘要', async () => {
    const store = useNotesStore()
    await store.create()
    notesService.cleanupEmptyNote.mockResolvedValueOnce(true)
    await store.selectNote('a')
    expect(store.notes.some((note) => note.id === 'created')).toBe(false)
  })

  it('置顶保持编辑内容并局部重排', async () => {
    const store = useNotesStore()
    await store.load()
    await store.selectNote('b')
    notesService.setNotePinned.mockImplementationOnce(async () => {
      const pinned = { ...detail('b'), isPinned: true }
      records = [pinned, ...records.filter((note) => note.id !== 'b')]
      return pinned
    })
    await store.setPinned(true)
    expect(store.notes[0]?.id).toBe('b')
    expect(store.selectedNote?.isPinned).toBe(true)
    expect(notesService.listNotePage).toHaveBeenCalledTimes(2)
  })

  it.each(['b', 'c'])('删除 %s 后选择相邻笔记', async (id) => {
    const store = useNotesStore()
    await store.load()
    await store.selectNote(id)
    records = records.filter((note) => note.id !== id)
    await store.reloadAfterTrash(id)
    expect(store.selectedNote?.id).toBe(id === 'b' ? 'c' : 'b')
  })

  it('分页搜索在服务端覆盖全部条目，加载更多去重，保留编辑器', async () => {
    const store = useNotesStore()
    records = Array.from({ length: 80 }, (_, index) => detail(`note-${index}`))
    await store.load()
    expect(store.notes).toHaveLength(50)
    await store.loadNext()
    expect(store.notes).toHaveLength(80)
    expect(store.nextOffset).toBeNull()
    await store.refreshList('note-79')
    expect(store.notes.map((note) => note.id)).toEqual(['note-79'])
    expect(store.selectedNote?.id).toBe('note-0')
    expect(store.total).toBe(1)
    expect(store.notes[0]).toEqual(noteSummary(detail('note-79')))
  })

  it('新搜索丢弃旧分页并复位分页加载状态', async () => {
    const store = useNotesStore()
    records = Array.from({ length: 80 }, (_, index) => detail(`note-${index}`))
    await store.load()
    const gate = deferred<ReturnType<typeof notePage>>()
    notesService.listNotePage.mockReturnValueOnce(gate.promise)
    const oldPage = store.loadNext()
    expect(store.isLoadingMore).toBe(true)
    await store.refreshList('note-79')
    gate.complete(notePage(records, { offset: 50 }))
    await oldPage
    expect(store.isLoadingMore).toBe(false)
    expect(store.notes.map((note) => note.id)).toEqual(['note-79'])
  })

  it('保存后的摘要请求等待期间继续输入，flush 也要等待新版本落盘', async () => {
    const store = useNotesStore()
    await store.load()
    await store.refreshList('a')
    const gate = deferred<ReturnType<typeof notePage>>()
    const started = deferred<void>()
    notesService.listNotePage.mockImplementationOnce(() => {
      started.complete()
      return gate.promise
    })
    store.updateDraft({ title: 'a', content: '版本一' })
    const saving = store.flush()
    await started.promise
    store.updateDraft({ title: 'a', content: '摘要加载期间的版本二' })
    gate.complete(notePage(records, { query: 'a' }))
    await saving
    expect(records.find((note) => note.id === 'a')?.content).toBe('摘要加载期间的版本二')
    expect(store.isDirty).toBe(false)
    expect(notesService.saveNote).toHaveBeenCalledTimes(2)
  })

  it('保存首屏之外的搜索目标后重新获取有界摘要页', async () => {
    const store = useNotesStore()
    records = Array.from({ length: 80 }, (_, index) => detail(`note-${index}`))
    await store.load('note-79')
    notesService.saveNote.mockImplementationOnce(async (draft: NoteSaveRequest) => {
      const saved = { ...detail(draft.id), ...draft, updatedAt: '2026-11-01T00:00:02Z' }
      records = [saved, ...records.filter((note) => note.id !== saved.id)]
      return noteSaveResult(saved)
    })
    store.updateDraft({ title: '修改后首条', content: '新内容' })
    await store.flush()
    expect(notesService.listNotePage).toHaveBeenCalledTimes(2)
    expect(store.notes[0]?.id).toBe('note-79')
    expect(store.notes).toHaveLength(50)
  })

  it('分类加载期间搜索使用新分类，并且不取消导航的详情选择', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    const gate = deferred<ReturnType<typeof notePage>>()
    const started = deferred<void>()
    notesService.listNotePage.mockImplementationOnce(() => {
      started.complete()
      return gate.promise
    })
    const navigating = store.loadByCategory('other')
    await started.promise
    await store.refreshList('c')
    gate.complete(notePage(records, { categoryId: 'other' }))
    await navigating
    expect(notesService.listNotePage).toHaveBeenLastCalledWith({ categoryId: 'other', query: 'c', limit: 50 })
    expect(store.selectedNote?.id).toBe('c')
    expect(store.notes.map((note) => note.id)).toEqual(['c'])
  })

  it('旧删除响应不清空另一篇当前笔记的未保存草稿', async () => {
    const store = useNotesStore()
    await store.load()
    await store.selectNote('b')
    store.updateDraft({ title: 'B 的草稿', content: '不能被A删除响应清空' })
    records = records.filter((note) => note.id !== 'a')
    await store.reloadAfterTrash('a')
    expect(store.selectedNote?.id).toBe('b')
    expect(store.selectedNote?.content).toBe('不能被A删除响应清空')
    expect(store.isDirty).toBe(true)
    await store.flush()
    expect(records.find((note) => note.id === 'b')?.content).toBe('不能被A删除响应清空')
  })

  it('取消旧笔记置顶后复位摘要页，继续分页不漏掉边界条目', async () => {
    const store = useNotesStore()
    const all = Array.from({ length: 80 }, (_, index) => detail(`note-${index}`))
    const oldest = { ...detail('note-79'), isPinned: true }
    records = [oldest, ...all.slice(0, 79)]
    await store.load()
    notesService.setNotePinned.mockImplementationOnce(async () => {
      records = all
      return detail('note-79')
    })
    await store.setPinned(false)
    await store.loadNext()
    expect(store.notes).toHaveLength(80)
    expect(new Set(store.notes.map((note) => note.id)).size).toBe(80)
    expect(store.nextOffset).toBeNull()
  })

  it('空白笔记清理期间不能重新进入它并在删除后留下孤立草稿', async () => {
    const store = useNotesStore()
    await store.create()
    const gate = deferred<boolean>()
    const started = deferred<void>()
    notesService.cleanupEmptyNote.mockImplementationOnce(() => {
      started.complete()
      return gate.promise
    })
    const leaving = store.selectNote('a')
    await started.promise
    expect(store.selectedNote?.id).toBe('a')
    const returning = store.selectNote('created')
    await Promise.resolve()
    expect(store.selectedNote?.id).toBe('a')
    records = records.filter((note) => note.id !== 'created')
    gate.complete(true)
    await Promise.all([leaving, returning])
    expect(store.selectedNote?.id).toBe('a')
    expect(store.notes.some((note) => note.id === 'created')).toBe(false)
    expect(notesService.getNote.mock.calls.filter(([id]) => id === 'created')).toHaveLength(0)
  })
})

describe('notes store 多笔记会话', () => {
  it('打开其他分栏不改变选中笔记，同一笔记复用草稿和详情读取', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    store.updateDraft({ title: 'B 草稿', content: '分栏内容' }, 'b')
    await store.openNote('b')
    expect(store.selectedNote?.id).toBe('a')
    expect(store.getSession('b')?.note.content).toBe('分栏内容')
    expect(notesService.getNote.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1)
    store.activateNote('b')
    expect(store.selectedNote?.content).toBe('分栏内容')
    expect(store.saveStatus).toBe('editing')
    expect(notesService.saveNote).not.toHaveBeenCalled()
  })

  it('flush 保存所有分栏草稿，并发调用共享任务且继续保存最新编辑', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    store.updateDraft({ title: 'A 标题', content: 'A 内容' }, 'a')
    store.updateDraft({ title: 'B 标题', content: 'B 内容一' }, 'b')
    const gate = deferred<ReturnType<typeof noteSaveResult>>()
    notesService.saveNote.mockReturnValueOnce(gate.promise)
    const first = store.flush()
    const second = store.flush()
    store.updateDraft({ title: 'B 标题', content: 'B 内容二' }, 'b')
    gate.complete(noteSaveResult({ ...detail('a'), title: 'A 标题', content: 'A 内容' }))
    await Promise.all([first, second])
    expect(notesService.saveNote).toHaveBeenCalledTimes(2)
    expect(notesService.saveNote).toHaveBeenLastCalledWith({ id: 'b', title: 'B 标题', content: 'B 内容二' })
    expect(store.getSession('a')?.saveStatus).toBe('saved')
    expect(store.getSession('b')?.saveStatus).toBe('saved')
    expect(store.isDirty).toBe(false)
  })

  it('一个分栏保存失败仍保存其他分栏，失败草稿保留且可以重试', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    store.updateDraft({ title: 'A 草稿', content: 'A 内容' }, 'a')
    store.updateDraft({ title: 'B 草稿', content: 'B 内容' }, 'b')
    const failure = { code: 'NOTE_SAVE_FAILED', message: 'A 保存失败' }
    notesService.saveNote.mockRejectedValueOnce(failure)
    await expect(store.flush()).rejects.toEqual(failure)
    expect(store.getSession('a')?.saveStatus).toBe('failed')
    expect(store.getSession('a')?.note.content).toBe('A 内容')
    expect(store.getSession('b')?.saveStatus).toBe('saved')
    expect(records.find((note) => note.id === 'b')?.content).toBe('B 内容')
    await store.flush()
    expect(store.getSession('a')?.saveStatus).toBe('saved')
    expect(store.isDirty).toBe(false)
  })

  it('关闭分栏前保存，保存失败时保留会话，重试后释放会话', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    await store.retainNotes(['a', 'b'])
    store.updateDraft({ title: 'B 草稿', content: '关闭前保存' }, 'b')
    notesService.saveNote.mockRejectedValueOnce({ code: 'NOTE_SAVE_FAILED', message: '保存失败' })
    await expect(store.retainNotes(['a'])).rejects.toMatchObject({ code: 'NOTE_SAVE_FAILED' })
    expect(store.getSession('b')?.note.content).toBe('关闭前保存')
    await store.retainNotes(['a'])
    expect(store.getSession('b')).toBeUndefined()
    expect(records.find((note) => note.id === 'b')?.content).toBe('关闭前保存')
  })

  it('可见空白分栏在切换焦点时保留，关闭后才清理', async () => {
    const store = useNotesStore()
    await store.create()
    await store.retainNotes(['created'])
    await store.selectNote('a')
    expect(notesService.cleanupEmptyNote).not.toHaveBeenCalled()
    await store.retainNotes(['a', 'created'])
    notesService.cleanupEmptyNote.mockResolvedValueOnce(true)
    await store.retainNotes(['a'])
    expect(notesService.cleanupEmptyNote).toHaveBeenCalledExactlyOnceWith('created')
    expect(store.getSession('created')).toBeUndefined()
  })

  it('迟到的释放不会清理新一轮布局重新显示的笔记', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    store.updateDraft({ title: 'B 草稿', content: 'B 内容' }, 'b')
    const gate = deferred<ReturnType<typeof noteSaveResult>>()
    notesService.saveNote.mockReturnValueOnce(gate.promise)
    const closing = store.retainNotes(['a'])
    const reopening = store.retainNotes(['a', 'b'])
    gate.complete(noteSaveResult({ ...detail('b'), title: 'B 草稿', content: 'B 内容' }))
    await Promise.all([closing, reopening])
    expect(store.getSession('b')?.note.content).toBe('B 内容')
  })

  it('焦点切换取消等待中的详情选择，空白分栏也能同步激活', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('c')
    const gate = deferred<NoteDetail>()
    notesService.getNote.mockReturnValueOnce(gate.promise)
    const selecting = store.selectNote('b')
    await Promise.resolve()
    store.activateNote('c')
    gate.complete(detail('b'))
    await selecting
    expect(store.selectedNote?.id).toBe('c')
    store.activateNote(undefined)
    expect(store.selectedNote).toBeUndefined()
    expect(store.getSession('c')?.note.id).toBe('c')
  })

  it('删除笔记移除共享会话，不影响其他分栏草稿或重新保存已删除笔记', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    store.updateDraft({ title: 'B 草稿', content: '保留内容' }, 'b')
    records = records.filter((note) => note.id !== 'b')
    await store.reloadAfterTrash('b')
    expect(store.getSession('b')).toBeUndefined()
    expect(store.selectedNote?.id).toBe('a')
    await store.flush()
    expect(notesService.saveNote).not.toHaveBeenCalled()
  })

  it('切换到已有分栏时保留切换等待期间该笔记的最新草稿', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    const selecting = store.selectNote('b')
    await Promise.resolve()
    store.updateDraft({ title: 'B 最新标题', content: '等待期间的最新草稿' }, 'b')
    await selecting
    expect(store.selectedNote?.content).toBe('等待期间的最新草稿')
    expect(store.getSession('b')?.note.content).toBe('等待期间的最新草稿')
  })

  it('置顶在等待保存时固定目标笔记，焦点切换不会改写另一笔记', async () => {
    const store = useNotesStore()
    await store.load()
    await store.openNote('b')
    store.updateDraft({ title: 'A 草稿', content: 'A 内容' }, 'a')
    const gate = deferred<ReturnType<typeof noteSaveResult>>()
    notesService.saveNote.mockReturnValueOnce(gate.promise)
    notesService.setNotePinned.mockResolvedValueOnce({ ...detail('a'), isPinned: true })
    const pinning = store.setPinned(true)
    store.activateNote('b')
    gate.complete(noteSaveResult({ ...detail('a'), title: 'A 草稿', content: 'A 内容' }))
    await pinning
    expect(notesService.setNotePinned).toHaveBeenCalledWith('a', true)
    expect(store.getSession('a')?.note.isPinned).toBe(true)
    expect(store.getSession('b')?.note.isPinned).toBe(false)
    expect(store.selectedNote?.id).toBe('b')
  })

  it('允许移动当前摘要列表之外已打开的笔记，并保留其当前分栏', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.openNote('c')
    store.activateNote('c')
    expect(store.notes.some((note) => note.id === 'c')).toBe(false)
    await store.moveToCategory('c', 'another')
    expect(categoriesService.setNoteCategory).toHaveBeenCalledWith('c', 'another')
    expect(store.getSession('c')?.note.categoryId).toBe('another')
    expect(store.selectedNote?.id).toBe('c')
  })

  it('移动操作等待期间切换分栏后，不替换新激活分栏的笔记', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.openNote('b')
    const gate = deferred<void>()
    const started = deferred<void>()
    categoriesService.setNoteCategory.mockImplementationOnce(async () => {
      started.complete()
      await gate.promise
      records = records.map((note) => (note.id === 'a' ? { ...note, categoryId: 'other' } : note))
    })
    const moving = store.moveToCategory('a', 'other')
    await started.promise
    store.activateNote('b')
    gate.complete()
    await moving
    expect(store.selectedNote?.id).toBe('b')
    expect(store.getSession('a')?.note.categoryId).toBe('other')
  })

  it('移动期间切到同笔记的另一个分栏也取消自动相邻选择', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    const gate = deferred<void>()
    const started = deferred<void>()
    categoriesService.setNoteCategory.mockImplementationOnce(async () => {
      started.complete()
      await gate.promise
      records = records.map((note) => (note.id === 'a' ? { ...note, categoryId: 'other' } : note))
    })
    const moving = store.moveToCategory('a', 'other')
    await started.promise
    store.activateNote('a')
    gate.complete()
    await moving
    expect(store.selectedNote?.id).toBe('a')
    expect(store.selectedNote?.categoryId).toBe('other')
  })

  it('分类摘要加载期间激活其他分栏，仍更新分类列表但保留焦点笔记', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.openNote('b')
    const gate = deferred<ReturnType<typeof notePage>>()
    const started = deferred<void>()
    notesService.listNotePage.mockImplementationOnce(() => {
      started.complete()
      return gate.promise
    })
    const navigating = store.loadByCategory('other')
    await started.promise
    store.activateNote('b')
    gate.complete(notePage(records, { categoryId: 'other' }))
    await navigating
    expect(store.notes.map((note) => note.id)).toEqual(['c'])
    expect(store.selectedNote?.id).toBe('b')
    expect(store.isLoading).toBe(false)
    await store.refreshList()
    expect(notesService.listNotePage).toHaveBeenLastCalledWith({ categoryId: 'other', limit: 50 })
  })

  it('分类详情加载期间切换分栏，只取消正文选择并复位加载状态', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.openNote('b')
    const gate = deferred<NoteDetail>()
    const started = deferred<void>()
    notesService.getNote.mockImplementationOnce(() => {
      started.complete()
      return gate.promise
    })
    const navigating = store.loadByCategory('other')
    await started.promise
    store.activateNote('b')
    gate.complete(detail('c', 'other'))
    await navigating
    expect(store.notes.map((note) => note.id)).toEqual(['c'])
    expect(store.selectedNote?.id).toBe('b')
    expect(store.isLoading).toBe(false)
  })

  it('分类导航等待保存时切换分栏，不取消新分类的摘要加载', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.openNote('b')
    store.updateDraft({ title: 'A 草稿', content: '保存等待中' })
    const gate = deferred<ReturnType<typeof noteSaveResult>>()
    notesService.saveNote.mockReturnValueOnce(gate.promise)
    const navigating = store.loadByCategory('other')
    store.activateNote('b')
    gate.complete(noteSaveResult({ ...detail('a'), title: 'A 草稿', content: '保存等待中' }))
    await navigating
    expect(store.notes.map((note) => note.id)).toEqual(['c'])
    expect(store.selectedNote?.id).toBe('b')
    expect(store.isLoading).toBe(false)
  })

  it('已取消的分类正文读取失败，不遮住已成功加载的新分类列表', async () => {
    const store = useNotesStore()
    await store.loadByCategory('work')
    await store.openNote('b')
    const gate = deferred<void>()
    const started = deferred<void>()
    notesService.getNote.mockImplementationOnce(async () => {
      started.complete()
      await gate.promise
      throw { code: 'NOTE_NOT_FOUND', message: '笔记不存在' }
    })
    const navigating = store.loadByCategory('other')
    await started.promise
    store.activateNote('b')
    gate.complete()
    await navigating
    expect(store.notes.map((note) => note.id)).toEqual(['c'])
    expect(store.selectedNote?.id).toBe('b')
    expect(store.listError).toBeUndefined()
    expect(store.isLoading).toBe(false)
  })
})

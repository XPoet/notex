import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import {
  cleanupEmptyNote,
  createNote,
  getNote,
  listNotePage,
  saveNote,
  setNotePinned,
  saveRecoveryDraft,
  toNoteError,
} from '@/services/notes'
import { setNoteCategory } from '@/services/categories'
import { useSettingsStore } from '@/stores/settings'
import type { NoteDetail, NoteError, NoteListRequest, NotePage, NoteSummary } from '@/types/notes'

export type SaveStatus = 'idle' | 'editing' | 'saving' | 'saved' | 'failed'
type NoteFilter = Omit<NoteListRequest, 'offset' | 'limit'>
const PAGE_SIZE = 50

export const useNotesStore = defineStore('notes', () => {
  const notes = shallowRef<NoteSummary[]>([])
  const selectedNote = shallowRef<NoteDetail>()
  const saveStatus = shallowRef<SaveStatus>('idle')
  const error = shallowRef<NoteError>()
  const listError = shallowRef<NoteError>()
  const isDirty = shallowRef(false)
  const isLoading = shallowRef(false)
  const isLoadingMore = shallowRef(false)
  const total = shallowRef(0)
  const nextOffset = shallowRef<number | null>(null)
  const settings = useSettingsStore()
  let revision = 0
  let navigationVersion = 0
  let pageVersion = 0
  let activeFilter: NoteFilter = {}
  let saveTask: Promise<void> | undefined
  let summaryNeedsRefresh = false
  const pendingCleanups = new Map<string, Promise<boolean>>()

  const hasSelectedNote = computed(() => selectedNote.value !== undefined)

  function sortSummaries(items: NoteSummary[]): NoteSummary[] {
    const sort = settings.snapshot?.noteSort ?? 'updatedAt'
    return items.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      // 标题的 NOCASE 顺序交给 SQLite；保存后仅刷新有界摘要页。
      if (sort === 'title') return 0
      const order = b[sort].localeCompare(a[sort])
      return order || b.id.localeCompare(a.id)
    })
  }

  function patchSummary(summary: NoteSummary): void {
    if (!notes.value.some((note) => note.id === summary.id)) {
      summaryNeedsRefresh = true
      return
    }
    notes.value = sortSummaries(notes.value.map((note) => (note.id === summary.id ? summary : note)))
  }

  function removeSummary(id: string): void {
    if (!notes.value.some((note) => note.id === id)) return
    notes.value = notes.value.filter((note) => note.id !== id)
    total.value = Math.max(0, total.value - 1)
    if (nextOffset.value !== null) nextOffset.value = Math.max(0, nextOffset.value - 1)
  }

  function applyPage(page: NotePage): void {
    const known = new Map(notes.value.map((note) => [note.id, note]))
    notes.value = page.items.map((note) => {
      const current = known.get(note.id)
      return current !== undefined && current.updatedAt > note.updatedAt ? current : note
    })
    total.value = page.total
    nextOffset.value = page.nextOffset
  }

  /** 保存循环始终读取最新草稿；并发 flush 共享任务，不重复排队同一版本。 */
  function flush(): Promise<void> {
    if (saveTask !== undefined) return saveTask
    if (!isDirty.value || selectedNote.value === undefined) return Promise.resolve()
    saveTask = persistDrafts().finally(() => {
      saveTask = undefined
    })
    return saveTask
  }

  async function persistDrafts(): Promise<void> {
    do {
      while (isDirty.value && selectedNote.value !== undefined) {
        const note = selectedNote.value
        const requestRevision = revision
        const draft = { id: note.id, title: note.title, content: note.content }
        saveStatus.value = 'saving'
        try {
          const saved = await saveNote(draft)
          patchSummary(saved.summary)
          if (selectedNote.value?.id === saved.id) {
            selectedNote.value = { ...selectedNote.value, updatedAt: saved.updatedAt }
            if (revision === requestRevision) {
              isDirty.value = false
              saveStatus.value = 'saved'
              error.value = undefined
            }
          }
        } catch (failure: unknown) {
          const saveError = toNoteError(failure)
          error.value = saveError
          saveStatus.value = 'failed'
          // 等待恢复草稿写入后才结束本次任务，后续成功保存不会被迟到的恢复写覆盖。
          const current = selectedNote.value
          if (current?.id === draft.id) {
            await saveRecoveryDraft(
              { id: current.id, title: current.title, content: current.content },
              saveError.code,
            ).catch(() => undefined)
          }
          throw saveError
        }
      }
      // 标题排序或搜索条件可能改变页边界；仅重取有界摘要页，不回读正文。
      if (!isLoading.value && (summaryNeedsRefresh || settings.snapshot?.noteSort === 'title' || activeFilter.query))
        await refreshList()
    } while (isDirty.value && selectedNote.value !== undefined)
  }

  function updateDraft(change: Pick<NoteDetail, 'title' | 'content'>): void {
    const note = selectedNote.value
    if (note === undefined || (note.title === change.title && note.content === change.content)) return
    selectedNote.value = { ...note, ...change }
    revision += 1
    isDirty.value = true
    saveStatus.value = 'editing'
    error.value = undefined
  }

  function commitSelection(note: NoteDetail | undefined): void {
    selectedNote.value = note
    isDirty.value = false
    saveStatus.value = note === undefined ? 'idle' : 'saved'
    error.value = undefined
  }

  async function cleanupPrevious(previous: NoteDetail | undefined): Promise<void> {
    if (previous === undefined || previous.id === selectedNote.value?.id) return
    if (previous.title.trim() !== '' || previous.content.trim() !== '') return
    const existing = pendingCleanups.get(previous.id)
    if (existing !== undefined) {
      await existing
      return
    }
    const task = cleanupEmptyNote(previous.id)
      .then((deleted) => {
        if (deleted) removeSummary(previous.id)
        return deleted
      })
      // 清理失败保留记录，随后仍可以重新选中并编辑。
      .catch(() => false)
      .finally(() => {
        pendingCleanups.delete(previous.id)
      })
    pendingCleanups.set(previous.id, task)
    await task
  }

  async function loadFiltered(filter: NoteFilter, selectedId?: string): Promise<void> {
    const version = ++navigationVersion
    pageVersion += 1
    try {
      await flush()
    } catch (failure: unknown) {
      if (version === navigationVersion) isLoading.value = false
      throw failure
    }
    if (version !== navigationVersion) return
    const pageRequest = ++pageVersion
    activeFilter = filter
    isLoading.value = true
    isLoadingMore.value = false
    listError.value = undefined
    try {
      const startingRevision = revision
      let page = await listNotePage({ ...filter, limit: PAGE_SIZE })
      let id = selectedId ?? page.items[0]?.id
      const cleanup = id === undefined ? undefined : pendingCleanups.get(id)
      if (cleanup !== undefined && (await cleanup)) {
        page = await listNotePage({ ...filter, limit: PAGE_SIZE })
        id = page.items[0]?.id
      }
      const detail = id === undefined ? undefined : await getNote(id)
      await flush()
      if (version !== navigationVersion) return
      // 加载期间的最后一次保存可能改变排序或筛选结果，只重新读取有界摘要页。
      if (startingRevision !== revision && pageRequest === pageVersion)
        page = await listNotePage({ ...filter, limit: PAGE_SIZE })
      await flush()
      if (version !== navigationVersion) return
      const previous = selectedNote.value
      // 期间发起的新搜索只替换摘要页，不能取消本次导航的详情选择。
      if (pageRequest === pageVersion) applyPage(page)
      commitSelection(detail?.id === previous?.id ? previous : detail)
      await cleanupPrevious(previous)
    } catch (failure: unknown) {
      if (version === navigationVersion && pageRequest === pageVersion) listError.value = toNoteError(failure)
    } finally {
      if (pageRequest === pageVersion) isLoading.value = false
    }
  }

  async function load(selectedId?: string): Promise<void> {
    await loadFiltered({}, selectedId)
  }

  async function loadByCategory(categoryId?: string, selectedId?: string): Promise<void> {
    await loadFiltered(categoryId === undefined ? { uncategorized: true } : { categoryId }, selectedId)
  }

  async function loadByTags(tagIds: string[], selectedId?: string): Promise<void> {
    await loadFiltered({ tagIds }, selectedId)
  }

  /** 仅刷新摘要页，保留当前编辑会话。 */
  async function refreshList(query = activeFilter.query): Promise<void> {
    const version = ++pageVersion
    const filter = { ...activeFilter, query }
    activeFilter = filter
    isLoading.value = true
    isLoadingMore.value = false
    listError.value = undefined
    try {
      const page = await listNotePage({ ...filter, limit: PAGE_SIZE })
      if (version === pageVersion) {
        applyPage(page)
        summaryNeedsRefresh = false
      }
    } catch (failure: unknown) {
      if (version === pageVersion) listError.value = toNoteError(failure)
    } finally {
      if (version === pageVersion) isLoading.value = false
    }
  }

  async function loadNext(): Promise<void> {
    const offset = nextOffset.value
    if (offset === null || isLoading.value || isLoadingMore.value) return
    const version = pageVersion
    isLoadingMore.value = true
    try {
      const page = await listNotePage({ ...activeFilter, offset, limit: PAGE_SIZE })
      if (version !== pageVersion) return
      const existing = new Set(notes.value.map((note) => note.id))
      notes.value = [...notes.value, ...page.items.filter((note) => !existing.has(note.id))]
      total.value = page.total
      nextOffset.value = page.nextOffset
    } catch (failure: unknown) {
      if (version === pageVersion) listError.value = toNoteError(failure)
    } finally {
      if (version === pageVersion) isLoadingMore.value = false
    }
  }

  async function selectNote(id: string): Promise<void> {
    const version = ++navigationVersion
    if (selectedNote.value?.id === id) return
    await flush()
    if (version !== navigationVersion) return
    const cleanup = pendingCleanups.get(id)
    if (cleanup !== undefined && (await cleanup)) return
    if (version !== navigationVersion) return
    const detail = await getNote(id)
    await flush()
    if (version !== navigationVersion) return
    const previous = selectedNote.value
    commitSelection(detail)
    await cleanupPrevious(previous)
  }

  async function create(categoryId?: string): Promise<void> {
    const version = ++navigationVersion
    await flush()
    if (version !== navigationVersion) return
    const created = await createNote(categoryId)
    await flush()
    if (version !== navigationVersion) return
    const previous = selectedNote.value
    commitSelection(created)
    await cleanupPrevious(previous)
    await refreshList()
  }

  async function reloadSelected(): Promise<void> {
    await flush()
    const id = selectedNote.value?.id
    if (id === undefined) return
    const version = ++navigationVersion
    const loadedRevision = revision
    const detail = await getNote(id)
    await flush()
    if (version !== navigationVersion) return
    const current = selectedNote.value
    commitSelection(
      current?.id === id && revision !== loadedRevision
        ? { ...detail, title: current.title, content: current.content, updatedAt: current.updatedAt }
        : detail,
    )
    await refreshList()
  }

  async function setPinned(pinned: boolean): Promise<void> {
    await flush()
    const note = selectedNote.value
    if (note === undefined) return
    const saved = await setNotePinned(note.id, pinned)
    if (selectedNote.value?.id === saved.id) {
      selectedNote.value = { ...selectedNote.value, isPinned: saved.isPinned, updatedAt: saved.updatedAt }
    }
    const summary = notes.value.find((item) => item.id === saved.id)
    if (summary !== undefined) patchSummary({ ...summary, isPinned: saved.isPinned, updatedAt: saved.updatedAt })
    // 取消置顶可能把当前项移到已加载页之外，必须复位偏移，防止跨页漏项。
    await refreshList()
  }

  async function reloadAfterTrash(trashedId: string): Promise<void> {
    if (selectedNote.value?.id !== trashedId) {
      removeSummary(trashedId)
      await refreshList()
      return
    }
    // 防御异步删除期间的外部草稿更新；保存失败时保留它，不能直接清空。
    if (isDirty.value) await flush()
    const index = notes.value.findIndex((note) => note.id === trashedId)
    const remaining = notes.value.filter((note) => note.id !== trashedId)
    const target = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
    // 调用方已经保存并删除，不能再次尝试保存已不存在的笔记。
    commitSelection(undefined)
    await loadFiltered(activeFilter, target?.id)
  }

  async function moveToCategory(id: string, categoryId?: string): Promise<void> {
    if (!notes.value.some((note) => note.id === id)) return
    await flush()
    const index = notes.value.findIndex((note) => note.id === id)
    await setNoteCategory(id, categoryId)
    if (selectedNote.value?.id === id) selectedNote.value = { ...selectedNote.value, categoryId }
    await refreshList()
    const outsideCategory =
      activeFilter.uncategorized === true
        ? categoryId !== undefined
        : activeFilter.categoryId !== undefined && activeFilter.categoryId !== categoryId
    if (!outsideCategory || selectedNote.value?.id !== id || isDirty.value) return
    const target = notes.value[Math.min(Math.max(index, 0), notes.value.length - 1)]
    if (target === undefined) commitSelection(undefined)
    else await selectNote(target.id)
  }

  return {
    notes,
    selectedNote,
    saveStatus,
    error,
    listError,
    isDirty,
    isLoading,
    isLoadingMore,
    total,
    nextOffset,
    hasSelectedNote,
    load,
    loadByCategory,
    loadByTags,
    refreshList,
    loadNext,
    reloadAfterTrash,
    updateDraft,
    flush,
    selectNote,
    create,
    reloadSelected,
    setPinned,
    moveToCategory,
  }
})

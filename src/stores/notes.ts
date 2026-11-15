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

export interface NoteSession {
  note: NoteDetail
  saveStatus: SaveStatus
  error?: NoteError
}

interface DraftSession extends NoteSession {
  revision: number
  dirty: boolean
}
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
  const sessions = shallowRef(new Map<string, DraftSession>())
  const settings = useSettingsStore()
  let revision = 0
  let navigationVersion = 0
  let listNavigationVersion = 0
  let pageVersion = 0
  let activeFilter: NoteFilter = {}
  let saveTask: Promise<void> | undefined
  let summaryNeedsRefresh = false
  const pendingCleanups = new Map<string, Promise<boolean>>()
  const pendingOpens = new Map<string, Promise<NoteDetail>>()
  let retainedNoteIds = new Set<string>()
  let retentionVersion = 0

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

  function getSession(id: string): NoteSession | undefined {
    return sessions.value.get(id)
  }

  function setSession(session: DraftSession): void {
    const updated = new Map(sessions.value)
    updated.set(session.note.id, session)
    sessions.value = updated
    isDirty.value = [...updated.values()].some((item) => item.dirty)
    if (selectedNote.value?.id === session.note.id) {
      selectedNote.value = session.note
      saveStatus.value = session.saveStatus
      error.value = session.error
    }
  }

  function removeSession(id: string): void {
    const updated = new Map(sessions.value)
    updated.delete(id)
    sessions.value = updated
    isDirty.value = [...updated.values()].some((item) => item.dirty)
  }

  function sessionFor(note: NoteDetail): DraftSession {
    return { note, saveStatus: 'saved', revision: 0, dirty: false }
  }

  /** 保存循环始终读取所有会话的最新草稿；并发 flush 共享任务。 */
  function flush(): Promise<void> {
    if (saveTask !== undefined) return saveTask
    if (!isDirty.value) return Promise.resolve()
    saveTask = persistDrafts().finally(() => {
      saveTask = undefined
    })
    return saveTask
  }

  async function persistDrafts(): Promise<void> {
    const failedIds = new Set<string>()
    let firstFailure: NoteError | undefined
    do {
      let session = [...sessions.value.values()].find((item) => item.dirty && !failedIds.has(item.note.id))
      while (session !== undefined) {
        const note = session.note
        const requestRevision = session.revision
        const draft = { id: note.id, title: note.title, content: note.content }
        setSession({ ...session, saveStatus: 'saving' })
        try {
          const saved = await saveNote(draft)
          patchSummary(saved.summary)
          const current = sessions.value.get(saved.id)
          if (current !== undefined) {
            const isSaved = current.revision === requestRevision
            setSession({
              ...current,
              note: { ...current.note, updatedAt: saved.updatedAt },
              dirty: !isSaved,
              saveStatus: isSaved ? 'saved' : 'editing',
              error: undefined,
            })
          }
        } catch (failure: unknown) {
          const saveError = toNoteError(failure)
          const current = sessions.value.get(draft.id)
          if (current !== undefined) {
            setSession({ ...current, saveStatus: 'failed', error: saveError })
            // 等待恢复草稿写入后才结束任务，避免迟到恢复写覆盖后续成功保存。
            await saveRecoveryDraft(
              { id: current.note.id, title: current.note.title, content: current.note.content },
              saveError.code,
            ).catch(() => undefined)
          }
          failedIds.add(draft.id)
          firstFailure ??= saveError
        }
        session = [...sessions.value.values()].find((item) => item.dirty && !failedIds.has(item.note.id))
      }
      // 标题排序或搜索条件可能改变页边界；仅重取有界摘要页，不回读正文。
      if (!isLoading.value && (summaryNeedsRefresh || settings.snapshot?.noteSort === 'title' || activeFilter.query))
        await refreshList()
    } while ([...sessions.value.values()].some((item) => item.dirty && !failedIds.has(item.note.id)))
    if (firstFailure !== undefined) throw firstFailure
  }

  function updateDraft(change: Pick<NoteDetail, 'title' | 'content'>, noteId = selectedNote.value?.id): void {
    const session = noteId === undefined ? undefined : sessions.value.get(noteId)
    if (session === undefined) return
    const note = session.note
    if (note.title === change.title && note.content === change.content) return
    revision += 1
    setSession({
      ...session,
      note: { ...note, ...change },
      revision: session.revision + 1,
      dirty: true,
      saveStatus: 'editing',
      error: undefined,
    })
  }

  function commitSelection(note: NoteDetail | undefined, replace = false): void {
    if (note === undefined) {
      selectedNote.value = undefined
      saveStatus.value = 'idle'
      error.value = undefined
      return
    }
    const existing = sessions.value.get(note.id)
    const session = existing === undefined ? sessionFor(note) : replace ? { ...existing, note } : existing
    selectedNote.value = session.note
    setSession(session)
  }

  function activateNote(id: string | undefined): void {
    if (id === undefined) {
      navigationVersion += 1
      commitSelection(undefined)
      return
    }
    const session = sessions.value.get(id)
    if (session === undefined) return
    navigationVersion += 1
    selectedNote.value = session.note
    saveStatus.value = session.saveStatus
    error.value = session.error
  }

  async function readNote(id: string): Promise<NoteDetail> {
    const cleanup = pendingCleanups.get(id)
    if (cleanup !== undefined && (await cleanup)) {
      throw toNoteError({ code: 'NOTE_NOT_FOUND', message: '笔记不存在或已被删除。' })
    }
    const existing = sessions.value.get(id)
    if (existing !== undefined) return existing.note
    const pending = pendingOpens.get(id)
    if (pending !== undefined) return pending
    const task = getNote(id).finally(() => {
      pendingOpens.delete(id)
    })
    pendingOpens.set(id, task)
    return task
  }

  async function openNote(id: string): Promise<void> {
    // 新打开的笔记即将加入布局，不能被上一轮异步释放任务回收。
    retentionVersion += 1
    const note = await readNote(id)
    if (!sessions.value.has(id)) setSession(sessionFor(note))
  }

  async function retainNotes(ids: string[]): Promise<void> {
    const version = ++retentionVersion
    retainedNoteIds = new Set(ids)
    await flush()
    if (version !== retentionVersion) return
    for (const [id, session] of sessions.value) {
      if (retainedNoteIds.has(id)) continue
      if (selectedNote.value?.id === id) commitSelection(undefined)
      removeSession(id)
      await cleanupPrevious(session.note)
      if (version !== retentionVersion) return
    }
  }

  async function cleanupPrevious(previous: NoteDetail | undefined): Promise<void> {
    if (previous === undefined || previous.id === selectedNote.value?.id || retainedNoteIds.has(previous.id)) return
    if (previous.title.trim() !== '' || previous.content.trim() !== '') return
    const existing = pendingCleanups.get(previous.id)
    if (existing !== undefined) {
      await existing
      return
    }
    const task = cleanupEmptyNote(previous.id)
      .then((deleted) => {
        if (deleted) {
          removeSummary(previous.id)
          removeSession(previous.id)
        }
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
    const listNavigation = ++listNavigationVersion
    pageVersion += 1
    try {
      await flush()
    } catch (failure: unknown) {
      if (listNavigation === listNavigationVersion) isLoading.value = false
      throw failure
    }
    if (listNavigation !== listNavigationVersion) return
    const pageRequest = ++pageVersion
    activeFilter = filter
    isLoading.value = true
    isLoadingMore.value = false
    listError.value = undefined
    try {
      const startingRevision = revision
      let page = await listNotePage({ ...filter, limit: PAGE_SIZE })
      // 分栏焦点只取消正文选择；分类列表仍按它自己的请求版本更新。
      if (pageRequest === pageVersion) applyPage(page)
      if (version !== navigationVersion) return
      let id = selectedId ?? page.items[0]?.id
      const cleanup = id === undefined ? undefined : pendingCleanups.get(id)
      if (cleanup !== undefined && (await cleanup)) {
        page = await listNotePage({ ...filter, limit: PAGE_SIZE })
        id = page.items[0]?.id
      }
      const detail =
        id === undefined
          ? undefined
          : await readNote(id).catch((failure: unknown) => {
              if (version !== navigationVersion) return undefined
              throw failure
            })
      await flush()
      // 加载期间的最后一次保存可能改变排序或筛选结果，只重新读取有界摘要页。
      if (startingRevision !== revision && pageRequest === pageVersion)
        page = await listNotePage({ ...filter, limit: PAGE_SIZE })
      await flush()
      // 期间发起的新搜索只替换摘要页，不能取消本次导航的详情选择。
      if (pageRequest === pageVersion) applyPage(page)
      if (version !== navigationVersion) return
      const previous = selectedNote.value
      commitSelection(detail?.id === previous?.id ? previous : detail)
      await cleanupPrevious(previous)
    } catch (failure: unknown) {
      if (listNavigation === listNavigationVersion && pageRequest === pageVersion)
        listError.value = toNoteError(failure)
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
    const detail = await readNote(id)
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
      true,
    )
    await refreshList()
  }

  async function setPinned(pinned: boolean, noteId = selectedNote.value?.id): Promise<void> {
    if (noteId === undefined) return
    await flush()
    const saved = await setNotePinned(noteId, pinned)
    const session = sessions.value.get(saved.id)
    if (session !== undefined)
      setSession({ ...session, note: { ...session.note, isPinned: saved.isPinned, updatedAt: saved.updatedAt } })
    const summary = notes.value.find((item) => item.id === saved.id)
    if (summary !== undefined) patchSummary({ ...summary, isPinned: saved.isPinned, updatedAt: saved.updatedAt })
    // 取消置顶可能把当前项移到已加载页之外，必须复位偏移，防止跨页漏项。
    await refreshList()
  }

  async function reloadAfterTrash(trashedId: string): Promise<void> {
    removeSession(trashedId)
    retainedNoteIds.delete(trashedId)
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
    if (!notes.value.some((note) => note.id === id) && !sessions.value.has(id)) return
    const version = navigationVersion
    await flush()
    const index = notes.value.findIndex((note) => note.id === id)
    await setNoteCategory(id, categoryId)
    const session = sessions.value.get(id)
    if (session !== undefined) setSession({ ...session, note: { ...session.note, categoryId } })
    await refreshList()
    const outsideCategory =
      activeFilter.uncategorized === true
        ? categoryId !== undefined
        : activeFilter.categoryId !== undefined && activeFilter.categoryId !== categoryId
    if (
      index < 0 ||
      version !== navigationVersion ||
      !outsideCategory ||
      selectedNote.value?.id !== id ||
      isDirty.value
    )
      return
    const target = notes.value[Math.min(Math.max(index, 0), notes.value.length - 1)]
    if (target === undefined) commitSelection(undefined)
    else await selectNote(target.id)
  }

  return {
    notes,
    getSession,
    openNote,
    activateNote,
    retainNotes,
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

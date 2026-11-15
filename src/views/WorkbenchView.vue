<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { storeToRefs } from 'pinia'
import { useAutoSave } from '@/composables/useAutoSave'
import { useSearchQuery } from '@/composables/useSearchQuery'
import NoteEditorPane from '@/features/editor/NoteEditorPane.vue'
import NoteWorkspace from '@/features/workspace/NoteWorkspace.vue'
import { collectPanes, removePane, replacePaneNote, splitPane } from '@/features/workspace/splitLayout'
import type { NoteLayoutNode, SplitDirection } from '@/features/workspace/splitLayout'
import ExportDialog from '@/features/export/ExportDialog.vue'
import NoteList from '@/features/notes/NoteList.vue'
import WorkspaceLayout from '@/layouts/WorkspaceLayout.vue'
import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useTagsStore } from '@/stores/tags'
import { toCategoryError } from '@/services/categories'
import { trashNote } from '@/services/trash'
import { UNCATEGORIZED_CATEGORY_ID, type CategoryNode } from '@/types/categories'
import type { NoteDetail } from '@/types/notes'
import type { ExportScopeOption } from '@/types/export'

const notesStore = useNotesStore()
const categoriesStore = useCategoriesStore()
const tagsStore = useTagsStore()
const route = useRoute()
const router = useRouter()
const { isLoading, notes, selectedNote } = storeToRefs(notesStore)
const layout = shallowRef<NoteLayoutNode>({ kind: 'pane', id: 'pane-1' })
const activePaneId = shallowRef('pane-1')
const panes = computed(() => collectPanes(layout.value))
const paneEditors = new Map<string, { focusEditor: () => void }>()
let nextPaneId = 1
let splitVersion = 0
let disposed = false
const listSearchQuery = shallowRef<string>()
const searchQuery = computed(
  () => listSearchQuery.value ?? (typeof route.query.search === 'string' ? route.query.search : ''),
)
const isExportDialogVisible = shallowRef(false)
const isMovingNote = shallowRef(false)
const isTrashingNote = shallowRef(false)
const exportNote = shallowRef<NoteDetail>()
let routeVersion = 0
const exportScopeOptions = computed<ExportScopeOption[]>(() => {
  const note = exportNote.value
  if (note === undefined) {
    return []
  }
  return [
    {
      scope: { kind: 'note', id: note.id },
      title: t('当前笔记'),
      description: t('导出当前笔记及其引用的图片和附件。'),
    },
    {
      scope: { kind: 'category', id: note.categoryId ?? UNCATEGORIZED_CATEGORY_ID },
      title: t('当前分类'),
      description: t('导出当前笔记所属分类的全部直属笔记，不含子分类。'),
    },
  ]
})
const activeCategoryName = computed(() => {
  const categoryId = typeof route.query.category === 'string' ? route.query.category : undefined
  if (categoryId === undefined) {
    return undefined
  }
  if (categoryId === UNCATEGORIZED_CATEGORY_ID) {
    return t('未分类')
  }
  return findCategoryName(categoriesStore.categories, categoryId)
})
const activeCategoryId = computed(() => {
  const categoryId = typeof route.query.category === 'string' ? route.query.category : undefined
  return categoryId === UNCATEGORIZED_CATEGORY_ID ? undefined : categoryId
})

function findCategoryName(categories: CategoryNode[], categoryId: string): string | undefined {
  for (const category of categories) {
    if (category.id === categoryId) {
      return category.name
    }
    const childName = findCategoryName(category.children, categoryId)
    if (childName !== undefined) {
      return childName
    }
  }
  return undefined
}

const autoSave = useAutoSave(async () => {
  await notesStore.flush()
})
const listSearch = useSearchQuery(async (query) => notesStore.refreshList(query))
const removeNavigationGuard = router.beforeEach(async (_to, from) => {
  if (from.name !== 'workbench') return true
  if (isTrashingNote.value) return false
  try {
    await autoSave.flush()
    return true
  } catch {
    return false
  }
})

function handleListSearch(query: string): void {
  listSearchQuery.value = query
  listSearch.cancel()
  if (query.trim() === '') void notesStore.refreshList('')
  else listSearch.schedule(query)
}

// 只替换活动分栏，其他已打开的笔记继续保留。
watch(
  () => selectedNote.value?.id,
  (id) => {
    if (panes.value.find((pane) => pane.id === activePaneId.value)?.noteId === id) return
    layout.value = replacePaneNote(layout.value, activePaneId.value, id)
  },
  { immediate: true, flush: 'sync' },
)
watch(
  () => [...new Set(panes.value.flatMap((pane) => (pane.noteId === undefined ? [] : [pane.noteId])))].sort(),
  (ids, previous) => {
    if (previous !== undefined && ids.length === previous.length && ids.every((id, index) => id === previous[index]))
      return
    void notesStore.retainNotes(ids).catch(() => undefined)
  },
  { immediate: true, flush: 'sync' },
)

function activatePane(paneId: string): void {
  if (isTrashingNote.value || activePaneId.value === paneId) return
  const pane = panes.value.find((item) => item.id === paneId)
  if (pane === undefined) return
  activePaneId.value = paneId
  notesStore.activateNote(pane.noteId)
}

function inPane(paneId: string, action: () => Promise<void>): void {
  activatePane(paneId)
  void action()
}

function setPaneEditor(paneId: string, editor: Element | ComponentPublicInstance | null): void {
  if (editor !== null && 'focusEditor' in editor && typeof editor.focusEditor === 'function') {
    const focus = editor.focusEditor
    paneEditors.set(paneId, { focusEditor: () => focus() })
  } else {
    paneEditors.delete(paneId)
  }
}

async function handleSplit(id: string, direction: SplitDirection): Promise<void> {
  if (isTrashingNote.value) return
  const targetPaneId = activePaneId.value
  const version = ++splitVersion
  try {
    await autoSave.flush()
    await notesStore.openNote(id)
    if (version !== splitVersion || isTrashingNote.value || !panes.value.some((pane) => pane.id === targetPaneId))
      return
    const paneId = `pane-${++nextPaneId}`
    layout.value = splitPane(
      layout.value,
      targetPaneId,
      { kind: 'pane', id: paneId, noteId: id },
      direction,
      `split-${nextPaneId}`,
    )
    activatePane(paneId)
    await nextTick()
    paneEditors.get(paneId)?.focusEditor()
  } catch {
    ElMessage.error(t('无法打开笔记。'))
  } finally {
    if (!disposed) {
      await notesStore
        .retainNotes(panes.value.flatMap((pane) => (pane.noteId === undefined ? [] : [pane.noteId])))
        .catch(() => undefined)
    }
  }
}

async function handleClosePane(paneId: string): Promise<void> {
  if (isTrashingNote.value || panes.value.length === 1) return
  try {
    await autoSave.flush()
    const index = panes.value.findIndex((pane) => pane.id === paneId)
    if (index < 0 || panes.value.length === 1) return
    const remaining = panes.value.filter((pane) => pane.id !== paneId)
    const next = remaining[Math.min(index, remaining.length - 1)]
    if (activePaneId.value === paneId && next !== undefined) activatePane(next.id)
    layout.value = removePane(layout.value, paneId)
    paneEditors.delete(paneId)
    await notesStore.retainNotes(panes.value.flatMap((pane) => (pane.noteId === undefined ? [] : [pane.noteId])))
    await nextTick()
    paneEditors.get(activePaneId.value)?.focusEditor()
  } catch {
    // 保存状态保留在原分栏，允许重试；保存成功后才能关闭。
  }
}

watch(
  () => [route.query.category, route.query.tags, route.query.note, route.query.create] as const,
  async ([category, tags, note, create], previous) => {
    const version = ++routeVersion
    splitVersion += 1
    if (create === '1') {
      try {
        await autoSave.flush()
        if (version !== routeVersion) return
      } catch {
        return
      }
    }
    if (previous === undefined || category !== previous[0] || tags !== previous[1] || note !== previous[2]) {
      listSearch.cancel()
      listSearchQuery.value = undefined
      await loadNotesForRoute(category, tags, typeof note === 'string' ? note : undefined)
      if (version !== routeVersion) return
    }
    if (create === '1' && (await handleCreate())) {
      const query = { ...route.query }
      delete query.create
      await router.replace({ name: 'workbench', query })
    }
  },
  { immediate: true },
)

function updateNote(paneId: string, change: Pick<NoteDetail, 'title' | 'content'>): void {
  if (isTrashingNote.value) return
  const pane = panes.value.find((item) => item.id === paneId)
  if (pane?.noteId === undefined) return
  activatePane(paneId)
  notesStore.updateDraft(change, pane.noteId)
  autoSave.schedule()
}

async function handleCreate(categoryId?: string): Promise<boolean> {
  if (isTrashingNote.value) return false
  const targetPaneId = activePaneId.value
  try {
    await autoSave.flush()
    if (isTrashingNote.value || activePaneId.value !== targetPaneId) return false
    if (categoryId !== undefined) {
      await router.push({ name: 'workbench', query: { category: categoryId, create: '1' } })
      return true
    }
    await notesStore.create(activeCategoryId.value)
    await categoriesStore.load()
    return true
  } catch {
    return false
  }
}

async function handleLoad(): Promise<void> {
  await loadNotesForRoute(route.query.category, route.query.tags)
  await Promise.all([categoriesStore.load(), tagsStore.load()])
}

async function loadNotesForRoute(category: unknown, tags: unknown, selectedId?: string): Promise<void> {
  const categoryId = typeof category === 'string' ? category : undefined
  const tagIds = typeof tags === 'string' ? tags.split(',').filter(Boolean) : []
  if (categoryId !== undefined) {
    await notesStore.loadByCategory(categoryId === UNCATEGORIZED_CATEGORY_ID ? undefined : categoryId, selectedId)
    return
  }
  if (tagIds.length > 0) {
    await notesStore.loadByTags(tagIds, selectedId)
    return
  }
  await notesStore.load(selectedId)
}

async function handleTrash(): Promise<void> {
  if (isTrashingNote.value) return
  splitVersion += 1
  const note = selectedNote.value
  if (note === undefined) {
    return
  }
  const shouldTrash = await ElMessageBox.confirm(t('笔记将移入回收站，之后可恢复。是否继续？'), t('确认删除笔记'), {
    confirmButtonText: t('移入回收站'),
    cancelButtonText: t('取消'),
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false)
  if (!shouldTrash) {
    return
  }
  isTrashingNote.value = true
  try {
    await autoSave.flush()
    await trashNote(note.id)
    ElMessage.success(t('笔记已移入回收站。'))
    await notesStore.reloadAfterTrash(note.id)
    const replacementId = selectedNote.value?.id
    for (const pane of panes.value) {
      if (pane.noteId === note.id) layout.value = replacePaneNote(layout.value, pane.id, replacementId)
    }
    await categoriesStore.load()
  } catch {
    ElMessage.error(localizeMessage(notesStore.error?.message ?? t('无法读取笔记')))
  } finally {
    isTrashingNote.value = false
  }
}

async function handleExport(): Promise<void> {
  const noteId = selectedNote.value?.id
  if (noteId === undefined) return
  try {
    await autoSave.flush()
    const note = notesStore.getSession(noteId)?.note
    if (note !== undefined) {
      exportNote.value = note
      isExportDialogVisible.value = true
    }
  } catch {
    ElMessage.error(t('当前笔记保存失败，暂不能导出。'))
  }
}

async function handleUpdateCategory(categoryId: string | undefined): Promise<void> {
  const note = selectedNote.value
  if (note === undefined) return
  await handleMoveNote(note.id, categoryId)
}

async function handleMoveNote(noteId: string, categoryId: string | undefined): Promise<void> {
  if (
    isMovingNote.value ||
    (!notes.value.some((note) => note.id === noteId) && notesStore.getSession(noteId) === undefined)
  )
    return
  isMovingNote.value = true
  try {
    await autoSave.flush()
    await notesStore.moveToCategory(noteId, categoryId)
    await categoriesStore.load()
    const categoryName =
      categoryId === undefined
        ? t('未分类')
        : (findCategoryName(categoriesStore.categories, categoryId) ?? t('目标分类'))
    ElMessage.success(t('笔记已移至“{value1}”。', { value1: categoryName }))
  } catch (failure: unknown) {
    ElMessage.error(localizeMessage(notesStore.error?.message ?? toCategoryError(failure).message))
  } finally {
    isMovingNote.value = false
  }
}

async function handleSelect(id: string): Promise<void> {
  if (isTrashingNote.value) return
  const targetPaneId = activePaneId.value
  try {
    await autoSave.flush()
    if (isTrashingNote.value || activePaneId.value !== targetPaneId) return
    await notesStore.selectNote(id)
  } catch {
    return
  }
}

function handleKeyboardShortcut(event: KeyboardEvent): void {
  if (isTrashingNote.value) return
  if (!event.metaKey && !event.ctrlKey) {
    return
  }
  if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    void handleCreate()
  }
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    void router.push({ name: 'search' })
  }
  if (event.key.toLowerCase() === 'e') {
    event.preventDefault()
    paneEditors.get(activePaneId.value)?.focusEditor()
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    void autoSave.flush().catch(() => undefined)
  }
  if (event.key === 'Backspace' && event.shiftKey) {
    event.preventDefault()
    void handleTrash()
  }
}

async function handleTogglePin(): Promise<void> {
  const note = selectedNote.value
  if (note === undefined) return
  try {
    await notesStore.setPinned(!note.isPinned, note.id)
    ElMessage.success(note.isPinned ? t('已取消置顶。') : t('笔记已置顶。'))
  } catch {
    ElMessage.error(t('无法更新置顶状态。'))
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeyboardShortcut)
  await Promise.all([categoriesStore.load(), tagsStore.load()])
})

onBeforeUnmount(() => {
  disposed = true
  splitVersion += 1
  removeNavigationGuard()
  window.removeEventListener('keydown', handleKeyboardShortcut)
})
</script>

<template>
  <WorkspaceLayout
    :categories="categoriesStore.categories"
    :tag-count="tagsStore.tags.length"
    :note-drop-enabled="!isMovingNote && !isTrashingNote"
    @create="handleCreate"
    @move-note="handleMoveNote"
  >
    <template #list>
      <NoteList
        :inert="isTrashingNote"
        :key="`${route.query.category ?? ''}:${route.query.tags ?? ''}`"
        :notes="notes"
        :category-name="activeCategoryName"
        :selected-id="selectedNote?.id"
        :search-query="searchQuery"
        :loading="isLoading"
        :error="notesStore.listError?.message"
        :total="notesStore.total"
        :has-more="notesStore.nextOffset !== null"
        :loading-more="notesStore.isLoadingMore"
        remote-search
        @create="handleCreate"
        @retry="handleLoad"
        @select="handleSelect"
        @split="handleSplit"
        @search="handleListSearch"
        @load-more="notesStore.loadNext"
      />
    </template>

    <template #editor>
      <NoteWorkspace :node="layout" :active-pane-id="activePaneId" @activate="activatePane">
        <template #default="{ pane, active }">
          <NoteEditorPane
            :ref="(editor) => setPaneEditor(pane.id, editor)"
            :note="pane.noteId === undefined ? undefined : notesStore.getSession(pane.noteId)?.note"
            :active="active"
            :multiple="panes.length > 1"
            :busy="isTrashingNote"
            :save-status="
              pane.noteId === undefined ? 'idle' : (notesStore.getSession(pane.noteId)?.saveStatus ?? 'idle')
            "
            :save-error="pane.noteId === undefined ? undefined : notesStore.getSession(pane.noteId)?.error?.message"
            :categories="categoriesStore.categories"
            :search-query="searchQuery"
            @update="updateNote(pane.id, $event)"
            @update-category="inPane(pane.id, () => handleUpdateCategory($event))"
            @export="inPane(pane.id, handleExport)"
            @trash="inPane(pane.id, handleTrash)"
            @toggle-pin="inPane(pane.id, handleTogglePin)"
            @retry="autoSave.flush().catch(() => undefined)"
            @close="handleClosePane(pane.id)"
          />
        </template>
      </NoteWorkspace>
    </template>
  </WorkspaceLayout>
  <ExportDialog v-model="isExportDialogVisible" :scope-options="exportScopeOptions" />
</template>

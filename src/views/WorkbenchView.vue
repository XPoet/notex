<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { storeToRefs } from 'pinia'
import { getNoteAssetHealth, savePastedImage, toAssetError } from '@/services/assets'
import { useAutoSave } from '@/composables/useAutoSave'
import NoteEditor from '@/features/editor/NoteEditor.vue'
import ExportDialog from '@/features/export/ExportDialog.vue'
import NoteList from '@/features/notes/NoteList.vue'
import WorkspaceLayout from '@/layouts/WorkspaceLayout.vue'
import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useTagsStore } from '@/stores/tags'
import { createTag, listNoteTags, setNoteTags } from '@/services/tags'
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
const { error, isLoading, notes, saveStatus, selectedNote } = storeToRefs(notesStore)
const missingAssetCount = shallowRef(0)
const selectedTagIds = shallowRef<string[]>([])
const listSearchQuery = shallowRef<string>()
const searchQuery = computed(
  () => listSearchQuery.value ?? (typeof route.query.search === 'string' ? route.query.search : ''),
)
const imageError = shallowRef<string>()
const isExportDialogVisible = shallowRef(false)
const isMovingNote = shallowRef(false)
const noteEditor = useTemplateRef<{ focusEditor: () => void }>('noteEditor')
const exportScopeOptions = computed<ExportScopeOption[]>(() => {
  const note = selectedNote.value
  if (note === undefined) {
    return []
  }
  return [
    {
      scope: { kind: 'note', id: note.id },
      title: t('当前笔记'),
      description: t('导出当前笔记及其关联的原格式图片。'),
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

async function refreshAssetHealth(noteId: string | undefined): Promise<void> {
  if (noteId === undefined) {
    missingAssetCount.value = 0
    return
  }
  try {
    missingAssetCount.value = (await getNoteAssetHealth(noteId)).missingAssetCount
  } catch {
    missingAssetCount.value = 0
  }
}

watch(
  () => selectedNote.value?.id,
  (noteId) => {
    void refreshAssetHealth(noteId)
  },
  { immediate: true },
)

watch(
  () => [route.query.category, route.query.tags, route.query.note, route.query.create] as const,
  async ([category, tags, note, create], previous) => {
    if (create === '1') {
      try {
        await autoSave.flush()
      } catch {
        return
      }
    }
    if (previous === undefined || category !== previous[0] || tags !== previous[1] || note !== previous[2]) {
      await loadNotesForRoute(category, tags)
      if (typeof note === 'string' && notes.value.some((item) => item.id === note)) {
        await notesStore.selectNote(note)
      }
    }
    if (create === '1' && (await handleCreate())) {
      const query = { ...route.query }
      delete query.create
      await router.replace({ name: 'workbench', query })
    }
  },
  { immediate: true },
)

watch(
  () => selectedNote.value?.id,
  async (noteId) => {
    selectedTagIds.value = []
    if (noteId === undefined) {
      return
    }
    try {
      const tags = await listNoteTags(noteId)
      if (selectedNote.value?.id === noteId) {
        selectedTagIds.value = tags.map((tag) => tag.id)
      }
    } catch {
      if (selectedNote.value?.id === noteId) {
        selectedTagIds.value = []
      }
    }
  },
  { immediate: true },
)

function updateNote(change: Pick<NoteDetail, 'title' | 'content'>): void {
  notesStore.updateDraft(change)
  autoSave.schedule()
}

async function saveImage(bytes: Uint8Array): Promise<string> {
  const note = selectedNote.value
  if (note === undefined) {
    throw new Error(t('请先新建或选择一条笔记。'))
  }
  try {
    const asset = await savePastedImage(note.id, bytes)
    imageError.value = undefined
    await refreshAssetHealth(note.id)
    return t('![图片](./{value1})', { value1: asset.relativePath })
  } catch (failure: unknown) {
    const assetError = toAssetError(failure)
    imageError.value = assetError.message
    throw new Error(assetError.message)
  }
}

async function handleCreate(categoryId?: string): Promise<boolean> {
  try {
    await autoSave.flush()
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

async function loadNotesForRoute(category: unknown, tags: unknown): Promise<void> {
  const categoryId = typeof category === 'string' ? category : undefined
  const tagIds = typeof tags === 'string' ? tags.split(',').filter(Boolean) : []
  if (categoryId !== undefined) {
    await notesStore.loadByCategory(categoryId === UNCATEGORIZED_CATEGORY_ID ? undefined : categoryId)
    return
  }
  if (tagIds.length > 0) {
    await notesStore.loadByTags(tagIds)
    return
  }
  await notesStore.load()
}

async function handleTrash(): Promise<void> {
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
  await autoSave.flush()
  await trashNote(note.id)
  ElMessage.success(t('笔记已移入回收站。'))
  await notesStore.reloadAfterTrash(note.id)
  await categoriesStore.load()
}

async function handleExport(): Promise<void> {
  try {
    await autoSave.flush()
    if (selectedNote.value !== undefined) {
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
  if (isMovingNote.value || !notes.value.some((note) => note.id === noteId)) return
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

async function handleUpdateTags(tagIds: string[]): Promise<void> {
  const note = selectedNote.value
  if (note === undefined) return
  await autoSave.flush()
  await setNoteTags(note.id, tagIds)
  selectedTagIds.value = tagIds
  await tagsStore.load()
}

async function handleCreateTag(name: string): Promise<void> {
  const tag = await createTag(name)
  await tagsStore.load()
  if (!selectedTagIds.value.includes(tag.id)) {
    await handleUpdateTags([...selectedTagIds.value, tag.id])
  }
}

async function handleSelect(id: string): Promise<void> {
  try {
    await autoSave.flush()
    await notesStore.selectNote(id)
  } catch {
    return
  }
}

function handleKeyboardShortcut(event: KeyboardEvent): void {
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
    noteEditor.value?.focusEditor()
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
    await notesStore.setPinned(!note.isPinned)
    ElMessage.success(note.isPinned ? t('已取消置顶。') : t('笔记已置顶。'))
  } catch {
    ElMessage.error(t('无法更新置顶状态。'))
  }
}

onMounted(async () => {
  await Promise.all([categoriesStore.load(), tagsStore.load()])
  window.addEventListener('keydown', handleKeyboardShortcut)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyboardShortcut)
})
</script>

<template>
  <WorkspaceLayout
    :categories="categoriesStore.categories"
    :tag-count="tagsStore.tags.length"
    :note-drop-enabled="!isMovingNote"
    @create="handleCreate"
    @move-note="handleMoveNote"
  >
    <template #list>
      <NoteList
        :notes="notes"
        :category-name="activeCategoryName"
        :selected-id="selectedNote?.id"
        :search-query="searchQuery"
        :loading="isLoading"
        :error="error?.message"
        @create="handleCreate"
        @retry="handleLoad"
        @select="handleSelect"
        @search="listSearchQuery = $event"
      />
    </template>

    <template #editor>
      <NoteEditor
        ref="noteEditor"
        :note="selectedNote"
        :save-status="saveStatus"
        :save-error="error?.message"
        :missing-asset-count="missingAssetCount"
        :save-image="saveImage"
        :categories="categoriesStore.categories"
        :tags="tagsStore.tags"
        :selected-tag-ids="selectedTagIds"
        :search-query="searchQuery"
        @update="updateNote"
        @update-category="handleUpdateCategory"
        @update-tags="handleUpdateTags"
        @create-tag="handleCreateTag"
        @export="handleExport"
        @trash="handleTrash"
        @toggle-pin="handleTogglePin"
        @retry="autoSave.flush().catch(() => undefined)"
        @paste-error="imageError = $event"
      />
      <p v-if="imageError" class="image-error" role="alert">{{ localizeMessage(imageError) }}</p>
    </template>
  </WorkspaceLayout>
  <ExportDialog v-model="isExportDialogVisible" :scope-options="exportScopeOptions" />
</template>

<style scoped lang="scss">
.image-error {
  margin: 0;
  padding: var(--space-8) var(--space-16);
  border-block-start: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}
</style>

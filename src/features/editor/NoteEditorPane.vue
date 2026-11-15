<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { t, localizeMessage } from '@/i18n'
import { useNoteAttachments } from '@/composables/useNoteAttachments'
import { assetMarkdown } from './assetReferences'
import NoteEditor from './NoteEditor.vue'
import { getNoteAssetHealth, savePastedImage, toAssetError } from '@/services/assets'
import { createTag, listNoteTags, setNoteTags, toTagError } from '@/services/tags'
import { useNotesStore } from '@/stores/notes'
import { useTagsStore } from '@/stores/tags'
import type { SaveStatus } from '@/stores/notes'
import type { NoteDetail } from '@/types/notes'
import type { CategoryNode } from '@/types/categories'

const props = defineProps<{
  note?: NoteDetail
  active: boolean
  multiple: boolean
  saveStatus: SaveStatus
  saveError?: string
  categories: CategoryNode[]
  searchQuery?: string
  busy: boolean
}>()
const emit = defineEmits<{
  update: [change: Pick<NoteDetail, 'title' | 'content'>]
  updateCategory: [categoryId: string | undefined]
  export: []
  retry: []
  close: []
}>()
const notesStore = useNotesStore()
const tagsStore = useTagsStore()
const noteEditor = useTemplateRef<{ focusEditor: () => void }>('noteEditor')
const missingAssetCount = shallowRef(0)
const imageError = shallowRef<string>()
const selectedTagIds = shallowRef<string[]>([])
let tagLoadVersion = 0
const noteId = computed(() => props.note?.id)
const noteAttachments = useNoteAttachments(
  () => noteId.value,
  (message) => {
    imageError.value = message
  },
)

async function refreshAssetHealth(id: string | undefined): Promise<void> {
  if (id === undefined) {
    missingAssetCount.value = 0
    return
  }
  try {
    const health = await getNoteAssetHealth(id)
    if (noteId.value === id) missingAssetCount.value = health.missingAssetCount
  } catch {
    if (noteId.value === id) missingAssetCount.value = 0
  }
}

watch([noteId, () => noteAttachments.revision.value], ([id]) => void refreshAssetHealth(id), { immediate: true })
watch(
  [noteId, () => tagsStore.tags],
  async ([id], previous) => {
    const version = ++tagLoadVersion
    if (previous?.[0] !== id) {
      imageError.value = undefined
      selectedTagIds.value = []
    }
    if (id === undefined) return
    try {
      const tags = await listNoteTags(id)
      if (noteId.value === id && version === tagLoadVersion) selectedTagIds.value = tags.map((tag) => tag.id)
    } catch {
      if (noteId.value === id && version === tagLoadVersion && previous?.[0] !== id) selectedTagIds.value = []
    }
  },
  { immediate: true },
)

async function saveImage(bytes: Uint8Array): Promise<string> {
  const id = noteId.value
  if (id === undefined) throw new Error(t('请先新建或选择一条笔记。'))
  try {
    const asset = await savePastedImage(id, bytes)
    if (noteId.value === id) imageError.value = undefined
    await refreshAssetHealth(id)
    return assetMarkdown(asset)
  } catch (failure: unknown) {
    const assetError = toAssetError(failure)
    if (noteId.value === id) imageError.value = assetError.message
    throw new Error(assetError.message)
  }
}

async function handleUpdateTags(tagIds: string[]): Promise<void> {
  const id = noteId.value
  if (id === undefined) return
  try {
    await notesStore.flush()
    await setNoteTags(id, tagIds)
    tagLoadVersion += 1
    if (noteId.value === id) selectedTagIds.value = tagIds
    await tagsStore.load()
    await notesStore.refreshList()
  } catch (failure: unknown) {
    ElMessage.error(localizeMessage(notesStore.error?.message ?? toTagError(failure).message))
  }
}

async function handleCreateTag(name: string): Promise<void> {
  const id = noteId.value
  if (id === undefined) return
  try {
    const tag = await createTag(name)
    await tagsStore.load()
    const currentTags = await listNoteTags(id)
    if (noteId.value === id && !currentTags.some((item) => item.id === tag.id)) {
      await handleUpdateTags([...currentTags.map((item) => item.id), tag.id])
    }
  } catch (failure: unknown) {
    ElMessage.error(localizeMessage(toTagError(failure).message))
  }
}

defineExpose({ focusEditor: () => noteEditor.value?.focusEditor() })
</script>

<template>
  <section
    class="note-editor-pane"
    :class="{ 'note-editor-pane--active': active && multiple }"
    :inert="busy"
    :aria-label="multiple ? t('笔记分栏') : undefined"
  >
    <header v-if="multiple" class="note-pane-header">
      <span class="note-pane-title" :title="note?.title || t('无标题笔记')">
        <span v-if="active" class="note-pane-active-indicator" :aria-label="t('当前分栏')"></span>
        {{ note?.title || t('无标题笔记') }}
      </span>
      <button
        class="note-pane-close"
        type="button"
        :title="t('关闭分栏')"
        :aria-label="t('关闭分栏')"
        @click="emit('close')"
      >
        <el-icon aria-hidden="true"><Close /></el-icon>
      </button>
    </header>
    <NoteEditor
      ref="noteEditor"
      :note="note"
      :save-status="saveStatus"
      :save-error="saveError"
      :missing-asset-count="missingAssetCount"
      :save-image="saveImage"
      :attachments="noteAttachments.handlers"
      :assets="noteAttachments.assets.value"
      :asset-revision="noteAttachments.revision.value"
      :categories="categories"
      :tags="tagsStore.tags"
      :selected-tag-ids="selectedTagIds"
      :search-query="searchQuery"
      @update="emit('update', $event)"
      @update-category="emit('updateCategory', $event)"
      @update-tags="handleUpdateTags"
      @create-tag="handleCreateTag"
      @export="emit('export')"
      @retry="emit('retry')"
      @paste-error="imageError = $event"
    />
    <p v-if="imageError" class="image-error" role="alert">{{ localizeMessage(imageError) }}</p>
  </section>
</template>

<style scoped lang="scss">
.note-editor-pane {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
  min-block-size: 0;
  block-size: 100%;
  overflow: hidden;
}

.note-editor-pane > .note-editor,
.note-editor-pane > .editor-empty-state {
  flex: 1 1 0;
  min-block-size: 0;
}

.note-pane-header {
  display: flex;
  flex: 0 0 34px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-8);
  padding-inline: var(--space-12) var(--space-8);
  border-block-end: 1px solid var(--color-divider);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.note-editor-pane--active > .note-pane-header {
  border-block-end-color: var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-text-primary);
}

.note-pane-title {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-pane-active-indicator {
  display: inline-block;
  inline-size: 6px;
  block-size: 6px;
  margin-inline-end: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}

.note-pane-close {
  display: grid;
  flex: 0 0 24px;
  block-size: 24px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.note-pane-close:hover {
  background: var(--color-accent-soft);
  color: var(--color-text-primary);
}

.note-pane-close:focus-visible {
  outline: 2px solid var(--color-accent);
}

.image-error {
  flex: 0 0 auto;
  margin: 0;
  padding: var(--space-8) var(--space-16);
  border-block-start: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}
</style>

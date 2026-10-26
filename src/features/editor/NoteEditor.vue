<script setup lang="ts">
import {
  Calendar,
  Clock,
  Delete,
  Download,
  Folder,
  MoreFilled,
  Star,
  StarFilled,
} from '@element-plus/icons-vue'
import { computed, useTemplateRef, watch } from 'vue'
import EditorStatusBar from './EditorStatusBar.vue'
import MarkdownEditor from './MarkdownEditor.vue'
import MissingAssetNotice from './MissingAssetNotice.vue'
import NoteMetadata from './NoteMetadata.vue'
import type { CategoryNode } from '@/types/categories'
import type { SaveStatus as SaveStatusType } from '@/stores/notes'
import type { NoteDetail } from '@/types/notes'
import type { TagSummary } from '@/types/tags'

const props = defineProps<{
  note?: NoteDetail
  saveStatus: SaveStatusType
  saveError?: string
  missingAssetCount: number
  saveImage: (bytes: Uint8Array) => Promise<string>
  categories: CategoryNode[]
  tags: TagSummary[]
  selectedTagIds: string[]
  searchQuery?: string
}>()

const emit = defineEmits<{
  update: [change: Pick<NoteDetail, 'title' | 'content'>]
  retry: []
  pasteError: [message: string]
  updateCategory: [categoryId: string | undefined]
  updateTags: [tagIds: string[]]
  createTag: [name: string]
  export: []
  trash: []
  togglePin: []
}>()

const titleInput = useTemplateRef<{ focus: () => void }>('titleInput')
const markdownEditor = useTemplateRef<{ focus: () => void }>('markdownEditor')
const noteId = computed(() => props.note?.id)
const noteCategoryPath = computed(
  () => findCategoryPath(props.categories, props.note?.categoryId) ?? '未分类',
)
const noteTags = computed(() => props.tags.filter((tag) => props.selectedTagIds.includes(tag.id)))
const timestampFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const createdLabel = computed(() =>
  props.note === undefined ? '' : timestampFormatter.format(new Date(props.note.createdAt)),
)
const updatedLabel = computed(() =>
  props.note === undefined ? '' : timestampFormatter.format(new Date(props.note.updatedAt)),
)

watch(noteId, () => {
  requestAnimationFrame(() => titleInput.value?.focus())
})

function updateTitle(title: string): void {
  const note = props.note
  if (note !== undefined) {
    emit('update', { title, content: note.content })
  }
}

function updateContent(content: string): void {
  const note = props.note
  if (note !== undefined) {
    emit('update', { title: note.title, content })
  }
}

function findCategoryPath(categories: CategoryNode[], categoryId?: string): string | undefined {
  if (categoryId === undefined) return undefined

  for (const category of categories) {
    if (category.id === categoryId) return category.path

    const childPath = findCategoryPath(category.children, categoryId)
    if (childPath !== undefined) return childPath
  }

  return undefined
}

function focusEditor(): void {
  markdownEditor.value?.focus()
}

defineExpose({ focusEditor })
</script>

<template>
  <section v-if="note !== undefined" class="note-editor">
    <div class="note-editor-content">
      <header class="note-editor-heading">
        <el-input
          ref="titleInput"
          class="note-title-input"
          :model-value="note.title"
          placeholder="无标题笔记"
          aria-label="笔记标题"
          @update:model-value="updateTitle"
        />
        <div class="note-editor-toolbar">
          <div class="note-editor-classification">
            <p class="note-editor-location" :title="noteCategoryPath">
              <el-icon aria-hidden="true"><Folder /></el-icon>
              <span>{{ noteCategoryPath }}</span>
            </p>
            <div v-if="noteTags.length > 0" class="note-editor-tags" aria-label="笔记标签">
              <span v-for="tag in noteTags" :key="tag.id" class="note-editor-tag" :title="tag.name">
                #{{ tag.name }}
              </span>
            </div>
          </div>
          <p class="note-editor-time note-editor-created">
            <el-icon aria-hidden="true"><Calendar /></el-icon>
            <span>创建于</span>
            <time :datetime="note.createdAt">{{ createdLabel }}</time>
          </p>
          <p class="note-editor-time note-editor-updated">
            <el-icon aria-hidden="true"><Clock /></el-icon>
            <span>更新于</span>
            <time :datetime="note.updatedAt">{{ updatedLabel }}</time>
          </p>
          <div class="note-editor-actions">
            <el-button
              text
              circle
              :icon="note.isPinned ? StarFilled : Star"
              :title="note.isPinned ? '取消置顶' : '置顶笔记'"
              :aria-label="note.isPinned ? '取消置顶' : '置顶笔记'"
              :aria-pressed="note.isPinned"
              @click="emit('togglePin')"
            />
            <el-button
              text
              circle
              :icon="Download"
              title="导出笔记"
              aria-label="导出笔记"
              @click="emit('export')"
            />
            <el-button
              text
              type="danger"
              circle
              :icon="Delete"
              title="移入回收站"
              aria-label="移入回收站"
              @click="emit('trash')"
            />
            <el-popover placement="bottom-end" :width="360" trigger="click">
              <template #reference>
                <el-button
                  text
                  circle
                  :icon="MoreFilled"
                  title="分类与标签"
                  aria-label="分类与标签"
                />
              </template>
              <NoteMetadata
                :categories="categories"
                :category-id="note.categoryId"
                :tags="tags"
                :selected-tag-ids="selectedTagIds"
                @create-tag="emit('createTag', $event)"
                @update-category="emit('updateCategory', $event)"
                @update-tags="emit('updateTags', $event)"
              />
            </el-popover>
          </div>
        </div>
      </header>
      <MissingAssetNotice v-if="missingAssetCount" :missing-asset-count="missingAssetCount" />
      <div class="note-editor-body">
        <MarkdownEditor
          ref="markdownEditor"
          :key="note.id"
          :note-id="note.id"
          class="note-editor-markdown"
          :model-value="note.content"
          :save-image="saveImage"
          :search-query="searchQuery"
          @update:model-value="updateContent"
          @paste-error="emit('pasteError', $event)"
        />
      </div>
    </div>
    <EditorStatusBar
      :content="note.content"
      :save-status="saveStatus"
      :save-error="saveError"
      @retry="emit('retry')"
    />
  </section>
  <section v-else class="editor-empty-state">
    <h1 class="editor-empty-title">打开即记</h1>
    <p class="editor-empty-copy">从左侧新建一条笔记，纯文本和图片都会保存在本机。</p>
  </section>
</template>

<style scoped lang="scss">
.note-editor {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 34px;
  min-inline-size: 0;
  min-block-size: 0;
  block-size: 100%;
}

.note-editor-classification {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  min-inline-size: 0;
  max-inline-size: min(100%, 480px);
}

.note-editor-location {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  gap: 6px;
  min-inline-size: 0;
  max-inline-size: 240px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.6875rem;
}

.note-editor-location .el-icon {
  flex: 0 0 auto;
  color: var(--color-accent);
  font-size: 0.875rem;
}

.note-editor-location span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-editor-tags {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-inline-size: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.note-editor-tag {
  flex: 0 0 auto;
  max-inline-size: 180px;
  overflow: hidden;
  color: color-mix(in srgb, var(--color-accent) 70%, var(--color-text-primary));
  font-size: 0.6875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-editor-heading {
  display: grid;
  gap: var(--space-16);
  min-inline-size: 0;
  padding-block-end: var(--space-16);
  border-block-end: 1px solid var(--color-divider);
}

.note-editor-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-8) var(--space-16);
  min-inline-size: 0;
}

.note-editor-time {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.6875rem;
  line-height: 1.5;
  white-space: nowrap;
}

.note-editor-time .el-icon,
.note-editor-time > span {
  color: var(--color-text-muted);
}

.note-editor-time time {
  font-variant-numeric: tabular-nums;
}

.note-title-input {
  inline-size: 100%;
  min-inline-size: 0;
}

.note-title-input :deep(.el-input__wrapper) {
  min-block-size: 40px;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.note-title-input :deep(.el-input__inner) {
  min-inline-size: 0;
  block-size: auto;
  color: var(--color-text-primary);
  caret-color: var(--color-accent);
  font-size: 1.875rem;
  font-weight: 600;
  line-height: 1.25;
}

.note-editor-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--space-4);
  margin-inline-start: auto;
  padding-inline-start: var(--space-12);
  border-inline-start: 1px solid var(--color-divider);
}

.note-editor-body {
  display: grid;
  grid-row: 3;
  grid-template-rows: minmax(0, 1fr);
  min-block-size: 0;
  overflow: hidden;
}

.note-editor-markdown {
  min-inline-size: 0;
  min-block-size: 0;
}

.note-editor-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr);
  min-inline-size: 0;
  min-block-size: 0;
  gap: 0;
  padding: var(--space-24) var(--space-32) 0;
  overflow: hidden;
  background: var(--color-canvas);
}

@media (max-width: 900px) {
  .note-editor-content {
    padding-inline: var(--space-16);
  }

  .note-title-input :deep(.el-input__inner) {
    font-size: 1.625rem;
  }
}

.editor-empty-state {
  display: grid;
  align-content: center;
  justify-items: start;
  gap: var(--space-12);
  block-size: 100%;
  padding: var(--space-32);
}

.editor-empty-title,
.editor-empty-copy {
  margin: 0;
}

.editor-empty-title {
  color: var(--color-text-primary);
  font-size: clamp(2rem, 5vw, 3.5rem);
  letter-spacing: -0.04em;
}

.editor-empty-copy {
  max-inline-size: 420px;
  color: var(--color-text-secondary);
  line-height: 1.7;
}
</style>

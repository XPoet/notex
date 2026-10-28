<script setup lang="ts">
import { t } from '@/i18n'
import { StarFilled } from '@element-plus/icons-vue'
import { computed, shallowRef } from 'vue'
import HighlightedText from '@/components/HighlightedText.vue'
import { NOTE_DRAG_TYPE, type NoteSummary } from '@/types/notes'

const props = defineProps<{
  note: NoteSummary
  selected: boolean
  searchQuery?: string
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const isDragging = shallowRef(false)

function startDrag(event: DragEvent): void {
  if (event.dataTransfer === null) return
  event.dataTransfer.setData(NOTE_DRAG_TYPE, props.note.id)
  event.dataTransfer.effectAllowed = 'move'
  isDragging.value = true
}

const displayTitle = computed(() => {
  const title = props.note.title.trim()
  return title.length > 0 ? title : t('无标题笔记')
})
</script>

<template>
  <button
    class="note-list-item"
    :class="{ 'note-list-item--selected': selected, 'note-list-item--dragging': isDragging }"
    type="button"
    draggable="true"
    :title="t('拖动到左侧分类以移动笔记')"
    :aria-current="selected ? 'page' : undefined"
    @click="emit('select', note.id)"
    @dragstart="startDrag"
    @dragend="isDragging = false"
  >
    <span class="note-list-item-title-row">
      <span class="note-list-item-title">
        <HighlightedText :text="displayTitle" :query="searchQuery" />
      </span>
      <el-icon v-if="note.isPinned" class="note-list-item-pin">
        <StarFilled />
      </el-icon>
    </span>
    <span class="note-list-item-content">
      <span class="note-list-item-preview">
        <HighlightedText :text="note.contentPreview || t('尚未记录内容')" :query="searchQuery" />
      </span>
    </span>
  </button>
</template>

<style scoped lang="scss">
.note-list-item {
  display: grid;
  grid-template-rows: 20px minmax(0, 1fr);
  gap: var(--space-8);
  inline-size: 100%;
  block-size: 92px;
  padding: var(--space-12) 14px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--radius-8);
  background: var(--color-surface);
  color: inherit;
  cursor: pointer;
  text-align: start;
  user-select: none;
}

.note-list-item--dragging {
  opacity: 0.5;
  cursor: grabbing;
}

.note-list-item:hover,
.note-list-item--selected {
  background: var(--color-accent-soft);
}

.note-list-item:hover {
  border-color: color-mix(in srgb, var(--color-accent) 18%, var(--color-border));
}

.note-list-item--selected {
  border-color: var(--color-accent);
}

.note-list-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.note-list-item-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-inline-size: 0;
}

.note-list-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-list-item-title {
  min-inline-size: 0;
  flex: 1 1 auto;
  color: var(--color-text-primary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.note-list-item-pin {
  flex: 0 0 auto;
  color: var(--color-accent);
  font-size: 0.875rem;
}

.note-list-item-preview {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.note-list-item-content {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  gap: var(--space-4);
  min-inline-size: 0;
  min-block-size: 0;
}
</style>

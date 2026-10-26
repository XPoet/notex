<script setup lang="ts">
import { Filter, Search, Sort } from '@element-plus/icons-vue'
import type { ScrollbarInstance } from 'element-plus'
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue'
import NoteListItem from './NoteListItem.vue'
import type { NoteSummary } from '@/types/notes'

const props = defineProps<{
  notes: NoteSummary[]
  categoryName?: string
  selectedId?: string
  loading: boolean
  error?: string
  searchQuery?: string
}>()

const emit = defineEmits<{
  create: []
  retry: []
  select: [id: string]
  search: [query: string]
}>()

const query = shallowRef('')
const listItems = useTemplateRef<ScrollbarInstance>('listItems')
const scrollTop = shallowRef(0)
const viewportHeight = shallowRef(600)
const itemHeight = 96
const renderBuffer = 6
const visibleNotes = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (keyword === '') {
    return props.notes
  }
  return props.notes.filter((note) =>
    `${note.title}\n${note.contentPreview}`.toLocaleLowerCase().includes(keyword),
  )
})
const visibleRange = computed(() => {
  const maximumStart = Math.max(0, visibleNotes.value.length - 1)
  const start = Math.min(maximumStart, Math.floor(scrollTop.value / itemHeight))
  const visibleCount = Math.ceil(viewportHeight.value / itemHeight) + renderBuffer * 2
  return {
    start: Math.max(0, start - renderBuffer),
    end: Math.min(visibleNotes.value.length, start + visibleCount),
  }
})
const renderedNotes = computed(() =>
  visibleNotes.value.slice(visibleRange.value.start, visibleRange.value.end),
)
const noteListTitle = computed(() =>
  props.categoryName === undefined ? '全部笔记' : `${props.categoryName}笔记`,
)
const virtualHeight = computed(() => visibleNotes.value.length * itemHeight)
const virtualOffset = computed(() => visibleRange.value.start * itemHeight)

function updateVisibleRange(): void {
  const container = listItems.value?.wrapRef
  if (container === undefined) {
    return
  }
  scrollTop.value = container.scrollTop
  viewportHeight.value = Math.max(container.clientHeight, itemHeight)
}

onMounted(() => {
  updateVisibleRange()
  window.addEventListener('resize', updateVisibleRange)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateVisibleRange)
})
</script>

<template>
  <section class="note-list">
    <header class="note-list-header">
      <div class="note-list-heading">
        <h1 class="note-list-title">{{ noteListTitle }}</h1>
        <span class="note-list-count">{{ notes.length }}</span>
      </div>
      <el-input
        v-model="query"
        class="note-list-search"
        placeholder="搜索笔记"
        clearable
        @update:model-value="emit('search', $event)"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </header>

    <div v-if="loading" class="note-list-empty">正在加载笔记…</div>
    <div v-else-if="error" class="note-list-empty" role="alert">
      <p class="note-list-empty-title">无法读取笔记</p>
      <p class="note-list-empty-copy">{{ error }}</p>
      <el-button type="primary" @click="emit('retry')">重试</el-button>
    </div>
    <div v-else-if="notes.length === 0" class="note-list-empty">
      <p class="note-list-empty-title">从一条笔记开始</p>
      <p class="note-list-empty-copy">点击“新建笔记”，内容会自动保存在本机。</p>
      <el-button type="primary" @click="emit('create')">新建第一条笔记</el-button>
    </div>
    <div v-else-if="visibleNotes.length === 0" class="note-list-empty">
      <p class="note-list-empty-title">没有匹配的笔记</p>
      <p class="note-list-empty-copy">换一个关键词，或清空当前搜索。</p>
    </div>
    <el-scrollbar v-else ref="listItems" class="note-list-items" @scroll="updateVisibleRange">
      <div class="note-list-virtual-spacer" :style="{ height: `${virtualHeight}px` }">
        <div
          class="note-list-virtual-window"
          :style="{ transform: `translateY(${virtualOffset}px)` }"
        >
          <NoteListItem
            v-for="note in renderedNotes"
            :key="note.id"
            :note="note"
            :selected="note.id === selectedId"
            :search-query="searchQuery ?? query"
            @select="emit('select', $event)"
          />
        </div>
      </div>
    </el-scrollbar>
  </section>
</template>

<style scoped lang="scss">
.note-list {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-block-size: 0;
}

.note-list-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-16) var(--space-16) var(--space-12);
  border-block-end: 1px solid var(--color-divider);
  background: var(--color-surface);
}

.note-list-title,
.note-list-empty-title,
.note-list-empty-copy {
  margin: 0;
}

.note-list-heading {
  display: flex;
  align-items: center;
}

.note-list-title {
  color: var(--color-text-primary);
  font-size: 1.0625rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.note-list-count {
  margin-inline-start: 7px;
  color: var(--color-text-muted);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.6875rem;
}

.note-list-search {
  grid-column: 1 / -1;
}

.note-list-search :deep(.el-input__wrapper) {
  min-block-size: 38px;
  background: var(--color-surface);
}

.note-list-items {
  min-block-size: 0;
}

.note-list-items :deep(.el-scrollbar__view) {
  min-block-size: 100%;
  padding: var(--space-8);
}

.note-list-virtual-spacer {
  position: relative;
  min-block-size: 100%;
}

.note-list-virtual-window {
  position: absolute;
  inset-inline: 0;
  display: grid;
  gap: var(--space-4);
  will-change: transform;
}

.note-list-empty {
  display: grid;
  align-content: center;
  justify-items: start;
  gap: var(--space-12);
  padding: var(--space-24);
}

.note-list-empty-title {
  color: var(--color-text-primary);
  font-weight: 600;
}

.note-list-empty-copy {
  color: var(--color-text-secondary);
  line-height: 1.6;
}
</style>

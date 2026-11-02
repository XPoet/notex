<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { Search } from '@element-plus/icons-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue'
import SearchResultItem from './SearchResultItem.vue'
import type { SearchResult } from '@/types/search'

const props = defineProps<{
  query: string
  results: SearchResult[]
  loading: boolean
  loadingMore: boolean
  error?: string
  rebuilding: boolean
  hasNextPage: boolean
}>()

const emit = defineEmits<{
  loadMore: []
  open: [id: string]
  rebuild: []
  retry: []
}>()

const resultList = useTemplateRef<HTMLElement>('resultList')
const scrollTop = shallowRef(0)
const viewportHeight = shallowRef(768)
const rowHeights = shallowRef(new Map<string, number>())
const estimatedRowHeight = 132
const renderBuffer = 5
let scrollContainer: HTMLElement | undefined
let resizeObserver: ResizeObserver | undefined
let observedRows = new Set<HTMLElement>()

const offsets = computed(() => {
  const values = [0]
  let height = 0
  for (const result of props.results) {
    height += rowHeights.value.get(result.id) ?? estimatedRowHeight
    values.push(height)
  }
  return values
})
const totalHeight = computed(() => offsets.value[props.results.length] ?? 0)

function indexAt(position: number): number {
  let start = 0
  let end = props.results.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if ((offsets.value[middle + 1] ?? 0) <= position) start = middle + 1
    else end = middle
  }
  return Math.min(start, Math.max(0, props.results.length - 1))
}

const visibleRange = computed(() => ({
  start: Math.max(0, indexAt(scrollTop.value) - renderBuffer),
  end: Math.min(props.results.length, indexAt(scrollTop.value + viewportHeight.value) + renderBuffer + 1),
}))
const renderedResults = computed(() => props.results.slice(visibleRange.value.start, visibleRange.value.end))
const windowOffset = computed(() => offsets.value[visibleRange.value.start] ?? 0)

function updateViewport(): void {
  const list = resultList.value
  if (list === null) return
  const viewportTop = scrollContainer?.getBoundingClientRect().top ?? 0
  scrollTop.value = Math.max(0, viewportTop - list.getBoundingClientRect().top)
  viewportHeight.value = Math.max(1, scrollContainer?.clientHeight ?? window.innerHeight)
}

function scrollByOffset(offset: number): void {
  if (scrollContainer !== undefined) scrollContainer.scrollTop += offset
  else window.scrollBy({ top: offset })
  scrollTop.value = Math.max(0, scrollTop.value + offset)
}

function measureRows(): void {
  const rows = resultList.value?.querySelectorAll<HTMLElement>('.search-result-row')
  if (rows === undefined) return
  const currentRows = new Set(rows)
  for (const row of observedRows) {
    if (!currentRows.has(row)) resizeObserver?.unobserve(row)
  }
  let heights: Map<string, number> | undefined
  for (const row of rows) {
    if (!observedRows.has(row)) resizeObserver?.observe(row)
    const id = row.dataset.resultId
    const height = row.getBoundingClientRect().height
    if (id !== undefined && height > 0 && Math.abs((rowHeights.value.get(id) ?? estimatedRowHeight) - height) > 0.5) {
      heights ??= new Map(rowHeights.value)
      heights.set(id, height)
    }
  }
  observedRows = currentRows
  if (heights !== undefined) {
    const anchor = indexAt(scrollTop.value)
    const previousOffset = offsets.value[anchor] ?? 0
    rowHeights.value = heights
    const adjustment = (offsets.value[anchor] ?? 0) - previousOffset
    if (adjustment !== 0) scrollByOffset(adjustment)
  }
}

async function handleRowKeydown(event: KeyboardEvent, index: number): Promise<void> {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
  const nextIndex = index + (event.shiftKey ? -1 : 1)
  if (nextIndex < 0 || nextIndex >= props.results.length) return
  if (nextIndex >= visibleRange.value.start && nextIndex < visibleRange.value.end) return
  event.preventDefault()
  scrollByOffset((offsets.value[nextIndex] ?? 0) - scrollTop.value)
  await nextTick()
  const id = props.results[nextIndex]?.id
  const row = Array.from(resultList.value?.querySelectorAll<HTMLElement>('.search-result-row') ?? []).find(
    (element) => element.dataset.resultId === id,
  )
  row?.querySelector('button')?.focus()
}

watch([renderedResults, () => props.loading, () => props.error], measureRows, { flush: 'post' })
watch(
  () => props.query,
  () => {
    rowHeights.value = new Map()
    scrollTop.value = 0
    if (scrollContainer !== undefined) scrollContainer.scrollTop = 0
    else if (window.scrollY > 0) window.scrollTo({ top: 0 })
    void nextTick(updateViewport)
  },
)

onMounted(() => {
  let parent = resultList.value?.parentElement
  while (parent !== null && parent !== undefined) {
    if (/(auto|scroll)/.test(window.getComputedStyle(parent).overflowY)) {
      scrollContainer = parent
      break
    }
    parent = parent.parentElement
  }
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      updateViewport()
      measureRows()
    })
    if (scrollContainer !== undefined) resizeObserver.observe(scrollContainer)
  }
  const scrollTarget = scrollContainer ?? window
  scrollTarget.addEventListener('scroll', updateViewport, { passive: true })
  window.addEventListener('resize', updateViewport)
  updateViewport()
  measureRows()
})

onBeforeUnmount(() => {
  const scrollTarget = scrollContainer ?? window
  scrollTarget.removeEventListener('scroll', updateViewport)
  window.removeEventListener('resize', updateViewport)
  resizeObserver?.disconnect()
})
</script>

<template>
  <section ref="resultList" class="search-results" aria-live="polite">
    <p v-if="loading" class="search-state">{{ t('正在搜索本地笔记…') }}</p>
    <div v-else-if="error" class="search-state search-state--error" role="alert">
      <p>{{ localizeMessage(error) }}</p>
      <div class="search-state-actions">
        <el-button :loading="rebuilding" @click="emit('rebuild')">{{ t('重建索引') }}</el-button>
        <el-button type="primary" @click="emit('retry')">{{ t('重试') }}</el-button>
      </div>
    </div>
    <div v-else-if="query === ''" class="search-state">
      <el-icon><Search /></el-icon>
      <p>{{ t('输入关键词，即可在标题、正文、分类和标签中查找笔记。') }}</p>
    </div>
    <div v-else-if="results.length === 0" class="search-state">
      <el-icon><Search /></el-icon>
      <p>{{ t('暂无搜索结果') }}</p>
      <small>{{ t('可尝试缩短关键词，或检查笔记是否已移入回收站。') }}</small>
    </div>
    <template v-else>
      <div class="search-result-spacer" :style="{ height: `${totalHeight}px` }" role="list">
        <div class="search-result-window" :style="{ transform: `translateY(${windowOffset}px)` }">
          <div
            v-for="(result, index) in renderedResults"
            :key="result.id"
            class="search-result-row"
            :data-result-id="result.id"
            role="listitem"
            :aria-posinset="visibleRange.start + index + 1"
            :aria-setsize="results.length"
            @keydown="handleRowKeydown($event, visibleRange.start + index)"
          >
            <SearchResultItem :result="result" :query="query" @open="emit('open', $event)" />
          </div>
        </div>
      </div>
      <div v-if="hasNextPage" class="search-more">
        <el-button :loading="loadingMore" @click="emit('loadMore')">{{ t('加载更多') }}</el-button>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.search-results {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.search-result-spacer {
  position: relative;
}

.search-result-window {
  position: absolute;
  inset-inline: 0;
}

.search-state {
  display: grid;
  min-block-size: 320px;
  place-content: center;
  justify-items: center;
  gap: var(--space-12);
  padding: var(--space-24);
  color: var(--color-text-secondary);
  text-align: center;
}

.search-state p,
.search-state small {
  margin: 0;
}

.search-state > .el-icon {
  display: grid;
  inline-size: 42px;
  block-size: 42px;
  place-items: center;
  border-radius: var(--radius-10);
  background: var(--color-canvas);
  color: var(--color-accent);
  font-size: 1.125rem;
}

.search-state--error {
  color: var(--color-danger);
}

.search-state-actions {
  display: flex;
  gap: var(--space-8);
}

.search-more {
  display: grid;
  place-items: center;
  padding: var(--space-16);
}
</style>

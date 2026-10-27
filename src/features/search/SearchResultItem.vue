<script setup lang="ts">
import { Folder } from '@element-plus/icons-vue'
import { computed } from 'vue'
import HighlightedText from '@/components/HighlightedText.vue'
import type { SearchResult } from '@/types/search'

const props = defineProps<{
  result: SearchResult
  query?: string
}>()

const emit = defineEmits<{
  open: [id: string]
}>()

const displayTitle = computed(() => props.result.title.trim() || '无标题笔记')
const updatedLabel = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(props.result.updatedAt)),
)
</script>

<template>
  <button class="search-result-item" type="button" @click="emit('open', result.id)">
    <span class="search-result-title-row">
      <strong class="search-result-title">
        <HighlightedText :text="displayTitle" :query="query" />
      </strong>
      <time class="search-result-time" :datetime="result.updatedAt">{{ updatedLabel }}</time>
    </span>
    <span class="search-result-preview">
      <HighlightedText :text="result.contentPreview || '没有正文内容'" :query="query" />
    </span>
    <span class="search-result-meta">
      <span v-if="result.categoryPath" class="search-result-category">
        <el-icon><Folder /></el-icon>
        <span class="search-result-category-path">
          <HighlightedText :text="result.categoryPath" :query="query" />
        </span>
      </span>
      <el-tag
        v-for="tagName in result.tagNames"
        disable-transitions
        type="primary"
        size="small"
        :key="tagName"
      >
        <span><HighlightedText :text="tagName" :query="query" /></span>
      </el-tag>
    </span>
  </button>
</template>

<style scoped lang="scss">
.search-result-item {
  display: grid;
  inline-size: 100%;
  gap: 9px;
  padding: var(--space-16) var(--space-12);
  border: 0;
  border-block-end: 1px solid var(--color-divider);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: start;
}

.search-result-item:hover,
.search-result-item:focus-visible {
  outline: none;
  background: var(--color-accent-soft);
}

.search-result-title-row,
.search-result-meta,
.search-result-category {
  display: flex;
  align-items: center;
}

.search-result-title-row {
  min-inline-size: 0;
  gap: var(--space-12);
}

.search-result-title,
.search-result-preview,
.search-result-category-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-result-title {
  min-inline-size: 0;
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  font-weight: 650;
}

.search-result-time {
  flex: 0 0 auto;
  margin-inline-start: auto;
  color: var(--color-text-muted);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.6875rem;
}

.search-result-preview {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.search-result-meta {
  min-inline-size: 0;
  flex-wrap: wrap;
  gap: var(--space-8);
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

.search-result-category {
  min-inline-size: 0;
  gap: 4px;
}

.search-result-category .el-icon {
  flex: 0 0 auto;
}

.search-result-category-path {
  min-inline-size: 0;
}
</style>

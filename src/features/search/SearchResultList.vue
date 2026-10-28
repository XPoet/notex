<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { Search } from '@element-plus/icons-vue'
import SearchResultItem from './SearchResultItem.vue'
import type { SearchResult } from '@/types/search'

defineProps<{
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
</script>

<template>
  <section class="search-results" aria-live="polite">
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
      <SearchResultItem
        v-for="result in results"
        :key="result.id"
        :result="result"
        :query="query"
        @open="emit('open', $event)"
      />
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

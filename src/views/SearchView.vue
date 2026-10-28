<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSearchQuery } from '@/composables/useSearchQuery'
import SearchInput from '@/components/SearchInput.vue'
import SearchResultList from '@/features/search/SearchResultList.vue'
import ManagementLayout from '@/layouts/ManagementLayout.vue'
import { useCategoriesStore } from '@/stores/categories'
import { useSearchStore } from '@/stores/search'
import { useTagsStore } from '@/stores/tags'

const route = useRoute()
const router = useRouter()
const categoriesStore = useCategoriesStore()
const tagsStore = useTagsStore()
const searchStore = useSearchStore()
const inputValue = shallowRef('')
const routeQuery = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const { schedule, cancel } = useSearchQuery(searchStore.search)

watch(
  routeQuery,
  (value) => {
    inputValue.value = value
    if (value.trim() === '') {
      cancel()
      searchStore.reset()
      return
    }
    schedule(value)
  },
  { immediate: true },
)

function updateQuery(value: string): void {
  const query = value.trim()
  if (query === '') {
    cancel()
    searchStore.reset()
    void router.replace({ name: 'workbench' })
    return
  }
  void router.replace({ name: 'search', query: { q: query } })
}

function openResult(id: string): void {
  void router.push({
    name: 'workbench',
    query: { note: id, search: routeQuery.value },
  })
}

function createNote(categoryId?: string): void {
  void router.push({ name: 'workbench', query: { create: '1', category: categoryId } })
}

function retry(): void {
  void searchStore.search(routeQuery.value)
}

function rebuild(): void {
  void searchStore.rebuild()
}

onMounted(() => {
  void Promise.all([categoriesStore.load(), tagsStore.load()])
})
</script>

<template>
  <ManagementLayout
    :title="t('全局搜索')"
    :description="
      searchStore.total > 0
        ? t('找到 {value1} 篇所属笔记', { value1: searchStore.total })
        : t('搜索标题、正文、分类和标签')
    "
    :categories="categoriesStore.categories"
    :tag-count="tagsStore.tags.length"
    @create="createNote"
  >
    <section class="search-view">
      <SearchInput :model-value="inputValue" @update:model-value="updateQuery" @clear="updateQuery('')" />
      <p class="search-tip">{{ t('多个以空格分隔的关键词会同时匹配；回收站内容不会出现在结果中。') }}</p>
      <SearchResultList
        :query="searchStore.query"
        :results="searchStore.results"
        :loading="searchStore.isLoading"
        :loading-more="searchStore.isLoadingMore"
        :error="searchStore.error?.message"
        :rebuilding="searchStore.isRebuilding"
        :has-next-page="searchStore.nextOffset !== null"
        @load-more="searchStore.loadNext"
        @open="openResult"
        @rebuild="rebuild"
        @retry="retry"
      />
    </section>
  </ManagementLayout>
</template>

<style scoped lang="scss">
.search-view {
  display: grid;
  gap: var(--space-12);
}

.search-tip {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}
</style>

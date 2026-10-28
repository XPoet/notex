<script setup lang="ts">
import { t } from '@/i18n'
import { computed, shallowRef } from 'vue'
import type { CategoryNode } from '@/types/categories'
import type { TagSummary } from '@/types/tags'

const props = defineProps<{
  categories: CategoryNode[]
  categoryId?: string
  tags: TagSummary[]
  selectedTagIds: string[]
}>()

const emit = defineEmits<{
  updateCategory: [categoryId: string | undefined]
  updateTags: [tagIds: string[]]
  createTag: [name: string]
}>()

const newTagName = shallowRef('')
const categoryOptions = computed(() => flattenCategories(props.categories))

function createTag(): void {
  const name = newTagName.value.trim()
  if (name === '') return
  emit('createTag', name)
  newTagName.value = ''
}

function flattenCategories(categories: CategoryNode[]): CategoryNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)])
}
</script>

<template>
  <section class="note-metadata">
    <el-select
      clearable
      :model-value="categoryId"
      :placeholder="t('未分类')"
      @update:model-value="emit('updateCategory', $event || undefined)"
    >
      <el-option v-for="category in categoryOptions" :key="category.id" :label="category.path" :value="category.id" />
    </el-select>
    <el-select
      class="metadata-select"
      multiple
      collapse-tags
      :model-value="selectedTagIds"
      :placeholder="t('添加标签')"
      @update:model-value="emit('updateTags', $event)"
    >
      <el-option v-for="tag in tags" :key="tag.id" :label="tag.name" :value="tag.id" />
    </el-select>
  </section>
</template>

<style scoped lang="scss">
.note-metadata {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-16) 0 var(--space-12);
}
</style>

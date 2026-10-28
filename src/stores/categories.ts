import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { listCategories, moveCategory, toCategoryError } from '@/services/categories'
import type { CategoryError, CategoryNode } from '@/types/categories'

export const useCategoriesStore = defineStore('categories', () => {
  const categories = shallowRef<CategoryNode[]>([])
  const isLoading = shallowRef(false)
  const error = shallowRef<CategoryError>()

  async function refreshCategories(): Promise<void> {
    categories.value = await listCategories()
    error.value = undefined
  }

  async function load(): Promise<void> {
    isLoading.value = true
    try {
      await refreshCategories()
    } catch (failure: unknown) {
      error.value = toCategoryError(failure)
    } finally {
      isLoading.value = false
    }
  }

  async function move(id: string, parentId: string | undefined, orderedIds: string[]): Promise<void> {
    isLoading.value = true
    error.value = undefined
    try {
      await moveCategory(id, parentId, orderedIds)
      await refreshCategories()
    } catch (failure: unknown) {
      const commandError = toCategoryError(failure)
      try {
        await refreshCategories()
      } catch {
        /** 保留最近一次成功加载的分类树，由调用方显示原始移动错误。 */
      }
      error.value = commandError
      throw commandError
    } finally {
      isLoading.value = false
    }
  }

  return { categories, isLoading, error, load, move }
})

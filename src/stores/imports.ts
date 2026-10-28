import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { importNote, toImportError } from '@/services/imports'
import { MAX_IMPORT_FILES, type ImportItem } from '@/types/imports'

export const useImportsStore = defineStore('imports', () => {
  const items = shallowRef<ImportItem[]>([])
  const isImporting = shallowRef(false)
  const selectionError = shallowRef<string>()
  const pendingCount = computed(
    () => items.value.filter((item) => item.status === 'pending').length,
  )
  const succeededCount = computed(
    () => items.value.filter((item) => item.status === 'succeeded').length,
  )
  const failedCount = computed(() => items.value.filter((item) => item.status === 'failed').length)
  const processedCount = computed(() => succeededCount.value + failedCount.value)

  function addFiles(files: File[]): void {
    if (isImporting.value || files.length === 0) return
    selectionError.value = undefined
    if (items.value.length + files.length > MAX_IMPORT_FILES) {
      selectionError.value = `一次最多选择 ${MAX_IMPORT_FILES} 个文件，请分批导入。`
      return
    }
    items.value = [
      ...items.value,
      ...files.map(
        (file): ImportItem => ({
          id: crypto.randomUUID(),
          file,
          title: file.name.replace(/\.(md|txt)$/i, ''),
          status: 'pending',
        }),
      ),
    ]
  }

  function updateItem(id: string, change: Partial<ImportItem>): void {
    items.value = items.value.map((item) => (item.id === id ? { ...item, ...change } : item))
  }

  function removeItem(id: string): void {
    if (isImporting.value) return
    items.value = items.value.filter((item) => item.id !== id)
    selectionError.value = undefined
  }

  function clear(): void {
    if (isImporting.value) return
    items.value = []
    selectionError.value = undefined
  }

  async function start(retryFailed = false): Promise<void> {
    if (isImporting.value) return
    const queue = items.value.filter((item) => item.status === (retryFailed ? 'failed' : 'pending'))
    if (queue.length === 0) return
    isImporting.value = true
    for (const item of queue) updateItem(item.id, { status: 'pending', error: undefined })
    try {
      for (const item of queue) {
        updateItem(item.id, { status: 'importing', error: undefined })
        try {
          const note = await importNote(item.file)
          updateItem(item.id, { status: 'succeeded', noteId: note.id, title: note.title })
        } catch (failure: unknown) {
          updateItem(item.id, { status: 'failed', error: toImportError(failure) })
        }
      }
    } finally {
      isImporting.value = false
    }
  }

  return {
    items,
    isImporting,
    selectionError,
    pendingCount,
    succeededCount,
    failedCount,
    processedCount,
    addFiles,
    removeItem,
    clear,
    start,
  }
})

<script setup lang="ts">
import { t, localizeMessage, locale } from '@/i18n'
import { Delete, RefreshLeft, WarningFilled } from '@element-plus/icons-vue'
import { onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import ManagementLayout from '@/layouts/ManagementLayout.vue'
import { emptyTrash, permanentlyDeleteNote, restoreNote } from '@/services/trash'
import { useCategoriesStore } from '@/stores/categories'
import { useTrashStore } from '@/stores/trash'

const categoriesStore = useCategoriesStore()
const trashStore = useTrashStore()
const router = useRouter()
const isSubmitting = shallowRef(false)

function titleOf(title: string, preview: string): string {
  return title.trim() || preview || t('无标题笔记')
}

function deletedAtLabel(value: string): string {
  return new Intl.DateTimeFormat(locale.value, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

async function restore(id: string): Promise<void> {
  isSubmitting.value = true
  try {
    const result = await restoreNote(id)
    ElMessage.success(result.restoredToUncategorized ? t('原分类已不存在，笔记已恢复到未分类。') : t('笔记已恢复。'))
    await trashStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function permanentlyDelete(id: string): Promise<void> {
  const shouldDelete = await ElMessageBox.confirm(t('永久删除后无法恢复，是否继续？'), t('确认永久删除'), {
    confirmButtonText: t('永久删除'),
    cancelButtonText: t('取消'),
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false)
  if (!shouldDelete) {
    return
  }
  isSubmitting.value = true
  try {
    const result = await permanentlyDeleteNote(id)
    ElMessage.success(
      result.pendingFileCleanupCount > 0 ? t('笔记已永久删除，少量资源文件将在后续自动清理。') : t('笔记已永久删除。'),
    )
    await trashStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function clearTrash(): Promise<void> {
  const shouldClear = await ElMessageBox.confirm(
    t('将永久删除回收站内的全部笔记，且无法恢复。是否继续？'),
    t('确认清空回收站'),
    { confirmButtonText: t('清空回收站'), cancelButtonText: t('取消'), type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!shouldClear) {
    return
  }
  isSubmitting.value = true
  try {
    const result = await emptyTrash()
    ElMessage.success(
      result.pendingFileCleanupCount > 0 ? t('回收站已清空，少量资源文件将在后续自动清理。') : t('回收站已清空。'),
    )
    await trashStore.load()
  } finally {
    isSubmitting.value = false
  }
}

function createNoteFromSidebar(categoryId?: string): void {
  void router.push({ name: 'workbench', query: { create: '1', category: categoryId } })
}

onMounted(() => {
  void Promise.all([trashStore.load(), categoriesStore.load()])
})
</script>

<template>
  <ManagementLayout
    :title="t('回收站')"
    :description="t('删除的笔记会保留在这里，直到你手动永久删除。')"
    :categories="categoriesStore.categories"
    :trash-count="trashStore.notes.length"
    @create="createNoteFromSidebar"
  >
    <template #action>
      <el-button
        type="danger"
        plain
        :disabled="trashStore.notes.length === 0 || isSubmitting"
        :icon="Delete"
        @click="clearTrash"
        >{{ t('清空回收站') }}</el-button
      >
    </template>

    <p v-if="trashStore.error" class="management-error" role="alert">
      {{ localizeMessage(trashStore.error.message) }}
    </p>
    <section v-else-if="!trashStore.isLoading && trashStore.notes.length === 0" class="trash-empty">
      <el-icon><Delete /></el-icon>
      <h2>{{ t('回收站为空') }}</h2>
      <p>{{ t('删除的笔记会出现在这里，并且可在永久删除前恢复。') }}</p>
    </section>
    <template v-else>
      <p class="trash-notice" role="note">
        <el-icon><WarningFilled /></el-icon>{{ t('永久删除后无法恢复；关联资源会在没有任何笔记引用时清理。') }}
      </p>
      <section class="trash-list">
        <article v-for="note in trashStore.notes" :key="note.id" class="trash-item">
          <div class="trash-note-content">
            <h2 class="trash-title">{{ titleOf(note.title, note.contentPreview) }}</h2>
            <p class="trash-preview">{{ note.contentPreview || t('没有正文内容') }}</p>
            <p class="trash-meta">
              {{
                t('删除于 {value1}{value2}', {
                  value1: deletedAtLabel(note.deletedAt),
                  value2: note.trashedFromCategoryPath
                    ? t(' · 原分类：{value1}', { value1: note.trashedFromCategoryPath })
                    : '',
                })
              }}
            </p>
          </div>
          <div class="trash-actions">
            <el-button :loading="isSubmitting" :icon="RefreshLeft" @click="restore(note.id)">{{ t('恢复') }}</el-button>
            <el-button type="danger" plain :loading="isSubmitting" :icon="Delete" @click="permanentlyDelete(note.id)">{{
              t('永久删除')
            }}</el-button>
          </div>
        </article>
      </section>
      <p class="trash-count">{{ t('回收站中共有 {value1} 篇笔记', { value1: trashStore.notes.length }) }}</p>
    </template>
  </ManagementLayout>
</template>

<style scoped lang="scss">
.management-error,
.trash-empty h2,
.trash-empty p,
.trash-notice,
.trash-title,
.trash-preview,
.trash-meta,
.trash-count {
  margin: 0;
}

.management-error {
  color: var(--color-danger);
}

.trash-empty {
  display: grid;
  min-block-size: 420px;
  place-content: center;
  justify-items: center;
  gap: var(--space-12);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
  text-align: center;
}

.trash-empty > .el-icon {
  display: grid;
  inline-size: 44px;
  block-size: 44px;
  place-items: center;
  border-radius: var(--radius-10);
  background: var(--color-sidebar);
  color: var(--color-text-secondary);
  font-size: 1.3125rem;
}

.trash-empty h2 {
  color: var(--color-text-primary);
  font-size: 0.9375rem;
}

.trash-empty p {
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.55;
}

.trash-notice {
  display: flex;
  align-items: center;
  min-block-size: 42px;
  gap: var(--space-8);
  padding: 0 var(--space-12);
  border: 1px solid color-mix(in srgb, var(--color-danger) 26%, var(--color-border));
  border-radius: var(--radius-8);
  background: color-mix(in srgb, var(--color-danger) 7%, var(--color-surface));
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.trash-notice .el-icon {
  color: var(--color-danger);
}

.trash-list {
  margin-block-start: 14px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.trash-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-block-size: 112px;
  gap: var(--space-24);
  padding: var(--space-16) 18px;
  border-block-end: 1px solid var(--color-divider);
}

.trash-item:last-child {
  border-block-end: 0;
}

.trash-note-content {
  min-inline-size: 0;
}

.trash-title {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 0.875rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-preview,
.trash-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-preview {
  margin-block-start: 7px;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.trash-meta {
  margin-block-start: 8px;
  color: var(--color-text-muted);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.625rem;
}

.trash-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-8);
}

.trash-count {
  margin-block-start: var(--space-12);
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

@media (max-width: 760px) {
  .trash-item {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

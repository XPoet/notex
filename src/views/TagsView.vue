<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { Delete, Download, EditPen, Plus, Search, View } from '@element-plus/icons-vue'
import { computed, onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import ManagementLayout from '@/layouts/ManagementLayout.vue'
import ExportDialog from '@/features/export/ExportDialog.vue'
import { createTag, deleteTag, mergeTag, renameTag } from '@/services/tags'
import { useCategoriesStore } from '@/stores/categories'
import { useTagsStore } from '@/stores/tags'
import type { TagSummary } from '@/types/tags'
import type { ExportScopeOption } from '@/types/export'

const categoriesStore = useCategoriesStore()
const tagsStore = useTagsStore()
const router = useRouter()
const query = shallowRef('')
const isSubmitting = shallowRef(false)
const exportTag = shallowRef<TagSummary>()
const isExportDialogVisible = shallowRef(false)
const exportScopeOptions = computed<ExportScopeOption[]>(() => {
  const tag = exportTag.value
  if (tag === undefined) {
    return []
  }
  return [
    {
      scope: { kind: 'tag', id: tag.id },
      title: t('标签「{value1}」', { value1: tag.name }),
      description: t('每条笔记单独导出，不按原分类重复创建文件。'),
    },
  ]
})
const visibleTags = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (keyword === '') {
    return tagsStore.tags
  }
  return tagsStore.tags.filter((tag) => tag.name.toLocaleLowerCase().includes(keyword))
})
const tagStats = computed(() => [
  { label: t('标签总数'), value: tagsStore.tags.length },
  { label: t('已关联标签'), value: tagsStore.tags.filter((tag) => tag.noteCount > 0).length },
  { label: t('未关联标签'), value: tagsStore.tags.filter((tag) => tag.noteCount === 0).length },
])

async function promptAddTag(): Promise<void> {
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(t('输入标签名称。'), t('新建标签'), {
      confirmButtonText: t('创建'),
      cancelButtonText: t('取消'),
    }))
  } catch {
    return
  }
  isSubmitting.value = true
  try {
    await createTag(value)
    await tagsStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function rename(tag: TagSummary): Promise<void> {
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(t('输入新的标签名称。'), t('重命名「{value1}」', { value1: tag.name }), {
      inputValue: tag.name,
      confirmButtonText: t('保存'),
      cancelButtonText: t('取消'),
    }))
  } catch {
    return
  }
  isSubmitting.value = true
  try {
    const result = await renameTag(tag.id, value)
    if (result.mergePreview) {
      const shouldMerge = await ElMessageBox.confirm(
        t('目标标签已存在，将合并 {value1} 条笔记的关联。是否继续？', {
          value1: result.mergePreview.affectedNoteCount,
        }),
        t('确认合并标签'),
        { confirmButtonText: t('合并'), cancelButtonText: t('取消'), type: 'warning' },
      )
        .then(() => true)
        .catch(() => false)
      if (!shouldMerge) {
        return
      }
      await mergeTag(result.mergePreview.sourceId, result.mergePreview.targetId)
    }
    await tagsStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function remove(tag: TagSummary): Promise<void> {
  const shouldRemove = await ElMessageBox.confirm(
    t('删除标签「{value1}」只会解除关联，不会删除笔记。是否继续？', { value1: tag.name }),
    t('确认删除标签'),
    { confirmButtonText: t('删除'), cancelButtonText: t('取消'), type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!shouldRemove) {
    return
  }
  isSubmitting.value = true
  try {
    await deleteTag(tag.id)
    ElMessage.success(t('标签已删除。'))
    await tagsStore.load()
  } finally {
    isSubmitting.value = false
  }
}

function viewNotes(tag: TagSummary): void {
  void router.push({ name: 'workbench', query: { tags: tag.id } })
}

function openExport(tag: TagSummary): void {
  exportTag.value = tag
  isExportDialogVisible.value = true
}

function createNoteFromSidebar(categoryId?: string): void {
  void router.push({ name: 'workbench', query: { create: '1', category: categoryId } })
}

onMounted(() => {
  void Promise.all([tagsStore.load(), categoriesStore.load()])
})
</script>

<template>
  <ManagementLayout
    :title="t('标签管理')"
    :description="t('标签可重复用于多条笔记；多标签筛选默认同时满足全部标签。')"
    :categories="categoriesStore.categories"
    :tag-count="tagsStore.tags.length"
    @create="createNoteFromSidebar"
  >
    <template #action>
      <el-button type="primary" :icon="Plus" :loading="isSubmitting" @click="promptAddTag">{{
        t('新建标签')
      }}</el-button>
    </template>

    <p v-if="tagsStore.error" class="management-error" role="alert">
      {{ localizeMessage(tagsStore.error.message) }}
    </p>
    <section v-else class="tag-content">
      <section class="tag-stats">
        <article v-for="stat in tagStats" :key="stat.label" class="tag-stat-card">
          <p>{{ stat.label }}</p>
          <strong>{{ stat.value }}</strong>
        </article>
      </section>

      <section class="tag-toolbar">
        <el-input v-model="query" class="tag-search" :placeholder="t('搜索标签')">
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
      </section>

      <el-empty
        v-if="!tagsStore.isLoading && visibleTags.length === 0"
        class="tag-empty"
        :description="query.trim() === '' ? t('还没有标签') : t('暂无匹配标签')"
      />
      <section v-else class="tag-table-wrap">
        <el-table :data="visibleTags" class="tag-table" height="100%" :native-scrollbar="false">
          <el-table-column :label="t('标签')" min-width="220">
            <template #default="{ row }">
              <el-tag disable-transitions>{{ row.name }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('关联笔记')" min-width="150">
            <template #default="{ row }">
              <span class="tag-note-count">{{ t('{value1} 篇笔记', { value1: row.noteCount }) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('操作')" min-width="260" align="right">
            <template #default="{ row }">
              <div class="tag-row-actions">
                <el-button text size="small" :icon="View" @click="viewNotes(row)">{{ t('查看') }}</el-button>
                <el-button text size="small" :icon="Download" @click="openExport(row)">{{ t('导出') }}</el-button>
                <el-button text size="small" :disabled="isSubmitting" :icon="EditPen" @click="rename(row)">{{
                  t('重命名')
                }}</el-button>
                <el-button
                  text
                  type="danger"
                  size="small"
                  :disabled="isSubmitting"
                  :icon="Delete"
                  @click="remove(row)"
                  >{{ t('删除') }}</el-button
                >
              </div>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </section>
  </ManagementLayout>
  <ExportDialog v-model="isExportDialogVisible" :scope-options="exportScopeOptions" />
</template>

<style scoped lang="scss">
.management-error,
.tag-stat-card p {
  margin: 0;
}

.management-error {
  color: var(--color-danger);
}

.tag-content {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  block-size: calc(100dvh - 140px);
  min-block-size: 0;
}

.tag-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-12);
}

.tag-stat-card {
  min-block-size: 84px;
  padding: var(--space-16);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.tag-stat-card p {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.tag-stat-card strong {
  display: block;
  margin-block-start: var(--space-8);
  color: var(--color-text-primary);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 1.5rem;
  font-weight: 500;
}

.tag-toolbar {
  display: flex;
  gap: var(--space-12);
  margin-block: var(--space-16);
}

.tag-search :deep(.el-input__wrapper) {
  min-block-size: 38px;
  background: var(--color-surface);
}

.tag-empty,
.tag-table-wrap {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.tag-empty {
  min-block-size: 320px;
}

.tag-table-wrap {
  overflow: hidden;
  min-block-size: 0;
}

.tag-table {
  block-size: 100%;
  --el-table-border-color: var(--color-divider);
  --el-table-header-bg-color: var(--color-surface);
  --el-table-row-hover-bg-color: var(--color-canvas);
  --el-table-bg-color: var(--color-surface);
  --el-table-tr-bg-color: var(--color-surface);
  --el-fill-color-lighter: var(--color-canvas);
  color: var(--color-text-primary);
}

.tag-table :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.tag-table :deep(.el-table__header-wrapper th.el-table__cell) {
  block-size: 52px;
  color: var(--color-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
}

.tag-table :deep(.el-table__body-wrapper td.el-table__cell) {
  block-size: 50px;
  color: var(--color-text-primary);
  font-size: 0.7rem;
}

.tag-note-count {
  color: var(--color-text-secondary);
}

.tag-row-actions {
  display: flex;
  justify-content: flex-end;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .tag-stats {
    grid-template-columns: 1fr;
  }

  .tag-row-actions .el-button span {
    display: none;
  }
}
</style>

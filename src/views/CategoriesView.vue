<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { Delete, Download, EditPen, Folder, Plus, View, WarningFilled } from '@element-plus/icons-vue'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AllowDropType, NodeDropType, RenderContentContext, TreeOptionProps } from 'element-plus'
import ManagementLayout from '@/layouts/ManagementLayout.vue'
import ExportDialog from '@/features/export/ExportDialog.vue'
import { createCategory, deleteCategory, getCategoryDeleteImpact, renameCategory } from '@/services/categories'
import { useCategoriesStore } from '@/stores/categories'
import type { CategoryDeleteMode, CategoryNode } from '@/types/categories'
import type { ExportScopeOption } from '@/types/export'

type CategoryTreeNode = RenderContentContext['node']
type SuccessfulNodeDropType = Exclude<NodeDropType, 'none'>

const categoriesStore = useCategoriesStore()
const router = useRouter()
const treeData = shallowRef<CategoryNode[]>([])
const selectedCategory = shallowRef<CategoryNode>()
const isSubmitting = shallowRef(false)
const isExportDialogVisible = shallowRef(false)
const treeProps: TreeOptionProps = {
  children: 'children',
  label: 'name',
}
const exportScopeOptions = computed<ExportScopeOption[]>(() => {
  const category = selectedCategory.value
  if (category === undefined) {
    return []
  }
  return [
    {
      scope: { kind: 'category', id: category.id },
      title: t('仅当前分类'),
      description: t('导出「{value1}」直属的笔记。', { value1: category.name }),
    },
    {
      scope: { kind: 'categoryWithDescendants', id: category.id },
      title: t('当前分类及全部子分类'),
      description: t('保留分类层级，并把图片统一放在导出根目录。'),
    },
  ]
})

async function addCategory(parent?: CategoryNode): Promise<void> {
  if (parent?.level === 5) {
    return
  }
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(
      t('输入分类名称。'),
      parent ? t('在「{value1}」下新建分类', { value1: parent.name }) : t('新建根分类'),
      { confirmButtonText: t('创建'), cancelButtonText: t('取消') },
    ))
  } catch {
    return
  }
  isSubmitting.value = true
  try {
    await createCategory(value, parent?.id)
    await categoriesStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function rename(category: CategoryNode): Promise<void> {
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(
      t('输入新的分类名称。'),
      t('重命名「{value1}」', { value1: category.name }),
      {
        inputValue: category.name,
        confirmButtonText: t('保存'),
        cancelButtonText: t('取消'),
      },
    ))
  } catch {
    return
  }
  isSubmitting.value = true
  try {
    await renameCategory(category.id, value)
    await categoriesStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function remove(category: CategoryNode): Promise<void> {
  const impact = await getCategoryDeleteImpact(category.id)
  const shouldDelete = await ElMessageBox.confirm(
    t('直属笔记 {value1} 条，子分类 {value2} 个，分支内共 {value3} 条笔记。', {
      value1: impact.directNoteCount,
      value2: impact.childCategoryCount,
      value3: impact.branchNoteCount,
    }),
    t('删除「{value1}」', { value1: category.name }),
    { confirmButtonText: t('继续'), cancelButtonText: t('取消'), type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!shouldDelete) {
    return
  }
  const mode = await ElMessageBox.confirm(
    t('删除整个分支会把分支内笔记移入回收站；取消则仅删除当前分类并提升直属内容。'),
    t('选择删除方式'),
    {
      confirmButtonText: t('删除整个分支'),
      cancelButtonText: t('仅删除当前分类'),
      distinguishCancelAndClose: true,
      type: 'warning',
    },
  )
    .then((): CategoryDeleteMode => 'branch')
    .catch((reason: unknown): CategoryDeleteMode | undefined => (reason === 'cancel' ? 'current' : undefined))
  if (mode === undefined) {
    return
  }
  isSubmitting.value = true
  try {
    await deleteCategory(category.id, mode)
    selectedCategory.value = undefined
    await categoriesStore.load()
  } finally {
    isSubmitting.value = false
  }
}

async function handleDrop(
  draggingNode: CategoryTreeNode,
  dropNode: CategoryTreeNode,
  dropType: SuccessfulNodeDropType,
): Promise<void> {
  const parentNode = dropType === 'inner' ? dropNode : dropNode.parent
  if (parentNode === null) {
    treeData.value = cloneCategories(categoriesStore.categories)
    return
  }
  const parentId = parentNode.level === 0 ? undefined : parentNode.data.id
  const orderedIds = parentNode.childNodes.map((node) => node.data.id)
  isSubmitting.value = true
  try {
    await categoriesStore.move(draggingNode.data.id, parentId, orderedIds)
    ElMessage.success(t('分类已移动'))
  } catch (error: unknown) {
    treeData.value = cloneCategories(categoriesStore.categories)
    ElMessage.error(categoryErrorMessage(error))
  } finally {
    isSubmitting.value = false
  }
}

function allowDrop(draggingNode: CategoryTreeNode, dropNode: CategoryTreeNode, type: AllowDropType): boolean {
  if (isSubmitting.value) {
    return false
  }
  const targetLevel = type === 'inner' ? dropNode.level + 1 : dropNode.level
  return targetLevel + categorySubtreeHeight(draggingNode.data) - 1 <= 5
}

function allowDrag(): boolean {
  return !isSubmitting.value
}

function categorySubtreeHeight(category: CategoryNode): number {
  return 1 + Math.max(0, ...category.children.map(categorySubtreeHeight))
}

function cloneCategories(categories: CategoryNode[]): CategoryNode[] {
  return categories.map((category) => ({
    ...category,
    children: cloneCategories(category.children),
  }))
}

function findCategory(categories: CategoryNode[], id: string): CategoryNode | undefined {
  for (const category of categories) {
    if (category.id === id) {
      return category
    }
    const child = findCategory(category.children, id)
    if (child !== undefined) {
      return child
    }
  }
  return undefined
}

function categoryErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return localizeMessage(error.message)
  }
  return t('分类移动失败。')
}

function viewNotes(category: CategoryNode): void {
  void router.push({ name: 'workbench', query: { category: category.id } })
}

function openExport(category: CategoryNode): void {
  selectedCategory.value = category
  isExportDialogVisible.value = true
}

function createNoteFromSidebar(categoryId?: string): void {
  void router.push({ name: 'workbench', query: { create: '1', category: categoryId } })
}

watch(
  () => categoriesStore.categories,
  (categories) => {
    treeData.value = cloneCategories(categories)
    const selectedId = selectedCategory.value?.id
    if (selectedId !== undefined) {
      selectedCategory.value = findCategory(categories, selectedId)
    }
  },
  { immediate: true },
)

onMounted(() => {
  void categoriesStore.load()
})
</script>

<template>
  <ManagementLayout
    :title="t('分类管理')"
    :description="t('最多五级，拖拽调整结构；同级分类名称不可重复。')"
    :categories="categoriesStore.categories"
    @create="createNoteFromSidebar"
  >
    <template #action>
      <el-button type="primary" :icon="Plus" :loading="isSubmitting" @click="addCategory()">{{
        t('新建分类')
      }}</el-button>
    </template>

    <p v-if="categoriesStore.error" class="management-error" role="alert">
      {{ localizeMessage(categoriesStore.error.message) }}
    </p>
    <el-empty
      v-else-if="!categoriesStore.isLoading && categoriesStore.categories.length === 0"
      class="management-empty"
      :description="t('还没有分类')"
    >
      <el-button type="primary" @click="addCategory()">{{ t('新建第一个分类') }}</el-button>
    </el-empty>
    <template v-else>
      <p class="category-notice" role="note">
        <el-icon><WarningFilled /></el-icon>{{ t('调整分类后，系统会校验五级限制、同级名称和循环引用。') }}
      </p>
      <section class="category-workspace">
        <section class="category-tree-panel">
          <header class="category-panel-header">
            <div>
              <h2 class="category-panel-title">{{ t('分类树') }}</h2>
              <p class="category-panel-copy">{{ t('拖拽分类可移动或调整排序') }}</p>
            </div>
            <span class="category-panel-count">{{ categoriesStore.categories.length }}</span>
          </header>
          <el-scrollbar class="category-tree">
            <el-tree
              :data="treeData"
              :props="treeProps"
              node-key="id"
              :draggable="!isSubmitting"
              default-expand-all
              :expand-on-click-node="false"
              :allow-drag="allowDrag"
              :allow-drop="allowDrop"
              @node-click="selectedCategory = $event"
              @node-drop="handleDrop"
            >
              <template #default="{ data }">
                <div class="category-tree-node">
                  <el-icon><Folder /></el-icon>
                  <span class="category-tree-name">{{ data.name }}</span>
                  <small class="category-tree-count">{{ data.noteCount }}</small>
                </div>
              </template>
            </el-tree>
          </el-scrollbar>
        </section>

        <section class="category-detail-panel">
          <template v-if="selectedCategory">
            <p class="category-detail-eyebrow">{{ t('当前分类') }}</p>
            <h2 class="category-detail-title">{{ selectedCategory.name }}</h2>
            <p class="category-detail-path">{{ selectedCategory.path }}</p>
            <dl class="category-detail-stats">
              <div>
                <dt>{{ t('层级') }}</dt>
                <dd>{{ t('第 {value1} 级', { value1: selectedCategory.level }) }}</dd>
              </div>
              <div>
                <dt>{{ t('包含笔记') }}</dt>
                <dd>{{ t('{value1} 篇', { value1: selectedCategory.noteCount }) }}</dd>
              </div>
            </dl>
            <div class="category-detail-actions">
              <el-button type="primary" :icon="View" @click="viewNotes(selectedCategory)">{{
                t('查看笔记')
              }}</el-button>
              <el-button
                :disabled="isSubmitting || selectedCategory.level >= 5"
                :icon="Plus"
                @click="addCategory(selectedCategory)"
                >{{ t('新建子分类') }}</el-button
              >
              <el-button :disabled="isSubmitting" :icon="EditPen" @click="rename(selectedCategory)">{{
                t('重命名')
              }}</el-button>
              <el-button :icon="Download" @click="openExport(selectedCategory)">{{ t('导出') }}</el-button>
            </div>
            <div class="category-danger-zone">
              <div>
                <h3 class="category-danger-title">{{ t('危险操作') }}</h3>
                <p class="category-danger-copy">{{ t('删除前会显示直属内容、子分类和分支笔记数量。') }}</p>
              </div>
              <el-button
                type="danger"
                plain
                :disabled="isSubmitting"
                :icon="Delete"
                @click="remove(selectedCategory)"
                >{{ t('删除分类') }}</el-button
              >
            </div>
          </template>
          <div v-else class="category-detail-empty">
            <el-icon><Folder /></el-icon>
            <p>{{ t('从左侧选择一个分类以查看详情') }}</p>
          </div>
        </section>
      </section>
    </template>
  </ManagementLayout>
  <ExportDialog v-model="isExportDialogVisible" :scope-options="exportScopeOptions" />
</template>

<style scoped lang="scss">
.management-error,
.category-notice,
.category-panel-title,
.category-panel-copy,
.category-detail-eyebrow,
.category-detail-title,
.category-detail-path,
.category-danger-title,
.category-danger-copy,
.category-detail-empty p {
  margin: 0;
}

.management-error {
  color: var(--color-danger);
}

.management-empty {
  min-block-size: 420px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.category-notice {
  display: flex;
  align-items: center;
  min-block-size: 42px;
  gap: var(--space-8);
  padding: 0 var(--space-12);
  border: 1px solid color-mix(in srgb, #b8892d 35%, var(--color-border));
  border-radius: var(--radius-8);
  background: color-mix(in srgb, #b8892d 9%, var(--color-surface));
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.category-notice .el-icon {
  color: #b8892d;
}

.category-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 0.82fr) minmax(0, 1.18fr);
  min-block-size: 480px;
  margin-block-start: 14px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.category-tree-panel,
.category-detail-panel {
  min-block-size: 0;
}

.category-tree-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border-inline-end: 1px solid var(--color-divider);
}

.category-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-12);
  padding: var(--space-16) var(--space-20);
  border-block-end: 1px solid var(--color-divider);
}

.category-panel-title,
.category-detail-title {
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  font-weight: 650;
}

.category-panel-copy,
.category-detail-path,
.category-danger-copy {
  margin-block-start: 4px;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.category-panel-count,
.category-tree-count {
  color: var(--color-text-muted);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.6875rem;
}

.category-tree {
  min-block-size: 0;
  background: transparent;
}

.category-tree :deep(.el-scrollbar__view) {
  padding: var(--space-8);
}

.category-tree :deep(.el-tree) {
  background: transparent;
  color: var(--color-text-primary);
}

.category-tree :deep(.el-tree-node__content) {
  block-size: 34px;
  border-radius: var(--radius-8);
}

.category-tree-node {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  gap: var(--space-8);
  inline-size: 100%;
}

.category-tree-node .el-icon {
  color: var(--color-accent);
  font-size: 0.875rem;
}

.category-tree-name {
  min-inline-size: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-tree-count {
  margin-inline-start: auto;
  padding-inline-end: var(--space-8);
}

.category-detail-panel {
  display: flex;
  flex-direction: column;
  padding: 28px 30px;
}

.category-detail-eyebrow {
  color: var(--color-accent);
  font-size: 0.6875rem;
  font-weight: 650;
}

.category-detail-title {
  margin-block-start: 8px;
  font-size: 1.25rem;
}

.category-detail-path {
  max-inline-size: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-detail-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-12);
  margin: var(--space-24) 0;
}

.category-detail-stats div {
  padding: var(--space-12);
  border-radius: var(--radius-8);
  background: var(--color-sidebar);
}

.category-detail-stats dt {
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

.category-detail-stats dd {
  margin: 5px 0 0;
  color: var(--color-text-primary);
  font-size: 0.875rem;
  font-weight: 650;
}

.category-detail-actions {
  display: flex;
  flex-wrap: wrap;
}

.category-danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
  margin-block-start: auto;
  padding-block-start: var(--space-24);
  border-block-start: 1px solid var(--color-divider);
}

.category-danger-title {
  color: var(--color-danger);
  font-size: 0.8125rem;
}

.category-detail-empty {
  display: grid;
  align-content: center;
  justify-items: center;
  flex: 1;
  gap: var(--space-12);
  color: var(--color-text-muted);
  text-align: center;
}

.category-detail-empty .el-icon {
  display: grid;
  inline-size: 44px;
  block-size: 44px;
  place-items: center;
  border-radius: var(--radius-10);
  background: var(--color-sidebar);
  color: var(--color-accent);
  font-size: 1.25rem;
}

@media (max-width: 960px) {
  .category-workspace {
    grid-template-columns: 1fr;
  }

  .category-tree-panel {
    min-block-size: 250px;
    border-inline-end: 0;
    border-block-end: 1px solid var(--color-divider);
  }
}
</style>

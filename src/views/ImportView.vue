<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { CircleCheck, Close, Document, Folder, Upload, UploadFilled, View, Warning } from '@element-plus/icons-vue'
import { computed, onMounted, shallowRef, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import ManagementLayout from '@/layouts/ManagementLayout.vue'
import { useCategoriesStore } from '@/stores/categories'
import { useImportsStore } from '@/stores/imports'
import { UNCATEGORIZED_CATEGORY_ID } from '@/types/categories'
import type { ImportItem } from '@/types/imports'

const router = useRouter()
const categoriesStore = useCategoriesStore()
const importsStore = useImportsStore()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const isDragging = shallowRef(false)
const statusText = computed<Record<ImportItem['status'], string>>(() => ({
  pending: t('待导入'),
  importing: t('正在导入'),
  succeeded: t('导入成功'),
  failed: t('导入失败'),
}))
const progressText = computed(() => {
  if (importsStore.isImporting)
    return t('已处理 {value1} / {value2} 个文件', {
      value1: importsStore.processedCount,
      value2: importsStore.items.length,
    })
  return t('成功 {value1} 篇，失败 {value2} 篇', {
    value1: importsStore.succeededCount,
    value2: importsStore.failedCount,
  })
})

function chooseFiles(): void {
  if (!importsStore.isImporting) fileInput.value?.click()
}

function selectFiles(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  importsStore.addFiles(Array.from(event.target.files ?? []))
  event.target.value = ''
}

function dropFiles(event: DragEvent): void {
  isDragging.value = false
  if (event.dataTransfer !== null) importsStore.addFiles(Array.from(event.dataTransfer.files))
}

function leaveDropZone(event: DragEvent): void {
  if (
    event.currentTarget instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  )
    return
  isDragging.value = false
}

function openNote(id: string): void {
  void router.push({ name: 'workbench', query: { category: UNCATEGORIZED_CATEGORY_ID, note: id } })
}

function createNote(categoryId?: string): void {
  void router.push({ name: 'workbench', query: { create: '1', category: categoryId } })
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

onMounted(() => {
  void categoriesStore.load()
})
</script>

<template>
  <ManagementLayout
    :title="t('导入笔记')"
    :description="t('将 Markdown 和纯文本文件导入本地笔记。')"
    :categories="categoriesStore.categories"
    @create="createNote"
  >
    <template #action>
      <el-button
        :icon="Folder"
        @click="router.push({ name: 'workbench', query: { category: UNCATEGORIZED_CATEGORY_ID } })"
        >{{ t('查看未分类') }}</el-button
      >
    </template>

    <section class="import-view" :aria-busy="importsStore.isImporting">
      <input
        ref="fileInput"
        class="import-file-input"
        type="file"
        accept=".md,.txt"
        multiple
        :aria-label="t('选择要导入的 MD 或 TXT 文件')"
        :disabled="importsStore.isImporting"
        @change="selectFiles"
      />
      <section
        class="import-picker"
        :class="{ 'import-picker--dragging': isDragging && !importsStore.isImporting }"
        :aria-label="t('笔记文件选择区')"
        @dragover.prevent="isDragging = true"
        @dragleave="leaveDropZone"
        @drop.prevent="dropFiles"
      >
        <div class="import-picker-icon" aria-hidden="true">
          <el-icon><UploadFilled /></el-icon>
        </div>
        <h2>{{ t('把文件变成笔记') }}</h2>
        <p>{{ t('拖入或选择本地文件，可一次导入多篇笔记。') }}</p>
        <el-button type="primary" :icon="Upload" :disabled="importsStore.isImporting" @click="chooseFiles">
          {{ importsStore.items.length > 0 ? t('继续选择文件') : t('选择文件') }}
        </el-button>
        <span class="import-picker-limit">{{
          t('仅支持 Markdown 和 TXT 文件，单个文件不超过 10 MB，每批最多 100 个文件')
        }}</span>
      </section>
      <p v-if="importsStore.selectionError" class="import-error" role="alert">
        {{ importsStore.selectionError }}
      </p>

      <section v-if="importsStore.items.length > 0" class="import-list" :aria-label="t('导入文件列表')">
        <header class="import-list-toolbar">
          <div>
            <h2>
              {{ t('导入列表') }}<span>{{ t('{value1} 个文件', { value1: importsStore.items.length }) }}</span>
            </h2>
            <p v-if="importsStore.processedCount > 0 || importsStore.isImporting" role="status" aria-live="polite">
              {{ progressText }}
            </p>
            <p v-else>{{ t('确认文件后开始导入，同名笔记会分别保留。') }}</p>
          </div>
          <div class="import-list-actions">
            <el-button text :disabled="importsStore.isImporting" @click="importsStore.clear">{{
              t('清空列表')
            }}</el-button>
            <el-button
              v-if="importsStore.failedCount > 0"
              :disabled="importsStore.isImporting"
              @click="importsStore.start(true)"
              >{{ t('重试失败项') }}</el-button
            >
            <el-button
              v-if="importsStore.pendingCount > 0 || importsStore.isImporting"
              type="primary"
              :loading="importsStore.isImporting"
              @click="importsStore.start()"
            >
              {{
                importsStore.isImporting
                  ? t('正在导入')
                  : t('开始导入（{value1}）', { value1: importsStore.pendingCount })
              }}
            </el-button>
          </div>
        </header>
        <progress
          v-if="importsStore.isImporting"
          class="import-progress"
          :value="importsStore.processedCount"
          :max="importsStore.items.length"
          :aria-label="t('导入进度')"
        />
        <div class="import-table-scroll">
          <table class="import-table">
            <thead>
              <tr>
                <th scope="col">{{ t('文件 / 笔记名') }}</th>
                <th scope="col">{{ t('大小') }}</th>
                <th scope="col">{{ t('状态') }}</th>
                <th scope="col">{{ t('操作') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in importsStore.items" :key="item.id">
                <td>
                  <div class="import-file">
                    <el-icon><Document /></el-icon>
                    <div>
                      <strong :title="item.file.name">{{ item.file.name }}</strong
                      ><span :title="item.title">{{ item.title }}</span>
                    </div>
                  </div>
                </td>
                <td class="import-size">{{ formatSize(item.file.size) }}</td>
                <td>
                  <div class="import-status" :class="`import-status--${item.status}`">
                    <el-icon v-if="item.status === 'succeeded'"><CircleCheck /></el-icon
                    ><el-icon v-else-if="item.status === 'failed'"><Warning /></el-icon>{{ statusText[item.status] }}
                  </div>
                  <p v-if="item.error" class="import-item-error">{{ localizeMessage(item.error.message) }}</p>
                </td>
                <td>
                  <el-button
                    v-if="item.noteId"
                    text
                    :icon="View"
                    :disabled="importsStore.isImporting"
                    :aria-label="t('查看笔记 {value1}', { value1: item.title })"
                    @click="openNote(item.noteId)"
                    >{{ t('查看') }}</el-button
                  >
                  <el-button
                    v-else
                    text
                    :icon="Close"
                    :disabled="importsStore.isImporting"
                    :aria-label="t('将 {value1} 移出列表', { value1: item.file.name })"
                    @click="importsStore.removeItem(item.id)"
                    >{{ t('移出') }}</el-button
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </ManagementLayout>
</template>

<style scoped lang="scss">
.import-view {
  display: grid;
  gap: var(--space-20);
}

.import-file-input {
  display: none;
}

.import-picker {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36px var(--space-24);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
  text-align: center;
}

.import-picker--dragging {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.import-picker-icon {
  display: grid;
  place-items: center;
  inline-size: 52px;
  block-size: 52px;
  margin-block-end: var(--space-16);
  border-radius: var(--radius-10);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: 28px;
}

.import-picker h2,
.import-list h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 1rem;
  font-weight: 600;
}

.import-picker p {
  margin: var(--space-12) 0 var(--space-20);
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.import-picker-limit {
  margin-block-start: var(--space-12);
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.import-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.import-list {
  min-inline-size: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.import-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-16);
  padding: var(--space-20);
}

.import-list h2 span {
  margin-inline-start: var(--space-8);
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 400;
}

.import-list-toolbar p {
  margin: var(--space-8) 0 0;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.import-list-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-8);
}

.import-list-actions > * {
  margin: 0;
}

.import-progress {
  display: block;
  inline-size: 100%;
  block-size: 4px;
  border: 0;
  appearance: none;
  background: var(--color-divider);
}

.import-progress::-webkit-progress-bar {
  background: var(--color-divider);
}

.import-progress::-webkit-progress-value {
  background: var(--color-accent);
}

.import-progress::-moz-progress-bar {
  background: var(--color-accent);
}

.import-table-scroll {
  overflow-x: auto;
}

.import-table {
  inline-size: 100%;
  border-collapse: collapse;
  text-align: start;
  font-size: 0.8125rem;
}

.import-table th,
.import-table td {
  padding: var(--space-16) var(--space-20);
  border-block-start: 1px solid var(--color-divider);
  text-align: start;
}

.import-table th {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 500;
}

.import-table th:first-child {
  inline-size: 44%;
}

.import-table td:last-child,
.import-table th:last-child {
  text-align: end;
  white-space: nowrap;
}

.import-file {
  display: flex;
  align-items: center;
  gap: var(--space-12);
}

.import-file > .el-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 20px;
}

.import-file div {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
  overflow-wrap: anywhere;
}

.import-file strong {
  font-weight: 500;
}

.import-file span,
.import-size {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.import-size,
.import-status {
  white-space: nowrap;
}

.import-status {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.import-status--succeeded {
  color: var(--color-success);
}

.import-status--failed,
.import-error,
.import-item-error {
  color: var(--color-danger);
}

.import-status--importing {
  color: var(--color-accent);
}

.import-error {
  margin: 0;
  font-size: 0.8125rem;
}

.import-item-error {
  max-inline-size: 260px;
  margin: 6px 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .import-table th,
  .import-table td {
    padding-inline: var(--space-12);
  }
}
</style>

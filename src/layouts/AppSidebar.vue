<script setup lang="ts">
import { t } from '@/i18n'
import { Delete, Document, Folder, MoreFilled, Plus, PriceTag, Search, Setting, Upload } from '@element-plus/icons-vue'
import { computed, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import noteXIcon from '@/assets/notex-icon.svg'
import { UNCATEGORIZED_CATEGORY_ID, type CategoryNode } from '@/types/categories'
import { NOTE_DRAG_TYPE } from '@/types/notes'

const props = defineProps<{
  categories: CategoryNode[]
  tagCount?: number
  trashCount?: number
  noteDropEnabled?: boolean
}>()

const emit = defineEmits<{
  create: [categoryId?: string]
  moveNote: [noteId: string, categoryId: string | undefined]
}>()

const dropTargetId = shallowRef<string>()
const isMac = navigator.userAgent.includes('Mac')
const createShortcutLabel = isMac ? '⌘ N' : 'Ctrl + N'
const createShortcutKeys = isMac ? 'Meta+N' : 'Control+N'
watch(
  () => props.noteDropEnabled,
  (enabled) => {
    if (!enabled) dropTargetId.value = undefined
  },
)

function acceptsNote(event: DragEvent): boolean {
  return props.noteDropEnabled === true && event.dataTransfer?.types.includes(NOTE_DRAG_TYPE) === true
}

function dragOverCategory(event: DragEvent, categoryId: string): void {
  if (!acceptsNote(event) || event.dataTransfer === null) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dropTargetId.value = categoryId
}

function leaveCategory(event: DragEvent): void {
  if (
    event.currentTarget instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  ) {
    return
  }
  dropTargetId.value = undefined
}

function dropNote(event: DragEvent, categoryId?: string): void {
  dropTargetId.value = undefined
  if (!acceptsNote(event)) return
  event.preventDefault()
  const noteId = event.dataTransfer?.getData(NOTE_DRAG_TYPE).trim()
  if (noteId) emit('moveNote', noteId, categoryId)
}

const route = useRoute()
const activeRouteName = computed(() => route.name)
const activeCategoryId = computed(() => (typeof route.query.category === 'string' ? route.query.category : undefined))
const visibleCategories = computed(() => flattenCategories(props.categories))
function isActive(name: 'workbench' | 'categories' | 'tags' | 'trash' | 'search' | 'imports' | 'settings'): boolean {
  if (name === 'workbench') {
    return activeRouteName.value === name && activeCategoryId.value === undefined
  }
  return activeRouteName.value === name
}

function isCategoryActive(categoryId: string): boolean {
  return activeRouteName.value === 'workbench' && activeCategoryId.value === categoryId
}

function isUncategorizedActive(): boolean {
  return isCategoryActive(UNCATEGORIZED_CATEGORY_ID)
}

function categoryIndent(category: CategoryNode): { paddingInlineStart: string } {
  return { paddingInlineStart: `${8 + (category.level - 1) * 14}px` }
}

function flattenCategories(categories: CategoryNode[]): CategoryNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)])
}
</script>

<template>
  <div class="app-sidebar">
    <div class="sidebar-brand-group">
      <RouterLink class="sidebar-brand" to="/">
        <img class="sidebar-brand-mark" :src="noteXIcon" alt="" />
        <span>
          <strong class="sidebar-brand-name">NoteX</strong>
        </span>
      </RouterLink>
      <el-button
        class="sidebar-create-button"
        :icon="Plus"
        type="primary"
        :aria-label="t('新建笔记')"
        :aria-keyshortcuts="createShortcutKeys"
        :title="t('新建笔记（{value1}）', { value1: createShortcutLabel })"
        @click="emit('create')"
      >
        <span>{{ t('新建笔记') }}</span>
        <kbd class="sidebar-create-shortcut">{{ createShortcutLabel }}</kbd>
      </el-button>
    </div>

    <nav class="sidebar-nav">
      <RouterLink class="sidebar-nav-item" :class="{ 'sidebar-nav-item--active': isActive('workbench') }" to="/">
        <el-icon><Document /></el-icon>
        <span>{{ t('全部笔记') }}</span>
      </RouterLink>
      <RouterLink class="sidebar-nav-item" :class="{ 'sidebar-nav-item--active': isActive('search') }" to="/search">
        <el-icon><Search /></el-icon>
        <span>{{ t('全局搜索') }}</span>
      </RouterLink>
      <RouterLink class="sidebar-nav-item" :class="{ 'sidebar-nav-item--active': isActive('tags') }" to="/tags">
        <el-icon><PriceTag /></el-icon>
        <span>{{ t('标签') }}</span>
      </RouterLink>
      <RouterLink
        class="sidebar-nav-item"
        :class="{ 'sidebar-nav-item--active': isActive('imports') }"
        to="/imports"
        :title="t('导入笔记')"
      >
        <el-icon><Upload /></el-icon>
        <span>{{ t('导入笔记') }}</span>
      </RouterLink>
      <RouterLink class="sidebar-nav-item" :class="{ 'sidebar-nav-item--active': isActive('trash') }" to="/trash">
        <el-icon><Delete /></el-icon>
        <span>{{ t('回收站') }}</span>
        <small v-if="trashCount !== undefined" class="sidebar-nav-count">{{ trashCount }}</small>
      </RouterLink>
    </nav>

    <section class="sidebar-categories">
      <div class="sidebar-categories-heading">
        <span>{{ t('分类') }}</span>
        <RouterLink
          class="sidebar-categories-manage"
          :class="{ 'sidebar-categories-manage--active': isActive('categories') }"
          to="/categories"
        >
          <el-icon><MoreFilled /></el-icon>
        </RouterLink>
      </div>
      <el-scrollbar class="sidebar-category-tree">
        <RouterLink
          class="sidebar-category-item"
          :class="{
            'sidebar-category-item--active': isUncategorizedActive(),
            'sidebar-category-item--drop-target': dropTargetId === UNCATEGORIZED_CATEGORY_ID,
          }"
          :to="{ name: 'workbench', query: { category: UNCATEGORIZED_CATEGORY_ID } }"
          draggable="false"
          :title="t('未分类')"
          @dragenter="dragOverCategory($event, UNCATEGORIZED_CATEGORY_ID)"
          @dragover="dragOverCategory($event, UNCATEGORIZED_CATEGORY_ID)"
          @dragleave="leaveCategory"
          @drop.stop="dropNote($event)"
        >
          <el-icon><Folder /></el-icon>
          <span class="sidebar-category-name">{{ t('未分类') }}</span>
        </RouterLink>
        <div
          v-for="category in visibleCategories"
          :key="category.id"
          class="sidebar-category-row"
          :class="{
            'sidebar-category-item--active': isCategoryActive(category.id),
            'sidebar-category-item--drop-target': dropTargetId === category.id,
          }"
          @dragenter="dragOverCategory($event, category.id)"
          @dragover="dragOverCategory($event, category.id)"
          @dragleave="leaveCategory"
          @drop.stop="dropNote($event, category.id)"
        >
          <RouterLink
            class="sidebar-category-item"
            :style="categoryIndent(category)"
            :to="{ name: 'workbench', query: { category: category.id } }"
            :title="category.path"
            draggable="false"
          >
            <el-icon><Folder /></el-icon>
            <span class="sidebar-category-name">{{ category.name }}</span>
          </RouterLink>
          <el-button
            class="sidebar-category-create"
            :icon="Plus"
            text
            :aria-label="t('在{value1}下新建笔记', { value1: category.name })"
            :title="t('在{value1}下新建笔记', { value1: category.name })"
            @click="emit('create', category.id)"
          />
        </div>
      </el-scrollbar>
    </section>

    <RouterLink
      class="sidebar-nav-item sidebar-settings-item"
      :class="{ 'sidebar-nav-item--active': isActive('settings') }"
      to="/settings"
    >
      <el-icon><Setting /></el-icon>
      <span>{{ t('设置') }}</span>
    </RouterLink>
  </div>
</template>

<style scoped lang="scss">
.app-sidebar {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 18px;
  block-size: 100%;
  min-block-size: 0;
  padding: 18px 14px;
  overflow: hidden;
  background: var(--color-sidebar);
}

.sidebar-brand-group {
  display: grid;
  gap: 14px;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: inherit;
  text-decoration: none;
}

.sidebar-brand-mark {
  display: block;
  inline-size: 30px;
  block-size: 30px;
  border-radius: var(--radius-8);
}

.sidebar-brand-name {
  display: block;
}

.sidebar-brand-name {
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  line-height: 1.2;
}

.sidebar-create-button {
  inline-size: 100%;
  block-size: 36px;
  font-size: 0.8125rem;
  font-weight: 600;
}

.sidebar-create-shortcut {
  margin-inline-start: 12px;
  font-family: inherit;
  font-size: 0.6875rem;
  font-weight: 400;
  opacity: 0.8;
}

.sidebar-nav {
  display: grid;
  gap: 4px;
}

.sidebar-nav-item,
.sidebar-category-item {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  min-block-size: 36px;
  gap: 10px;
  padding: 0 10px;
  border-radius: var(--radius-8);
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  text-decoration: none;
}

.sidebar-category-row {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  border-radius: var(--radius-8);
}

.sidebar-category-row .sidebar-category-item {
  flex: 1;
}

.sidebar-category-create {
  flex: 0 0 auto;
  inline-size: 24px;
  block-size: 24px;
  margin-inline-end: 4px;
  padding: 0;
  opacity: 0;
  pointer-events: none;
}

.sidebar-category-row:hover .sidebar-category-create,
.sidebar-category-row:focus-within .sidebar-category-create {
  opacity: 1;
  pointer-events: auto;
}

@media (hover: none) {
  .sidebar-category-create {
    opacity: 1;
    pointer-events: auto;
  }
}

.sidebar-nav-item .el-icon,
.sidebar-category-item .el-icon {
  flex: 0 0 auto;
  font-size: 1rem;
}

.sidebar-nav-item--active {
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-weight: 650;
}

.sidebar-nav-item:hover,
.sidebar-category-item:hover,
.sidebar-category-row:hover {
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
}

.sidebar-settings-item {
  align-self: end;
}

.sidebar-nav-count {
  margin-inline-start: auto;
  color: var(--color-text-muted);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.625rem;
  font-weight: 400;
}

.sidebar-categories {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-block-size: 0;
  gap: 6px;
}

.sidebar-categories-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-block-size: 30px;
  padding-inline: 8px;
  border-radius: var(--radius-8);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: 0.75rem;
  font-weight: 650;
}

.sidebar-categories-manage {
  display: grid;
  place-items: center;
  color: var(--color-text-secondary);
}

.sidebar-categories-manage .el-icon {
  font-size: 0.875rem;
}

.sidebar-categories-manage--active {
  color: var(--color-accent-active);
}

.sidebar-category-tree {
  min-block-size: 0;
}

.sidebar-category-tree :deep(.el-scrollbar__view) {
  display: grid;
  align-content: start;
  gap: 4px;
}

.sidebar-category-item {
  min-block-size: 30px;
  gap: 8px;
  font-size: 0.75rem;
}

.sidebar-category-item .el-icon {
  font-size: 0.875rem;
}

.sidebar-category-item--active {
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-weight: 650;
}

.sidebar-category-item--drop-target,
.sidebar-category-item--drop-target:hover {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.sidebar-category-name {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .app-sidebar {
    padding-inline: var(--space-8);
  }

  .sidebar-brand {
    justify-content: center;
  }

  .sidebar-brand > span:last-child,
  .sidebar-create-button > :not(.el-icon),
  .sidebar-nav-item > span,
  .sidebar-nav-count,
  .sidebar-categories-heading > span,
  .sidebar-category-name {
    display: none;
  }

  .sidebar-create-button {
    padding-inline: 0;
  }

  .sidebar-nav-item,
  .sidebar-category-item {
    justify-content: center;
    padding-inline: 0;
  }

  .sidebar-category-item {
    padding-inline-start: 0 !important;
  }

  .sidebar-categories-heading {
    justify-content: center;
  }
}
</style>

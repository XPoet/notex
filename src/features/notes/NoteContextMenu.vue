<script setup lang="ts">
import { Delete, Star, StarFilled } from '@element-plus/icons-vue'
import { ElDropdownItem } from 'element-plus'
import ContextMenu from '@/components/ContextMenu.vue'
import { t } from '@/i18n'

defineProps<{ x: number; y: number; isPinned: boolean }>()
const emit = defineEmits<{
  split: [direction: 'right' | 'down']
  togglePin: []
  trash: []
  close: [restoreFocus?: boolean]
}>()
</script>

<template>
  <ContextMenu :x="x" :y="y" :label="t('笔记操作')" @close="emit('close', $event)">
    <ElDropdownItem @click="emit('split', 'right')">
      <svg class="context-menu-split-icon" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
        <path d="M10 3.5v13M13 8l2 2-2 2m-1-2h3" />
      </svg>
      <span>{{ t('向右拆分') }}</span>
    </ElDropdownItem>
    <ElDropdownItem @click="emit('split', 'down')">
      <svg class="context-menu-split-icon" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
        <path d="M2.5 10h15M8 13l2 2 2-2m-2-1v3" />
      </svg>
      <span>{{ t('向下拆分') }}</span>
    </ElDropdownItem>
    <ElDropdownItem :icon="isPinned ? StarFilled : Star" @click="emit('togglePin')">
      {{ isPinned ? t('取消收藏') : t('收藏笔记') }}
    </ElDropdownItem>
    <ElDropdownItem class="context-menu-item--danger" :icon="Delete" @click="emit('trash')">
      {{ t('删除笔记') }}
    </ElDropdownItem>
  </ContextMenu>
</template>

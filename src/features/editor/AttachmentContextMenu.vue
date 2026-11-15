<script setup lang="ts">
import { Delete, Download, FolderOpened, TopRight } from '@element-plus/icons-vue'
import { ElDropdownItem } from 'element-plus'
import ContextMenu from '@/components/ContextMenu.vue'
import { t } from '@/i18n'

defineProps<{ x: number; y: number }>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  action: [action: 'open' | 'reveal' | 'saveAs' | 'remove']
}>()
</script>

<template>
  <ContextMenu class="attachment-context-menu" :x="x" :y="y" :label="t('附件操作')" @close="emit('close', $event)">
    <ElDropdownItem :icon="TopRight" @click="emit('action', 'open')">{{ t('用默认应用打开') }}</ElDropdownItem>
    <ElDropdownItem :icon="FolderOpened" @click="emit('action', 'reveal')">{{
      t('在文件管理器中显示')
    }}</ElDropdownItem>
    <ElDropdownItem :icon="Download" @click="emit('action', 'saveAs')">{{ t('另存为') }}</ElDropdownItem>
    <ElDropdownItem class="context-menu-item--danger" :icon="Delete" @click="emit('action', 'remove')">
      {{ t('从笔记中移除') }}
    </ElDropdownItem>
  </ContextMenu>
</template>

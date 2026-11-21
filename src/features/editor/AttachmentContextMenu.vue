<script setup lang="ts">
import { CopyDocument, Delete, Download, FolderOpened, TopRight } from '@element-plus/icons-vue'
import { ElDropdownItem } from 'element-plus'
import ContextMenu from '@/components/ContextMenu.vue'
import { t } from '@/i18n'
import type { AttachmentContextAction } from '@/types/assets'

defineProps<{ x: number; y: number; canCopy: boolean }>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  action: [action: AttachmentContextAction]
}>()
</script>

<template>
  <ContextMenu :x="x" :y="y" :label="t('附件操作')" @close="emit('close', $event)">
    <ElDropdownItem :icon="TopRight" @click="emit('action', 'open')">{{ t('用默认应用打开') }}</ElDropdownItem>
    <ElDropdownItem :icon="FolderOpened" @click="emit('action', 'reveal')">{{
      t('在文件管理器中显示')
    }}</ElDropdownItem>
    <ElDropdownItem v-if="canCopy" :icon="CopyDocument" @click="emit('action', 'copy')">{{ t('复制') }}</ElDropdownItem>
    <ElDropdownItem :icon="Download" @click="emit('action', 'saveAs')">{{ t('另存为') }}</ElDropdownItem>
    <ElDropdownItem class="context-menu-item--danger" :icon="Delete" @click="emit('action', 'remove')">
      {{ t('从笔记中移除') }}
    </ElDropdownItem>
  </ContextMenu>
</template>

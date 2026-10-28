<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { computed } from 'vue'
import type { SaveStatus as SaveStatusType } from '@/stores/notes'

const props = defineProps<{
  status: SaveStatusType
  message?: string
}>()

const label = computed(() => {
  if (props.status === 'saving') return t('保存中…')
  if (props.status === 'saved') return t('已保存')
  if (props.status === 'failed') return localizeMessage(props.message) ?? t('保存失败，请重试')
  return t('正在编辑')
})
</script>

<template>
  <p class="save-status" :class="`save-status--${status}`" role="status">{{ label }}</p>
</template>

<style scoped lang="scss">
.save-status {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.6rem;
}

.save-status--failed {
  color: var(--color-danger);
}

.save-status--saved {
  color: var(--el-color-success);
}
</style>

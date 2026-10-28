<script setup lang="ts">
import { t } from '@/i18n'
import { Folder } from '@element-plus/icons-vue'

defineProps<{
  directory?: string
  isChoosing: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  choose: []
}>()
</script>

<template>
  <button class="export-directory-picker" type="button" :disabled="isChoosing || disabled" @click="emit('choose')">
    <el-icon class="export-directory-picker-icon"><Folder /></el-icon>
    <span class="export-directory-picker-path">{{ directory ?? t('尚未选择导出目录') }}</span>
    <span class="export-directory-picker-action">
      {{ isChoosing ? t('正在打开…') : t('选择…') }}
    </span>
  </button>
</template>

<style scoped lang="scss">
.export-directory-picker {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  inline-size: 100%;
  min-inline-size: 0;
  min-block-size: 42px;
  padding: 0 var(--space-12);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-8);
  background: var(--color-canvas);
  color: var(--color-text-secondary);
  cursor: pointer;
  text-align: start;
}

.export-directory-picker:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-accent) 58%, var(--color-border));
}

.export-directory-picker:disabled {
  cursor: wait;
}

.export-directory-picker-icon {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-size: 1rem;
}

.export-directory-picker-path {
  min-inline-size: 0;
  overflow: hidden;
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.6875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.export-directory-picker-action {
  flex: 0 0 auto;
  margin-inline-start: auto;
  color: var(--color-accent-active);
  font-size: 0.75rem;
  font-weight: 650;
}
</style>

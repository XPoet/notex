<script setup lang="ts">
import { t } from '@/i18n'
import { Search } from '@element-plus/icons-vue'

defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  clear: []
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <el-input
    :model-value="modelValue"
    class="search-input"
    clearable
    :placeholder="t('搜索标题、正文、分类或标签')"
    @clear="emit('clear')"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #prefix>
      <el-icon><Search /></el-icon>
    </template>
  </el-input>
</template>

<style scoped lang="scss">
.search-input :deep(.el-input__wrapper) {
  min-block-size: 38px;
  background: var(--color-surface);
}
</style>

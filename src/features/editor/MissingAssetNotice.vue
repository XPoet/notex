<script setup lang="ts">
import { t } from '@/i18n'
defineProps<{
  missingAssetCount: number
}>()
</script>

<template>
  <aside v-if="missingAssetCount > 0" class="missing-asset-notice" role="alert">
    {{
      t('有 {value1} 个本地图片资源缺失。原 Markdown 引用已保留，可在恢复文件后继续使用。', {
        value1: missingAssetCount,
      })
    }}
  </aside>
</template>

<style scoped lang="scss">
.missing-asset-notice {
  margin: 0;
  padding: var(--space-12);
  border: 1px solid color-mix(in srgb, var(--color-danger) 36%, var(--color-border));
  border-radius: var(--radius-8);
  background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}
</style>

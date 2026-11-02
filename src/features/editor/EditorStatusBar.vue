<script setup lang="ts">
import { t } from '@/i18n'
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import SaveStatus from './SaveStatus.vue'
import { countContent } from './contentStatistics'
import type { SaveStatus as SaveStatusType } from '@/stores/notes'

const props = defineProps<{
  content: string
  saveStatus: SaveStatusType
  saveError?: string
}>()

const emit = defineEmits<{
  retry: []
}>()

const statistics = shallowRef(countContent(props.content))
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.content,
  () => {
    // Trailing throttle: continuous typing still updates at most every 200 ms.
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      statistics.value = countContent(props.content)
    }, 200)
  },
)
onBeforeUnmount(() => {
  if (timer !== undefined) clearTimeout(timer)
})
</script>

<template>
  <footer class="editor-status-bar">
    <div class="editor-status-bar__statistics">
      <span>{{ t('字数 {value1}', { value1: statistics.words }) }}</span>
      <span>{{ t('字符 {value1}', { value1: statistics.characters }) }}</span>
      <span>{{ t('行 {value1}', { value1: statistics.lines }) }}</span>
    </div>
    <div class="editor-status-bar__save-state">
      <SaveStatus :status="saveStatus" :message="saveError" />
      <el-button v-if="saveStatus === 'failed'" text type="primary" @click="emit('retry')">{{ t('重试') }}</el-button>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.editor-status-bar,
.editor-status-bar__statistics,
.editor-status-bar__save-state {
  display: flex;
  align-items: center;
}

.editor-status-bar {
  justify-content: space-between;
  min-inline-size: 0;
  min-block-size: 34px;
  gap: var(--space-16);
  padding: 0 var(--space-24);
  border-block-start: 1px solid var(--color-divider);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.625rem;
}

.editor-status-bar__statistics {
  min-inline-size: 0;
  gap: var(--space-12);
  overflow: hidden;
  white-space: nowrap;
}

.editor-status-bar__save-state {
  flex: 0 0 auto;
  gap: var(--space-8);
}
</style>

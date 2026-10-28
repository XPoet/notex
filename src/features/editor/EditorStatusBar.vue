<script setup lang="ts">
import { t } from '@/i18n'
import { computed } from 'vue'
import SaveStatus from './SaveStatus.vue'
import type { SaveStatus as SaveStatusType } from '@/stores/notes'

const props = defineProps<{
  content: string
  saveStatus: SaveStatusType
  saveError?: string
}>()

const emit = defineEmits<{
  retry: []
}>()

const wordCount = computed(() => countWords(props.content))
const characterCount = computed(() => Array.from(props.content.replace(/\s/g, '')).length)
const lineCount = computed(() => (props.content === '' ? 1 : props.content.split(/\r\n|\r|\n/).length))

function countWords(content: string): number {
  const cjkCharacterCount = (content.match(/[\u3400-\u9fff]/g) ?? []).length
  const latinWordCount = content.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+/g)?.length ?? 0

  return cjkCharacterCount + latinWordCount
}
</script>

<template>
  <footer class="editor-status-bar">
    <div class="editor-status-bar__statistics">
      <span>{{ t('字数 {value1}', { value1: wordCount }) }}</span>
      <span>{{ t('字符 {value1}', { value1: characterCount }) }}</span>
      <span>{{ t('行 {value1}', { value1: lineCount }) }}</span>
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

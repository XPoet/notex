<script setup lang="ts">
import { t } from '@/i18n'
import type { NoteLayoutNode, NotePane } from './splitLayout'

defineProps<{
  node: NoteLayoutNode
  activePaneId: string
}>()

const emit = defineEmits<{
  activate: [paneId: string]
  close: [paneId: string]
}>()

defineSlots<{
  default(props: { pane: NotePane; active: boolean }): unknown
}>()
</script>

<template>
  <section
    v-if="node.kind === 'pane'"
    class="note-split-pane"
    :class="{ 'note-split-pane--active': node.id === activePaneId }"
    :data-pane-id="node.id"
    :aria-label="t('笔记分栏')"
    @pointerdown.capture="emit('activate', node.id)"
    @focusin.capture="emit('activate', node.id)"
  >
    <slot :pane="node" :active="node.id === activePaneId" />
  </section>
  <el-splitter v-else class="note-split-layout" :layout="node.direction === 'right' ? 'horizontal' : 'vertical'">
    <el-splitter-panel v-for="child in node.children" :key="child.id" min="10%">
      <NoteSplitLayout
        :node="child"
        :active-pane-id="activePaneId"
        @activate="emit('activate', $event)"
        @close="emit('close', $event)"
      >
        <template #default="slotProps">
          <slot v-bind="slotProps" />
        </template>
      </NoteSplitLayout>
    </el-splitter-panel>
  </el-splitter>
</template>

<style scoped lang="scss">
.note-split-layout,
.note-split-pane {
  inline-size: 100%;
  block-size: 100%;
  min-inline-size: 0;
  min-block-size: 0;
  overflow: hidden;
}

.note-split-pane {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
}
</style>

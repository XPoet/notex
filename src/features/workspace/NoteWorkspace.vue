<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import NoteSplitLayout from './NoteSplitLayout.vue'
import { collectPanes } from './splitLayout'
import type { NoteLayoutNode, NotePane } from './splitLayout'

const props = defineProps<{
  node: NoteLayoutNode
  activePaneId: string
}>()
const emit = defineEmits<{
  activate: [paneId: string]
}>()
defineSlots<{
  default(props: { pane: NotePane; active: boolean }): unknown
}>()

const panes = computed(() => collectPanes(props.node))
const targets = shallowRef(new Map<string, Element>())
interface ScrollPosition {
  element: HTMLElement
  top: number
  left: number
}
const pendingScroll = new Map<string, ScrollPosition[]>()
const restoreFrames = new Set<number>()

function cancelScrollRestore(): void {
  pendingScroll.clear()
  for (const frame of restoreFrames) cancelAnimationFrame(frame)
  restoreFrames.clear()
}

function afterFrame(callback: () => void): void {
  const frame = requestAnimationFrame(() => {
    restoreFrames.delete(frame)
    callback()
  })
  restoreFrames.add(frame)
}

function restoreScroll(paneId: string, target: Element, positions: ScrollPosition[]): boolean {
  if (targets.value.get(paneId) !== target || pendingScroll.get(paneId) !== positions) return false
  for (const { element, top, left } of positions) {
    if (!target.contains(element)) continue
    element.scrollTop = top
    element.scrollLeft = left
  }
  return true
}

watch(
  () => props.node,
  () => {
    // 捕获旧布局尚未移除时的滚动位置；DOM 移动后浏览器可能将位置重置。
    cancelScrollRestore()
    for (const [id, target] of targets.value) {
      pendingScroll.set(
        id,
        [...target.querySelectorAll<HTMLElement>('.cm-scroller')].map((element) => ({
          element,
          top: element.scrollTop,
          left: element.scrollLeft,
        })),
      )
    }
  },
)

function setTarget(paneId: string, target: Element | ComponentPublicInstance | null): void {
  // 旧布局卸载时的 null ref 可能晚于新 host 注册，不得覆盖新目标。
  if (!(target instanceof Element) || targets.value.get(paneId) === target) return
  const next = new Map(targets.value)
  next.set(paneId, target)
  targets.value = next
  const positions = pendingScroll.get(paneId)
  if (positions === undefined) return
  void nextTick(() => {
    if (!restoreScroll(paneId, target, positions)) return
    // 新 Splitter 的尺寸和 CodeMirror 测量晚于 Vue 更新；布局稳定后再次恢复。
    afterFrame(() => {
      if (targets.value.get(paneId) !== target || pendingScroll.get(paneId) !== positions) return
      afterFrame(() => {
        restoreScroll(paneId, target, positions)
        if (pendingScroll.get(paneId) === positions) pendingScroll.delete(paneId)
      })
    })
  })
}

watch(panes, (current) => {
  const ids = new Set(current.map((pane) => pane.id))
  const next = new Map([...targets.value].filter(([id]) => ids.has(id)))
  if (next.size !== targets.value.size) targets.value = next
  for (const id of pendingScroll.keys()) if (!ids.has(id)) pendingScroll.delete(id)
})
onBeforeUnmount(cancelScrollRestore)
</script>

<template>
  <div
    class="note-workspace"
    @wheel.capture.passive="cancelScrollRestore"
    @touchstart.capture.passive="cancelScrollRestore"
    @pointerdown.capture="cancelScrollRestore"
    @keydown.capture="cancelScrollRestore"
  >
    <NoteSplitLayout :node="node" :active-pane-id="activePaneId" @activate="emit('activate', $event)">
      <template #default="{ pane }">
        <div :ref="(target) => setTarget(pane.id, target)" class="note-workspace-host" />
      </template>
    </NoteSplitLayout>
    <div class="note-workspace-staging">
      <Teleport
        v-for="pane in panes"
        :key="pane.id"
        :to="targets.get(pane.id) ?? 'body'"
        :disabled="!targets.has(pane.id)"
      >
        <slot :pane="pane" :active="pane.id === activePaneId" />
      </Teleport>
    </div>
  </div>
</template>

<style scoped lang="scss">
.note-workspace,
.note-workspace-host {
  inline-size: 100%;
  block-size: 100%;
  min-inline-size: 0;
  min-block-size: 0;
  overflow: hidden;
}

.note-workspace-host {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
}

.note-workspace-staging {
  display: none;
}
</style>

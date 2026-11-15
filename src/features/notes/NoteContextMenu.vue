<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue'
import { t } from '@/i18n'

const props = defineProps<{ x: number; y: number }>()
const emit = defineEmits<{
  split: [direction: 'right' | 'down']
  close: [restoreFocus?: boolean]
}>()
const menu = useTemplateRef<HTMLDivElement>('menu')
const position = shallowRef({ x: props.x, y: props.y })

function dismiss(event: PointerEvent): void {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return
  emit('close')
}

function dismissOnBlur(): void {
  emit('close')
}

function handleKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close', true)
    return
  }
  if (event.key === 'Tab') {
    emit('close')
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
  const current = items.findIndex((item) => item === document.activeElement)
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[index]?.focus()
}

onMounted(async () => {
  await nextTick()
  if (menu.value === null) return
  const bounds = menu.value?.getBoundingClientRect()
  const margin = 8
  position.value = {
    x: Math.max(margin, Math.min(props.x, window.innerWidth - (bounds?.width ?? 184) - margin)),
    y: Math.max(margin, Math.min(props.y, window.innerHeight - (bounds?.height ?? 84) - margin)),
  }
  menu.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  window.addEventListener('pointerdown', dismiss)
  window.addEventListener('blur', dismissOnBlur)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', dismiss)
  window.removeEventListener('blur', dismissOnBlur)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="note-context-menu"
      role="menu"
      :aria-label="t('笔记分栏')"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @keydown="handleKey"
      @contextmenu.prevent
    >
      <button type="button" role="menuitem" @click="emit('split', 'right')">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
          <path d="M10 3.5v13M13 8l2 2-2 2m-1-2h3" />
        </svg>
        <span>{{ t('向右拆分') }}</span>
      </button>
      <button type="button" role="menuitem" @click="emit('split', 'down')">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
          <path d="M2.5 10h15M8 13l2 2 2-2m-2-1v3" />
        </svg>
        <span>{{ t('向下拆分') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.note-context-menu {
  position: fixed;
  z-index: 2100;
  display: grid;
  gap: var(--space-4);
  min-inline-size: 184px;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-8);
  background: var(--color-surface);
  box-shadow: var(--shadow-floating);
}

.note-context-menu button {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12);
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: start;
  cursor: pointer;
}

.note-context-menu button:hover,
.note-context-menu button:focus-visible {
  outline: none;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.note-context-menu svg {
  inline-size: 18px;
  block-size: 18px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.25;
}
</style>

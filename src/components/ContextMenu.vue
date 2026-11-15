<script setup lang="ts">
import { ElDropdown, ElDropdownMenu } from 'element-plus'
import type { DropdownInstance } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, useId, useTemplateRef } from 'vue'

const props = defineProps<{ x: number; y: number; label: string }>()
const emit = defineEmits<{ close: [restoreFocus?: boolean] }>()
const dropdown = useTemplateRef<DropdownInstance>('dropdown')
const menu = useTemplateRef<HTMLDivElement>('menu')
const menuId = useId()
const virtualElement = computed(() => ({ getBoundingClientRect: () => new DOMRect(props.x, props.y, 0, 0) }))
const popperOptions: DropdownInstance['$props']['popperOptions'] = {
  strategy: 'fixed',
  modifiers: [
    { name: 'offset', options: { offset: [0, 0] } },
    { name: 'preventOverflow', options: { padding: 8 } },
  ],
}

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
  } else if (event.key === 'Tab') {
    emit('close')
  }
}

function focusFirstItem(event?: FocusEvent): void {
  if (event !== undefined && (!(event.target instanceof Element) || event.target.getAttribute('role') !== 'menu'))
    return
  menu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
}

async function handleVisibilityChange(visible: boolean): Promise<void> {
  if (!visible) {
    emit('close')
    return
  }
  await nextTick()
  focusFirstItem()
}

onMounted(async () => {
  await nextTick()
  if (dropdown.value === null) return
  dropdown.value?.handleOpen()
  window.addEventListener('pointerdown', dismiss)
  window.addEventListener('blur', dismissOnBlur)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', dismiss)
  window.removeEventListener('blur', dismissOnBlur)
})
</script>

<template>
  <ElDropdown
    ref="dropdown"
    :id="menuId"
    :tabindex="-1"
    :virtual-ref="virtualElement"
    virtual-triggering
    trigger="contextmenu"
    placement="bottom-start"
    :show-arrow="false"
    :persistent="false"
    :popper-options="popperOptions"
    popper-class="context-menu-popper"
    @visible-change="handleVisibilityChange"
  >
    <template #dropdown>
      <div ref="menu" @focus.capture="focusFirstItem" @keydown.capture="handleKey" @contextmenu.prevent>
        <span :id="menuId" hidden>{{ label }}</span>
        <ElDropdownMenu>
          <slot />
        </ElDropdownMenu>
      </div>
    </template>
  </ElDropdown>
</template>

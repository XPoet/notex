<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { t } from '@/i18n'

const props = defineProps<{ visible: boolean; x: number; y: number }>()
const emit = defineEmits<{
  close: []
  action: [action: 'open' | 'reveal' | 'saveAs' | 'remove']
}>()
const virtualElement = computed(() => ({ getBoundingClientRect: () => new DOMRect(props.x, props.y, 0, 0) }))

function dismiss(event: Event): void {
  if (event instanceof KeyboardEvent) {
    if (event.key === 'Escape') emit('close')
  } else if (!(event.target instanceof Element) || event.target.closest('.attachment-context-menu') === null) {
    emit('close')
  }
}
onMounted(() => {
  window.addEventListener('pointerdown', dismiss)
  window.addEventListener('keydown', dismiss)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', dismiss)
  window.removeEventListener('keydown', dismiss)
})
</script>

<template>
  <el-popover
    :visible="visible"
    :virtual-ref="virtualElement"
    virtual-triggering
    placement="bottom-start"
    :width="190"
    :show-arrow="false"
    :teleported="true"
  >
    <div class="attachment-context-menu" role="menu" :aria-label="t('附件操作')">
      <el-button text role="menuitem" @click="emit('action', 'open')">{{ t('用默认应用打开') }}</el-button>
      <el-button text role="menuitem" @click="emit('action', 'reveal')">{{ t('在文件管理器中显示') }}</el-button>
      <el-button text role="menuitem" @click="emit('action', 'saveAs')">{{ t('另存为') }}</el-button>
      <el-button text type="danger" role="menuitem" @click="emit('action', 'remove')">{{
        t('从笔记中移除')
      }}</el-button>
    </div>
  </el-popover>
</template>

<style scoped lang="scss">
.attachment-context-menu {
  display: grid;
  gap: var(--space-4);
}
</style>

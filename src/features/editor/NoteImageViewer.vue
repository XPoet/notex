<script setup lang="ts">
import { computed, watch } from 'vue'
import type { NoteImage } from '@/composables/useNoteImages'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  images: NoteImage[]
  previewPath?: string
}>()
const emit = defineEmits<{ close: [] }>()
const availableImages = computed(() => props.images.filter((image) => image.url !== undefined && !image.failed))
const previewUrls = computed(() =>
  availableImages.value.flatMap((image) => (image.url === undefined ? [] : [image.url])),
)
const previewIndex = computed(() =>
  availableImages.value.findIndex((image) => image.relativePath === props.previewPath),
)
watch(previewIndex, (index) => {
  if (index < 0 && props.previewPath !== undefined) emit('close')
})
</script>

<template>
  <el-image-viewer
    v-if="previewPath !== undefined && previewIndex >= 0"
    :url-list="previewUrls"
    :initial-index="previewIndex"
    teleported
    show-progress
    hide-on-click-modal
    @close="emit('close')"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { NoteImage } from '@/composables/useNoteImages'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  images: NoteImage[]
  previewPath?: string
  loadOriginal?: (path: string) => Promise<string>
}>()
const emit = defineEmits<{ close: [] }>()
const activePath = shallowRef(props.previewPath)
const originalUrl = shallowRef<string>()
let request = 0
const availableImages = computed(() => props.images.filter((image) => !image.failed))
const previewUrls = computed(() =>
  availableImages.value.map((image) =>
    image.relativePath === activePath.value ? (originalUrl.value ?? image.url ?? '') : (image.url ?? ''),
  ),
)
const previewIndex = computed(() => availableImages.value.findIndex((image) => image.relativePath === activePath.value))
function releaseOriginal(): void {
  if (originalUrl.value !== undefined) URL.revokeObjectURL(originalUrl.value)
  originalUrl.value = undefined
}
watch(
  () => props.previewPath,
  (path) => {
    activePath.value = path
  },
)
watch(
  activePath,
  async (path) => {
    const version = ++request
    releaseOriginal()
    if (path === undefined || props.loadOriginal === undefined) return
    try {
      const url = await props.loadOriginal(path)
      if (request !== version) URL.revokeObjectURL(url)
      else originalUrl.value = url
    } catch {
      // A failed/oversized original keeps the already loaded bounded preview.
    }
  },
  { immediate: true },
)
watch(previewIndex, (index) => {
  if (index < 0 && props.previewPath !== undefined) emit('close')
})
function switchImage(index: number): void {
  activePath.value = availableImages.value[index]?.relativePath
}
onBeforeUnmount(() => {
  request += 1
  releaseOriginal()
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
    @switch="switchImage"
  />
</template>

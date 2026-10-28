import { t } from '@/i18n'
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { loadNoteImage } from '@/services/assets'

export interface NoteImage {
  relativePath: string
  url?: string
  failed: boolean
}

export interface NoteImageReference {
  relativePath: string
  label: string
  to: number
}

export function getNoteImageReferences(content: string): NoteImageReference[] {
  const text = content.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, (code) =>
    code.replace(/[^\n]/g, ' '),
  )
  const references: NoteImageReference[] = []
  for (const match of text.matchAll(/!\[([^\]\n]*)\]\(\.\/(assets\/[\w-]+\.(?:png|jpe?g|webp|gif))\)/gi)) {
    const relativePath = match[2]
    if (relativePath !== undefined) {
      references.push({
        relativePath,
        label: match[1] || t('图片'),
        to: match.index + match[0].length,
      })
    }
  }
  return references
}

export function useNoteImages(
  noteId: () => string,
  content: () => string,
): {
  images: Readonly<Ref<NoteImage[]>>
} {
  const images = ref<NoteImage[]>([])
  const cache = new Map<string, NoteImage>()
  let currentNoteId = noteId()
  let disposed = false
  const paths = computed(() => {
    const paths = getNoteImageReferences(content()).map((reference) => reference.relativePath)
    return [...new Set(paths)]
  })
  const references = computed(() => paths.value.join('\n'))

  function release(image: NoteImage): void {
    if (image.url !== undefined) URL.revokeObjectURL(image.url)
  }

  async function load(image: NoteImage, id: string): Promise<void> {
    try {
      const url = await loadNoteImage(id, image.relativePath)
      if (disposed || currentNoteId !== id || cache.get(image.relativePath) !== image) {
        URL.revokeObjectURL(url)
        return
      }
      image.url = url
    } catch {
      image.failed = true
    }
  }

  watch(
    [noteId, references],
    ([id]) => {
      if (currentNoteId !== id) {
        cache.forEach(release)
        cache.clear()
        currentNoteId = id
      }
      for (const [path, image] of cache) {
        if (!paths.value.includes(path)) {
          release(image)
          cache.delete(path)
        }
      }
      images.value = paths.value.map((relativePath) => {
        const existing = cache.get(relativePath)
        if (existing !== undefined) return existing
        const image = reactive<NoteImage>({ relativePath, failed: false })
        cache.set(relativePath, image)
        void load(image, id)
        return image
      })
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    cache.forEach(release)
    cache.clear()
  })

  return { images }
}

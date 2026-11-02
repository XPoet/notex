import { t } from '@/i18n'
import { onScopeDispose, reactive, ref, shallowRef, watch } from 'vue'
import type { Ref } from 'vue'
import { loadNoteImage } from '@/services/assets'

export interface NoteImage {
  relativePath: string
  url?: string
  failed: boolean
}

export interface NoteImageReference {
  from: number
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
        from: match.index,
        relativePath,
        label: match[1] || t('图片'),
        to: match.index + match[0].length,
      })
    }
  }
  return references
}

interface CachedImage {
  image: NoteImage
  bytes: number
  loading: boolean
  blocked: boolean
  used: number
}

interface OriginalRequest {
  id: string
  path: string
  version: number
  resolve: (url: string) => void
  reject: (error: Error) => void
}

export interface NoteImageOptions {
  visiblePaths?: () => readonly string[]
  maxBytes?: number
  concurrency?: number
}

export function useNoteImages(
  noteId: () => string,
  references: () => readonly NoteImageReference[],
  options: NoteImageOptions = {},
): {
  images: Readonly<Ref<NoteImage[]>>
  retainedBytes: Readonly<Ref<number>>
  loadOriginal: (path: string) => Promise<string>
} {
  const images = ref<NoteImage[]>([])
  const retainedBytes = shallowRef(0)
  const cache = new Map<string, CachedImage>()
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024
  const concurrency = Math.max(1, options.concurrency ?? 2)
  let currentNoteId = noteId()
  let disposed = false
  let active = 0
  let clock = 0
  let visible = new Set<string>()
  const originals: OriginalRequest[] = []
  let originalVersion = 0
  let originalActive = false
  let imageController = new AbortController()

  function release(entry: CachedImage): void {
    if (entry.image.url !== undefined) URL.revokeObjectURL(entry.image.url)
    entry.image.url = undefined
    retainedBytes.value -= entry.bytes
    entry.bytes = 0
  }

  function reserve(bytes: number, target: CachedImage): boolean {
    if (bytes > maxBytes) return false
    const candidates = [...cache.values()]
      .filter((entry) => entry !== target && entry.image.url !== undefined && !visible.has(entry.image.relativePath))
      .sort((left, right) => left.used - right.used)
    for (const entry of candidates) {
      if (retainedBytes.value + bytes <= maxBytes) break
      release(entry)
      // Evicted prefetches wait until they become visible; never cycle through
      // an entire document repeatedly when the cache reaches its budget.
      entry.blocked = true
    }
    return retainedBytes.value + bytes <= maxBytes
  }

  async function load(entry: CachedImage, id: string): Promise<void> {
    let bytes = 0
    try {
      const url = await loadNoteImage(id, entry.image.relativePath, {
        thumbnail: true,
        signal: imageController.signal,
        onByteLength: (value) => {
          bytes = value
        },
        onMemoryCost: (value) => {
          bytes = value
        },
      })
      if (disposed || currentNoteId !== id || cache.get(entry.image.relativePath) !== entry) {
        URL.revokeObjectURL(url)
        return
      }
      if (!reserve(bytes, entry)) {
        URL.revokeObjectURL(url)
        entry.blocked = true
        entry.image.failed = bytes > maxBytes
        return
      }
      entry.image.url = url
      entry.bytes = bytes
      entry.used = ++clock
      retainedBytes.value += bytes
    } catch {
      if (!disposed && cache.get(entry.image.relativePath) === entry) entry.image.failed = true
    } finally {
      entry.loading = false
      active -= 1
      pump()
    }
  }

  function pump(): void {
    if (disposed) return
    if (!originalActive && active < concurrency) {
      let job = originals.shift()
      while (
        job !== undefined &&
        (job.version !== originalVersion || job.id !== currentNoteId || !cache.has(job.path))
      ) {
        job.reject(new Error(t('图片无法读取')))
        job = originals.shift()
      }
      if (job !== undefined) {
        originalActive = true
        active += 1
        void readOriginal(job)
      }
    }
    const pending = [...cache.values()]
      .filter((entry) => !entry.loading && !entry.blocked && !entry.image.failed && entry.image.url === undefined)
      .sort(
        (left, right) => Number(visible.has(right.image.relativePath)) - Number(visible.has(left.image.relativePath)),
      )
    for (const entry of pending) {
      if (active >= concurrency) break
      if (!visible.has(entry.image.relativePath) && retainedBytes.value >= maxBytes) continue
      entry.loading = true
      active += 1
      void load(entry, currentNoteId)
    }
  }

  watch(
    [
      noteId,
      () => [...new Set(references().map((reference) => reference.relativePath))].join('\n'),
      () => options.visiblePaths?.().join('\n') ?? '',
    ],
    ([id, pathList, visibleList]) => {
      if (currentNoteId !== id) {
        imageController.abort()
        imageController = new AbortController()
        cache.forEach(release)
        cache.clear()
        currentNoteId = id
      }
      const paths = pathList === '' ? [] : pathList.split('\n')
      const allowed = new Set(paths)
      visible = new Set(options.visiblePaths === undefined ? paths : visibleList.split('\n'))
      for (const [path, entry] of cache) {
        if (!allowed.has(path)) {
          release(entry)
          cache.delete(path)
        } else if (visible.has(path)) {
          entry.blocked = false
          entry.used = ++clock
        }
      }
      images.value = paths.map((relativePath) => {
        const existing = cache.get(relativePath)
        if (existing !== undefined) return existing.image
        const entry: CachedImage = {
          image: reactive({ relativePath, failed: false }),
          bytes: 0,
          loading: false,
          blocked: false,
          used: ++clock,
        }
        cache.set(relativePath, entry)
        return entry.image
      })
      pump()
    },
    { immediate: true },
  )

  async function readOriginal(job: OriginalRequest): Promise<void> {
    let bytes = 0
    try {
      const url = await loadNoteImage(job.id, job.path, {
        signal: imageController.signal,
        onByteLength: (value) => {
          bytes = value
        },
      })
      if (
        disposed ||
        currentNoteId !== job.id ||
        job.version !== originalVersion ||
        !cache.has(job.path) ||
        bytes > maxBytes
      ) {
        URL.revokeObjectURL(url)
        throw new Error(t('图片无法读取'))
      }
      job.resolve(url)
    } catch {
      job.reject(new Error(t('图片无法读取')))
    } finally {
      originalActive = false
      active -= 1
      pump()
    }
  }

  function loadOriginal(path: string): Promise<string> {
    if (!cache.has(path) || disposed) return Promise.reject(new Error(t('图片无法读取')))
    originalVersion += 1
    return new Promise((resolve, reject) => {
      originals.push({ id: currentNoteId, path, version: originalVersion, resolve, reject })
      pump()
    })
  }

  onScopeDispose(() => {
    disposed = true
    imageController.abort()
    for (const request of originals) request.reject(new Error(t('图片无法读取')))
    originals.length = 0
    cache.forEach(release)
    cache.clear()
  })

  return { images, retainedBytes, loadOriginal }
}

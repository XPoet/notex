import { t } from '@/i18n'
import { readClipboardBitmap } from '@/services/clipboard'

const LARGE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

export interface ClipboardPasteHandlers {
  insertText: (text: string) => void
  saveImage: (bytes: Uint8Array) => Promise<string>
  onError: (message: string) => void
  saveFile?: (file: File) => Promise<string>
  pasteFiles?: () => Promise<string[] | undefined>
  createInserter?: () => (text: string, block?: boolean) => void
}

export function useClipboardPaste(handlers: ClipboardPasteHandlers): {
  handlePaste: (event: ClipboardEvent) => boolean
  handleFiles: (files: readonly File[]) => Promise<void>
} {
  async function saveFiles(files: readonly File[], fromClipboard = false): Promise<string> {
    const results: string[] = []
    for (const file of files) {
      try {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(t('附件大小超过 100 MiB。'))
        if (file.type.startsWith('image/') && (fromClipboard || handlers.saveFile === undefined)) {
          if (confirmLargeImage(file.size))
            results.push(await handlers.saveImage(new Uint8Array(await file.arrayBuffer())))
        } else if (handlers.saveFile !== undefined) {
          if (
            file.size >= LARGE_IMAGE_BYTES &&
            !window.confirm(t('附件大小为 {value1}。是否继续添加？', { value1: formatFileSize(file.size) }))
          )
            continue
          results.push(await handlers.saveFile(file))
        }
      } catch (error: unknown) {
        handlers.onError(
          error instanceof Error
            ? error.message
            : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
              ? error.message
              : t('附件添加失败，请重试。'),
        )
      }
    }
    return results.filter(Boolean).join('\n')
  }

  async function handleFiles(files: readonly File[]): Promise<void> {
    const insert = handlers.createInserter?.() ?? handlers.insertText
    insert(await saveFiles(files), true)
  }

  async function paste(files: readonly File[], text: string, hasImage: boolean): Promise<void> {
    const insert = handlers.createInserter?.() ?? handlers.insertText
    let markdown = ''
    let block = true
    try {
      // Finder may also expose a generated bitmap. Prefer its native file URLs
      // so original bytes and filenames are preserved and large files stay native.
      const pasted = await handlers.pasteFiles?.()
      if (pasted !== undefined) {
        markdown = pasted.join('\n')
      } else if (files.length > 0) {
        markdown = await saveFiles(files, true)
      } else if (hasImage || text === '') {
        markdown = await saveClipboardBitmap(handlers.saveImage, hasImage)
      } else {
        markdown = text
        block = false
      }
    } catch (error: unknown) {
      handlers.onError(
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
            ? error.message
            : t('附件添加失败，请重试。'),
      )
    }
    insert(markdown, block)
  }

  function handlePaste(event: ClipboardEvent): boolean {
    // WebKit revokes clipboardData access as soon as the paste event finishes.
    const data = event.clipboardData
    const files = transferFiles(data)
    const hasImage =
      files.some((file) => file.type.startsWith('image/')) ||
      Array.from(data?.items ?? []).some((item) => item.type.startsWith('image/')) ||
      Array.from(data?.types ?? []).some((type) => type.startsWith('image/'))
    if (handlers.pasteFiles === undefined && handlers.saveFile === undefined && !hasImage) return false
    const text = files.length > 0 || hasImage ? '' : (data?.getData('text/plain') ?? '')
    event.preventDefault()
    void paste(files, text, hasImage)
    return true
  }

  return { handlePaste, handleFiles }
}

export function transferFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? [])
  if (files.length > 0) return files
  return Array.from(data?.items ?? []).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null
    return file === null ? [] : [file]
  })
}

async function saveClipboardBitmap(
  saveImage: (bytes: Uint8Array) => Promise<string>,
  hasImage: boolean,
): Promise<string> {
  const bitmap = await readClipboardBitmap().catch((error: unknown) => {
    if (hasImage) throw error
    return undefined
  })
  if (bitmap === undefined) return ''

  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error(t('当前环境无法处理剪贴板位图。'))
  context.putImageData(new ImageData(new Uint8ClampedArray(bitmap.rgba), bitmap.width, bitmap.height), 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error(t('无法将剪贴板位图编码为 PNG。'))
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(t('附件大小超过 100 MiB。'))
  if (!confirmLargeImage(blob.size)) return ''
  return await saveImage(new Uint8Array(await blob.arrayBuffer()))
}

function confirmLargeImage(size: number): boolean {
  if (size < LARGE_IMAGE_BYTES) {
    return true
  }
  return window.confirm(t('图片大小为 {value1}。继续粘贴将按原始大小保存到本机。', { value1: formatFileSize(size) }))
}

function formatFileSize(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

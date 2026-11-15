import { t } from '@/i18n'
import { readImage } from '@tauri-apps/plugin-clipboard-manager'

const LARGE_IMAGE_BYTES = 10 * 1024 * 1024

export interface ClipboardPasteHandlers {
  insertText: (text: string) => void
  saveImage: (bytes: Uint8Array) => Promise<string>
  onError: (message: string) => void
  saveFile?: (file: File) => Promise<string>
  pasteFiles?: () => Promise<string[] | undefined>
  createInserter?: () => (text: string, block?: boolean) => void
}

export function useClipboardPaste(handlers: ClipboardPasteHandlers): {
  handlePaste: (event: ClipboardEvent) => Promise<void>
  handleFiles: (files: readonly File[]) => Promise<void>
} {
  async function saveFiles(files: readonly File[]): Promise<string> {
    const results: string[] = []
    for (const file of files) {
      try {
        if (handlers.saveFile !== undefined) {
          if (file.size > 100 * 1024 * 1024) throw new Error(t('附件大小超过 100 MiB。'))
          if (
            file.size >= LARGE_IMAGE_BYTES &&
            !window.confirm(t('附件大小为 {value1}。是否继续添加？', { value1: formatFileSize(file.size) }))
          )
            continue
          results.push(await handlers.saveFile(file))
        } else if (file.type.startsWith('image/')) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          if (await confirmLargeImage(bytes.byteLength)) results.push(await handlers.saveImage(bytes))
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

  async function handlePaste(event: ClipboardEvent): Promise<void> {
    event.preventDefault()
    const insert = handlers.createInserter?.() ?? handlers.insertText
    let markdown = ''
    let block = false
    try {
      // Finder may also expose a generated bitmap. Prefer its native file URLs
      // so original bytes and filenames are preserved and large files stay native.
      const pasted = await handlers.pasteFiles?.()
      const files = transferFiles(event.clipboardData)
      if (pasted !== undefined) {
        markdown = pasted.join('\n')
        block = true
      } else if (files.length > 0) {
        markdown = await saveFiles(files)
        block = true
      } else if (hasClipboardImage(event.clipboardData)) {
        markdown = await saveClipboardBitmap(handlers.saveImage)
        block = true
      } else markdown = event.clipboardData?.getData('text/plain') ?? ''
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

function hasClipboardImage(clipboardData: DataTransfer | null): boolean {
  return Array.from(clipboardData?.items ?? []).some((item) => item.type.startsWith('image/'))
}

export async function saveClipboardBitmap(saveImage: (bytes: Uint8Array) => Promise<string>): Promise<string> {
  const clipboardImage = await readImage()
  try {
    const [size, rgba] = await Promise.all([clipboardImage.size(), clipboardImage.rgba()])
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error(t('当前环境无法处理剪贴板位图。'))
    }
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob === null) {
      throw new Error(t('无法将剪贴板位图编码为 PNG。'))
    }
    if (!(await confirmLargeImage(blob.size))) {
      return ''
    }
    return await saveImage(new Uint8Array(await blob.arrayBuffer()))
  } finally {
    await clipboardImage.close()
  }
}

async function confirmLargeImage(size: number): Promise<boolean> {
  if (size < LARGE_IMAGE_BYTES) {
    return true
  }
  return window.confirm(t('图片大小为 {value1}。继续粘贴将按原始大小保存到本机。', { value1: formatFileSize(size) }))
}

function formatFileSize(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

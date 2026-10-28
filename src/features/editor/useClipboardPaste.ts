import { t } from '@/i18n'
import { readImage } from '@tauri-apps/plugin-clipboard-manager'

const LARGE_IMAGE_BYTES = 10 * 1024 * 1024

export interface ClipboardPasteHandlers {
  insertText: (text: string) => void
  saveImage: (bytes: Uint8Array) => Promise<string>
  onError: (message: string) => void
}

export function useClipboardPaste(handlers: ClipboardPasteHandlers): {
  handlePaste: (event: ClipboardEvent) => Promise<void>
} {
  async function handlePaste(event: ClipboardEvent): Promise<void> {
    const imageFile = findClipboardImage(event.clipboardData)
    if (imageFile !== undefined) {
      event.preventDefault()
      await saveImageFile(imageFile)
      return
    }

    if (hasClipboardImage(event.clipboardData)) {
      event.preventDefault()
      await saveBitmap()
      return
    }

    if (event.clipboardData !== null) {
      event.preventDefault()
      handlers.insertText(event.clipboardData.getData('text/plain'))
    }
  }

  async function saveImageFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!(await confirmLargeImage(bytes.byteLength))) {
        return
      }
      const markdown = await handlers.saveImage(bytes)
      if (markdown.length > 0) {
        handlers.insertText(markdown)
      }
    } catch (error: unknown) {
      handlers.onError(error instanceof Error ? error.message : t('图片保存失败，未插入图片引用。'))
    }
  }

  async function saveBitmap(): Promise<void> {
    try {
      const markdown = await saveClipboardBitmap(handlers.saveImage)
      handlers.insertText(markdown)
    } catch (error: unknown) {
      handlers.onError(error instanceof Error ? error.message : t('图片保存失败，未插入图片引用。'))
    }
  }

  return { handlePaste }
}

function hasClipboardImage(clipboardData: DataTransfer | null): boolean {
  return Array.from(clipboardData?.items ?? []).some((item) => item.type.startsWith('image/'))
}

function findClipboardImage(clipboardData: DataTransfer | null): File | undefined {
  if (clipboardData === null) {
    return undefined
  }
  for (const item of clipboardData.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      return item.getAsFile() ?? undefined
    }
  }
  return undefined
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

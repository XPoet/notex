import { readImage, writeText } from '@tauri-apps/plugin-clipboard-manager'

export async function copyText(text: string): Promise<void> {
  await writeText(text)
}

export async function readClipboardBitmap(): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const image = await readImage()
  try {
    const [size, rgba] = await Promise.all([image.size(), image.rgba()])
    return { ...size, rgba }
  } finally {
    await image.close()
  }
}

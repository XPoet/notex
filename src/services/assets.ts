import { invoke } from '@tauri-apps/api/core'
import type { AssetError, AssetErrorCode, AssetHealth, SavedAsset } from '@/types/assets'

interface TauriErrorPayload {
  code?: unknown
  message?: unknown
}

const assetErrorCodes: AssetErrorCode[] = [
  'ASSET_NOTE_NOT_FOUND',
  'INVALID_IMAGE_DATA',
  'UNSUPPORTED_IMAGE_FORMAT',
  'IMAGE_DIMENSIONS_INVALID',
  'ASSET_STORAGE_UNAVAILABLE',
  'ASSET_WRITE_FAILED',
  'ASSET_SAVE_FAILED',
  'ASSET_READ_FAILED',
]

function isTauriErrorPayload(value: unknown): value is TauriErrorPayload {
  return typeof value === 'object' && value !== null
}

function isAssetErrorCode(value: unknown): value is AssetErrorCode {
  return typeof value === 'string' && assetErrorCodes.includes(value as AssetErrorCode)
}

export function toAssetError(error: unknown): AssetError {
  if (isTauriErrorPayload(error) && isAssetErrorCode(error.code) && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'ASSET_SAVE_FAILED',
    message: '图片资源保存失败，未插入图片引用。',
  }
}

export async function savePastedImage(noteId: string, bytes: Uint8Array): Promise<SavedAsset> {
  try {
    return await invoke<SavedAsset>('save_pasted_image', { noteId, bytes: Array.from(bytes) })
  } catch (error: unknown) {
    throw toAssetError(error)
  }
}

export async function getNoteAssetHealth(noteId: string): Promise<AssetHealth> {
  try {
    return await invoke<AssetHealth>('get_note_asset_health', { noteId })
  } catch (error: unknown) {
    throw toAssetError(error)
  }
}

export interface NoteImageLoadOptions {
  thumbnail?: boolean
  onByteLength?: (bytes: number) => void
  onMemoryCost?: (bytes: number) => void
  signal?: AbortSignal
}

function thumbnailMemoryCost(bytes: Uint8Array): number {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('缩略图 PNG 头无效')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('缩略图 IHDR 无效')
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0 || width > 1_280 || height > 1_280) throw new Error('缩略图尺寸无效')
  // Conservative residency estimate: encoded Blob plus decoded RGBA. Browser
  // object/GPU overhead is implementation dependent and is not heap telemetry.
  return bytes.byteLength + width * height * 4
}

let activeImageReads = 0
const imageReadQueue: (() => void)[] = []

function releaseImageRead(): void {
  const next = imageReadQueue.shift()
  if (next === undefined) activeImageReads -= 1
  else next()
}

async function acquireImageRead(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw new Error('图片读取已取消')
  await new Promise<void>((resolve) => {
    if (activeImageReads < 2) {
      activeImageReads += 1
      resolve()
    } else imageReadQueue.push(resolve)
  })
  if (signal?.aborted === true) {
    releaseImageRead()
    throw new Error('图片读取已取消')
  }
}

export async function loadNoteImage(
  noteId: string,
  relativePath: string,
  options: NoteImageLoadOptions = {},
): Promise<string> {
  let acquired = false
  try {
    // Also bound reads across editor lifetimes: old native IPC cannot be
    // cancelled, while aborted requests still waiting here skip native work.
    await acquireImageRead(options.signal)
    acquired = true
    const response = await invoke<ArrayBuffer | number[]>('read_note_image', {
      noteId,
      relativePath,
      ...(options.thumbnail === true ? { thumbnail: true } : {}),
    })
    if (options.signal?.aborted === true) throw new Error('图片读取已取消')
    // macOS 的 postMessage IPC 返回数字数组，其他 IPC 通道可返回 ArrayBuffer。
    const bytes = Array.isArray(response) ? new Uint8Array(response) : response
    options.onByteLength?.(bytes.byteLength)
    if (options.thumbnail === true) {
      const memoryCost = thumbnailMemoryCost(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      options.onMemoryCost?.(memoryCost)
    }
    const extension = relativePath.split('.').pop()?.toLowerCase()
    const mimeType =
      options.thumbnail === true
        ? 'image/png'
        : extension === 'jpg' || extension === 'jpeg'
          ? 'image/jpeg'
          : `image/${extension}`
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  } catch (error: unknown) {
    throw toAssetError(error)
  } finally {
    if (acquired) releaseImageRead()
  }
}

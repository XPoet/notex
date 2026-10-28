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

export async function loadNoteImage(noteId: string, relativePath: string): Promise<string> {
  try {
    const response = await invoke<ArrayBuffer | number[]>('read_note_image', {
      noteId,
      relativePath,
    })
    // macOS 的 postMessage IPC 返回数字数组，其他 IPC 通道可返回 ArrayBuffer。
    const bytes = Array.isArray(response) ? new Uint8Array(response) : response
    const extension = relativePath.split('.').pop()?.toLowerCase()
    const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  } catch (error: unknown) {
    throw toAssetError(error)
  }
}

export interface SavedAsset {
  id: string
  relativePath: string
  originalName: string
  mimeType: string
  width: number | null
  height: number | null
  size: number
  modifiedAt: string | null
}

export interface AttachmentBatch {
  assets: SavedAsset[]
  failedNames: string[]
}

export interface AttachmentHandlers {
  saveFile: (file: File) => Promise<string>
  chooseFiles: () => Promise<string[]>
  pasteFiles: () => Promise<string[] | undefined>
  open: (relativePath: string) => Promise<void>
  reveal: (relativePath: string) => Promise<void>
  saveAs: (relativePath: string) => Promise<void>
}

export interface AssetHealth {
  missingAssetCount: number
}

export type AssetErrorCode =
  | 'ASSET_NOTE_NOT_FOUND'
  | 'INVALID_IMAGE_DATA'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'IMAGE_DIMENSIONS_INVALID'
  | 'ASSET_STORAGE_UNAVAILABLE'
  | 'ASSET_WRITE_FAILED'
  | 'ASSET_SAVE_FAILED'
  | 'ASSET_READ_FAILED'
  | 'ASSET_UNSUPPORTED_FILE'
  | 'ASSET_FILE_TOO_LARGE'
  | 'ASSET_OPEN_FAILED'
  | 'ASSET_EXPORT_FAILED'
  | 'ASSET_CLIPBOARD_FAILED'

export interface AssetError {
  code: AssetErrorCode
  message: string
}

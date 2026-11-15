import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import {
  chooseNoteAttachments,
  listNoteAssets,
  openNoteAsset,
  pasteNoteAttachments,
  revealNoteAsset,
  saveNoteAssetAs,
  saveNoteAttachment,
  toAssetError,
} from '@/services/assets'
import { assetMarkdown } from '@/features/editor/assetReferences'
import { localizeMessage, t } from '@/i18n'
import type { AttachmentBatch, AttachmentHandlers, SavedAsset } from '@/types/assets'

export function useNoteAttachments(noteId: () => string | undefined, onError: (message: string) => void) {
  const assets = shallowRef<SavedAsset[]>([])
  const revision = shallowRef(0)
  let disposed = false
  let refreshVersion = 0

  function currentId(): string {
    const id = noteId()
    if (id === undefined) throw new Error(t('请先新建或选择一条笔记。'))
    return id
  }

  async function refresh(): Promise<void> {
    const id = noteId()
    const version = ++refreshVersion
    if (id === undefined) {
      assets.value = []
      return
    }
    try {
      const next = await listNoteAssets(id)
      if (disposed || noteId() !== id || version !== refreshVersion) return
      if (JSON.stringify(next) !== JSON.stringify(assets.value)) {
        assets.value = next
        revision.value += 1
      }
    } catch (error: unknown) {
      if (!disposed && noteId() === id && version === refreshVersion)
        onError(localizeMessage(toAssetError(error).message))
    }
  }

  function batchMarkdown(batch: AttachmentBatch): string[] {
    if (batch.failedNames.length > 0) onError(t('以下附件未能添加：{value1}', { value1: batch.failedNames.join('、') }))
    return batch.assets.map(assetMarkdown)
  }

  const handlers: AttachmentHandlers = {
    async saveFile(file) {
      const asset = await saveNoteAttachment(currentId(), file)
      void refresh()
      return assetMarkdown(asset)
    },
    async chooseFiles() {
      const batch = await chooseNoteAttachments(currentId())
      void refresh()
      return batchMarkdown(batch)
    },
    async pasteFiles() {
      const batch = await pasteNoteAttachments(currentId())
      if (batch.assets.length === 0 && batch.failedNames.length === 0) return undefined
      if (batch.assets.length > 0) void refresh()
      return batchMarkdown(batch)
    },
    open: (path) => openNoteAsset(currentId(), path),
    reveal: (path) => revealNoteAsset(currentId(), path),
    saveAs: (path) => saveNoteAssetAs(currentId(), path),
  }

  watch(
    noteId,
    () => {
      assets.value = []
      void refresh()
    },
    { immediate: true },
  )
  onMounted(() => window.addEventListener('focus', refresh))
  onBeforeUnmount(() => {
    disposed = true
    refreshVersion += 1
    window.removeEventListener('focus', refresh)
  })
  return { assets, revision, handlers }
}

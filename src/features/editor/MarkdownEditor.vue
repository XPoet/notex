<script setup lang="ts">
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { transferFiles, useClipboardPaste } from './useClipboardPaste'
import AttachmentContextMenu from './AttachmentContextMenu.vue'
import { getNoteAssetReferences } from './assetReferences'
import type { NoteAssetReference } from './assetReferences'
import type { AttachmentHandlers, SavedAsset } from '@/types/assets'
import NoteImageViewer from './NoteImageViewer.vue'
import { imagePreviews, refreshImagePreviews, replaceImageReferences } from './imagePreviews'
import { EditHistory } from './editHistory'
import { searchHighlights } from './searchHighlights'
import { getNoteImageReferences, useNoteImages } from '@/composables/useNoteImages'
import { locale, localizeMessage, t } from '@/i18n'

const props = defineProps<{
  modelValue: string
  noteId: string
  saveImage: (bytes: Uint8Array) => Promise<string>
  searchQuery?: string
  attachments?: AttachmentHandlers
  assets?: readonly SavedAsset[]
  assetRevision?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  pasteError: [message: string]
}>()

const editorHost = useTemplateRef<HTMLDivElement>('editorHost')
const editorView = shallowRef<EditorView>()
const editorContent = ref(props.modelValue)
const assetReferences = shallowRef(getNoteAssetReferences(props.modelValue))
const imageReferences = shallowRef(getNoteImageReferences(props.modelValue))
const contextMenu = shallowRef<{ x: number; y: number; reference: NoteAssetReference }>()
const pendingInsertions = new Map<symbol, { from: number; to: number }>()
const visibleImagePaths = shallowRef<readonly string[]>([])
const searchHighlightCompartment = new Compartment()
const { images, loadOriginal } = useNoteImages(
  () => props.noteId,
  () => imageReferences.value,
  { visiblePaths: () => visibleImagePaths.value, revision: () => props.assetRevision ?? 0 },
)
const previewPath = ref<string>()
let synchronizing = false
let applyingHistory = false
const history = new EditHistory()
let referenceTimer: ReturnType<typeof setTimeout> | undefined
let referenceRefreshQueued = false
let disposed = false

const previewField = imagePreviews(
  () => images.value,
  () => assetReferences.value,
  (path) => {
    if (assetReferences.value.some((reference) => reference.relativePath === path && reference.kind === 'image'))
      previewPath.value = path
    else void props.attachments?.open(path).catch(reportAssetError)
  },
  (path) => {
    const image = images.value.find((item) => item.relativePath === path)
    if (image !== undefined) image.failed = true
  },
  () => props.assets ?? [],
)

function updateVisibleImages(view: EditorView): void {
  const ranges = view.visibleRanges
  const paths = view.state
    .field(previewField)
    .references.filter(
      (reference) =>
        reference.kind === 'image' &&
        ranges.some((range) => reference.to >= range.from - 1_200 && reference.from <= range.to + 1_200),
    )
    .map((reference) => reference.relativePath)
  if (paths.join('\n') !== visibleImagePaths.value.join('\n')) visibleImagePaths.value = paths
}

function refreshReferences(): void {
  referenceRefreshQueued = false
  if (referenceTimer !== undefined) clearTimeout(referenceTimer)
  referenceTimer = undefined
  const view = editorView.value
  if (disposed || view === undefined) return
  assetReferences.value = getNoteAssetReferences(editorContent.value)
  imageReferences.value = assetReferences.value.filter((reference) => reference.kind === 'image')
  view.dispatch({ effects: replaceImageReferences.of(assetReferences.value) })
  updateVisibleImages(view)
}

function scheduleReferences(structuralChange: boolean): void {
  if (structuralChange) {
    if (referenceRefreshQueued) return
    referenceRefreshQueued = true
    queueMicrotask(refreshReferences)
  } else if (referenceTimer === undefined && !referenceRefreshQueued) {
    referenceTimer = setTimeout(refreshReferences, 160)
  }
}

function insertText(text: string): void {
  const view = editorView.value
  if (view === undefined || text.length === 0) {
    return
  }
  const selection = view.state.selection.main
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: text },
    selection: { anchor: selection.from + text.length },
  })
  view.focus()
}

function insertNewLine(): boolean {
  insertText('\n')
  return true
}

const { handlePaste, handleFiles } = useClipboardPaste({
  insertText,
  saveImage: props.saveImage,
  saveFile: props.attachments?.saveFile,
  pasteFiles: props.attachments?.pasteFiles,
  createInserter,
  onError: (message) => emit('pasteError', message),
})

function handlePasteEvent(event: ClipboardEvent): boolean {
  if (props.attachments === undefined && !hasClipboardImage(event.clipboardData)) {
    return false
  }
  void handlePaste(event)
  return true
}

function hasClipboardImage(clipboardData: DataTransfer | null): boolean {
  return Array.from(clipboardData?.items ?? []).some((item) => item.type.startsWith('image/'))
}

function reportAssetError(error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : t('附件操作失败，请重试。')
  emit('pasteError', localizeMessage(message))
}

function createInserter(): (text: string, block?: boolean) => void {
  const view = editorView.value
  const key = Symbol()
  const id = props.noteId
  if (view !== undefined)
    pendingInsertions.set(key, { from: view.state.selection.main.from, to: view.state.selection.main.to })
  return (text, block = false) => {
    const range = pendingInsertions.get(key)
    pendingInsertions.delete(key)
    if (disposed || id !== props.noteId || view === undefined || range === undefined || text.length === 0) return
    if (block) {
      const before = view.state.doc.sliceString(Math.max(0, range.from - 1), range.from)
      const after = view.state.doc.sliceString(range.to, Math.min(view.state.doc.length, range.to + 1))
      text = `${before !== '' && before !== '\n' ? '\n' : ''}${text}${after !== '' && after !== '\n' ? '\n' : ''}`
    }
    history.breakGroup()
    view.dispatch({ changes: { ...range, insert: text }, selection: { anchor: range.from + text.length } })
    history.breakGroup()
    view.focus()
  }
}

async function insertAttachments(): Promise<void> {
  const insert = createInserter()
  try {
    insert(((await props.attachments?.chooseFiles()) ?? []).join('\n'), true)
  } catch (error: unknown) {
    insert('')
    reportAssetError(error)
  }
}

function handleContextMenu(event: MouseEvent): boolean {
  if (!(event.target instanceof Element)) return false
  const element = event.target.closest<HTMLElement>('[data-asset-path]')
  const view = editorView.value
  if (element === null || view === undefined) return false
  const position = view.posAtDOM(element)
  const references = view.state.field(previewField).references
  const index = Number(element.dataset.assetIndex)
  const indexed = Number.isInteger(index) && index >= 0 ? references[index] : undefined
  const reference =
    indexed?.relativePath === element.dataset.assetPath
      ? indexed
      : [...references]
          .filter((item) => item.relativePath === element.dataset.assetPath)
          .sort((left, right) => Math.abs(left.to - position) - Math.abs(right.to - position))[0]
  if (reference === undefined) return false
  event.preventDefault()
  contextMenu.value = { x: event.clientX, y: event.clientY, reference }
  return true
}

function handleContextAction(action: 'open' | 'reveal' | 'saveAs' | 'remove'): void {
  const reference = contextMenu.value?.reference
  contextMenu.value = undefined
  const view = editorView.value
  if (reference === undefined || view === undefined) return
  if (action === 'remove') {
    history.breakGroup()
    view.dispatch({
      changes: { from: reference.from, to: reference.to, insert: '' },
      selection: { anchor: reference.from },
    })
    history.breakGroup()
    view.focus()
  } else {
    void props.attachments?.[action](reference.relativePath).catch(reportAssetError)
  }
}

function handleDrop(event: DragEvent): boolean {
  const files = transferFiles(event.dataTransfer)
  if (files.length === 0 || props.attachments === undefined) return false
  event.preventDefault()
  const view = editorView.value
  const position = view?.posAtCoords({ x: event.clientX, y: event.clientY })
  if (view !== undefined && position !== null && position !== undefined)
    view.dispatch({ selection: { anchor: position } })
  void handleFiles(files)
  return true
}

function focusEditorWhenClickingBlankArea(event: MouseEvent): void {
  const view = editorView.value
  if (event.button !== 0 || view === undefined || !(event.target instanceof Node)) {
    return
  }
  if (
    view.contentDOM.contains(event.target) ||
    (event.target instanceof Element && event.target.closest('.attachment-context-menu') !== null)
  ) {
    return
  }
  view.dispatch({ selection: { anchor: view.state.doc.length } })
  view.focus()
}

function undo(): boolean {
  const view = editorView.value
  const change = history.undo()
  if (change === undefined || view === undefined) return false
  applyingHistory = true
  view.dispatch(change)
  applyingHistory = false
  return true
}

function redo(): boolean {
  const view = editorView.value
  const change = history.redo()
  if (change === undefined || view === undefined) return false
  applyingHistory = true
  view.dispatch(change)
  applyingHistory = false
  return true
}

function focus(): void {
  editorView.value?.focus()
}

defineExpose({ focus, insertAttachments })

onMounted(() => {
  const host = editorHost.value
  if (host === null) {
    return
  }
  const view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        EditorView.lineWrapping,
        searchHighlightCompartment.of(searchHighlights(props.searchQuery ?? '')),
        previewField,
        EditorView.domEventHandlers({
          paste: handlePasteEvent,
          drop: handleDrop,
          dragover: (event) => {
            if (props.attachments === undefined || !Array.from(event.dataTransfer?.types ?? []).includes('Files'))
              return false
            event.preventDefault()
            return true
          },
          compositionstart: () => {
            history.breakGroup()
            return false
          },
        }),
        keymap.of([
          {
            key: 'Enter',
            run: insertNewLine,
          },
          {
            key: 'Mod-z',
            run: undo,
          },
          {
            key: 'Mod-Shift-z',
            run: redo,
          },
          {
            key: 'Mod-y',
            run: redo,
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            contextMenu.value = undefined
            for (const [key, range] of pendingInsertions)
              pendingInsertions.set(key, {
                from: update.changes.mapPos(range.from, 1),
                to: update.changes.mapPos(range.to, 1),
              })
            // Keep v-model synchronous for save/navigation barriers; serialize
            // once, then reuse this snapshot for deferred image parsing.
            editorContent.value = update.state.doc.toString()
            if (!synchronizing) {
              if (!applyingHistory) update.transactions.forEach((transaction) => history.record(transaction))
              emit('update:modelValue', editorContent.value)
            }
            let structuralChange = synchronizing || applyingHistory
            update.changes.iterChanges((from, to, fromB, toB, inserted) => {
              if (
                toB - fromB > 1_000 ||
                to - from > 1_000 ||
                /[!`~\n[\]()]/.test(inserted.toString()) ||
                /[!`~\n[\]()]/.test(update.startState.doc.sliceString(from, to))
              )
                structuralChange = true
            })
            scheduleReferences(structuralChange)
          } else if (update.selectionSet) {
            history.breakGroup()
          }
          if (update.viewportChanged) updateVisibleImages(update.view)
        }),
      ],
    }),
    parent: host,
  })
  host.addEventListener('mousedown', focusEditorWhenClickingBlankArea)
  editorView.value = view
  updateVisibleImages(view)
})

watch(
  () => props.modelValue,
  (value) => {
    const view = editorView.value
    if (view === undefined || editorContent.value === value) {
      return
    }
    synchronizing = true
    history.clear()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    synchronizing = false
  },
)

watch(
  () => props.searchQuery,
  (value) => {
    editorView.value?.dispatch({
      effects: searchHighlightCompartment.reconfigure(searchHighlights(value ?? '')),
    })
  },
)

watch(
  images,
  () => {
    editorView.value?.dispatch({ effects: refreshImagePreviews.of(null) })
  },
  { deep: true },
)

watch(
  () => props.assets,
  () => editorView.value?.dispatch({ effects: refreshImagePreviews.of(null) }),
)
watch(
  () => props.assetRevision,
  () => {
    previewPath.value = undefined
  },
)
watch(locale, refreshReferences)

onBeforeUnmount(() => {
  disposed = true
  pendingInsertions.clear()
  if (referenceTimer !== undefined) clearTimeout(referenceTimer)
  editorHost.value?.removeEventListener('mousedown', focusEditorWhenClickingBlankArea)
  editorView.value?.destroy()
})
</script>

<template>
  <div ref="editorHost" class="markdown-editor" @contextmenu="handleContextMenu">
    <AttachmentContextMenu
      :visible="contextMenu !== undefined"
      :x="contextMenu?.x ?? 0"
      :y="contextMenu?.y ?? 0"
      @close="contextMenu = undefined"
      @action="handleContextAction"
    />
    <NoteImageViewer
      :images="images"
      :preview-path="previewPath"
      :load-original="loadOriginal"
      @close="previewPath = undefined"
    />
  </div>
</template>

<style scoped lang="scss">
.markdown-editor {
  min-inline-size: 0;
  min-block-size: 0;
  block-size: 100%;
  overflow: hidden;
  color: var(--color-text-primary);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: var(--editor-font-size);
  line-height: 1.8;
}

.markdown-editor :deep(.cm-editor) {
  min-inline-size: 0;
  min-block-size: 0;
  block-size: 100%;
  outline: none;
}

.markdown-editor :deep(.cm-scroller) {
  min-inline-size: 0;
  block-size: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-color: rgb(144 147 153 / 30%) transparent;
  scrollbar-width: thin;
  font-family: inherit;
}

.markdown-editor :deep(.cm-content) {
  min-inline-size: 0;
  min-block-size: 100%;
  padding: var(--space-16) 0 var(--space-24);
  caret-color: var(--color-accent);
}

.markdown-editor :deep(.cm-scroller::-webkit-scrollbar) {
  inline-size: 6px;
  block-size: 6px;
}

.markdown-editor :deep(.cm-scroller::-webkit-scrollbar-track) {
  background: transparent;
}

.markdown-editor :deep(.cm-scroller::-webkit-scrollbar-thumb) {
  border-radius: 999px;
  background: rgb(144 147 153 / 30%);
}

.markdown-editor :deep(.cm-scroller::-webkit-scrollbar-thumb:hover) {
  background: rgb(144 147 153 / 50%);
}

.markdown-editor :deep(.cm-focused) {
  outline: none;
}

.markdown-editor :deep(.cm-search-match) {
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-accent) 35%, var(--color-canvas));
  color: var(--color-text-primary);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--color-accent) 65%, transparent);
}

.markdown-editor :deep(.cm-image-preview),
.markdown-editor :deep(.cm-image-preview *),
.markdown-editor :deep(.cm-attachment-preview),
.markdown-editor :deep(.cm-attachment-preview *) {
  -webkit-user-select: none;
  user-select: none;
}

.markdown-editor :deep(.cm-image-preview) {
  padding-block: var(--space-8) var(--space-16);
}

.markdown-editor :deep(.cm-image-preview button) {
  display: block;
  max-inline-size: 100%;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-8);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font: inherit;
  cursor: zoom-in;
}

.markdown-editor :deep(.cm-image-preview button:disabled) {
  padding: var(--space-12);
  cursor: default;
}

.markdown-editor :deep(.cm-image-preview button:focus-visible) {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.markdown-editor :deep(.cm-image-preview img) {
  display: block;
  max-inline-size: 100%;
  max-block-size: 360px;
  object-fit: contain;
}

.markdown-editor :deep(.cm-image-caption) {
  margin-block-start: var(--space-4);
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.markdown-editor :deep(.cm-attachment-preview) {
  padding-block: var(--space-8);
}
.markdown-editor :deep(.cm-attachment-preview button) {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 2px var(--space-12);
  align-items: center;
  inline-size: min(100%, 440px);
  padding: var(--space-12) var(--space-16);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-8);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.markdown-editor :deep(.cm-attachment-preview button:hover) {
  border-color: var(--color-accent);
}
.markdown-editor :deep(.cm-attachment-preview button:focus-visible) {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.markdown-editor :deep(.cm-attachment-preview svg) {
  grid-row: span 2;
  inline-size: 32px;
  block-size: 32px;
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 1.5;
  stroke-linejoin: round;
}
.markdown-editor :deep(.cm-attachment-name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.markdown-editor :deep(.cm-attachment-detail) {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}
</style>

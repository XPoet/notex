<script setup lang="ts">
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useClipboardPaste } from './useClipboardPaste'
import NoteImageViewer from './NoteImageViewer.vue'
import { imagePreviews, refreshImagePreviews, replaceImageReferences } from './imagePreviews'
import { EditHistory } from './editHistory'
import { searchHighlights } from './searchHighlights'
import { getNoteImageReferences, useNoteImages } from '@/composables/useNoteImages'
import { locale } from '@/i18n'

const props = defineProps<{
  modelValue: string
  noteId: string
  saveImage: (bytes: Uint8Array) => Promise<string>
  searchQuery?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  pasteError: [message: string]
}>()

const editorHost = useTemplateRef<HTMLDivElement>('editorHost')
const editorView = shallowRef<EditorView>()
const editorContent = ref(props.modelValue)
const imageReferences = shallowRef(getNoteImageReferences(props.modelValue))
const visibleImagePaths = shallowRef<readonly string[]>([])
const searchHighlightCompartment = new Compartment()
const { images, loadOriginal } = useNoteImages(
  () => props.noteId,
  () => imageReferences.value,
  { visiblePaths: () => visibleImagePaths.value },
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
  () => imageReferences.value,
  (path) => {
    previewPath.value = path
  },
  (path) => {
    const image = images.value.find((item) => item.relativePath === path)
    if (image !== undefined) image.failed = true
  },
)

function updateVisibleImages(view: EditorView): void {
  const ranges = view.visibleRanges
  const paths = view.state
    .field(previewField)
    .references.filter((reference) =>
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
  imageReferences.value = getNoteImageReferences(editorContent.value)
  view.dispatch({ effects: replaceImageReferences.of(imageReferences.value) })
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

const { handlePaste } = useClipboardPaste({
  insertText,
  saveImage: props.saveImage,
  onError: (message) => emit('pasteError', message),
})

function handlePasteEvent(event: ClipboardEvent): boolean {
  if (!hasClipboardImage(event.clipboardData)) {
    return false
  }
  void handlePaste(event)
  return true
}

function hasClipboardImage(clipboardData: DataTransfer | null): boolean {
  return Array.from(clipboardData?.items ?? []).some((item) => item.type.startsWith('image/'))
}

function focusEditorWhenClickingBlankArea(event: MouseEvent): void {
  const view = editorView.value
  if (event.button !== 0 || view === undefined || !(event.target instanceof Node)) {
    return
  }
  if (view.contentDOM.contains(event.target)) {
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

defineExpose({ focus })

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

watch(locale, refreshReferences)

onBeforeUnmount(() => {
  disposed = true
  if (referenceTimer !== undefined) clearTimeout(referenceTimer)
  editorHost.value?.removeEventListener('mousedown', focusEditorWhenClickingBlankArea)
  editorView.value?.destroy()
})
</script>

<template>
  <div ref="editorHost" class="markdown-editor">
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
</style>

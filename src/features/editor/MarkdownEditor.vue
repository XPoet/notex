<script setup lang="ts">
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useClipboardPaste } from './useClipboardPaste'
import NoteImageViewer from './NoteImageViewer.vue'
import { imagePreviews, refreshImagePreviews } from './imagePreviews'
import { searchHighlights } from './searchHighlights'
import { useNoteImages } from '@/composables/useNoteImages'

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
const searchHighlightCompartment = new Compartment()
const { images } = useNoteImages(
  () => props.noteId,
  () => editorContent.value,
)
const previewPath = ref<string>()
let synchronizing = false
let applyingHistory = false
const undoStack: string[] = []
const redoStack: string[] = []

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

function applyHistory(nextValue: string): void {
  const view = editorView.value
  if (view === undefined) {
    return
  }
  applyingHistory = true
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextValue } })
  applyingHistory = false
}

function undo(): boolean {
  const previousValue = undoStack.pop()
  const view = editorView.value
  if (previousValue === undefined || view === undefined) {
    return false
  }
  redoStack.push(view.state.doc.toString())
  applyHistory(previousValue)
  return true
}

function redo(): boolean {
  const nextValue = redoStack.pop()
  const view = editorView.value
  if (nextValue === undefined || view === undefined) {
    return false
  }
  undoStack.push(view.state.doc.toString())
  applyHistory(nextValue)
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
        imagePreviews(
          () => images.value,
          (path) => {
            previewPath.value = path
          },
          (path) => {
            const image = images.value.find((item) => item.relativePath === path)
            if (image !== undefined) image.failed = true
          },
        ),
        EditorView.domEventHandlers({
          paste: handlePasteEvent,
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
          if (update.docChanged) editorContent.value = update.state.doc.toString()
          if (update.docChanged && !synchronizing) {
            if (!applyingHistory) {
              undoStack.push(update.startState.doc.toString())
              redoStack.length = 0
            }
            emit('update:modelValue', update.state.doc.toString())
          }
        }),
      ],
    }),
    parent: host,
  })
  host.addEventListener('mousedown', focusEditorWhenClickingBlankArea)
  editorView.value = view
})

watch(
  () => props.modelValue,
  (value) => {
    const view = editorView.value
    if (view === undefined || view.state.doc.toString() === value) {
      return
    }
    synchronizing = true
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

onBeforeUnmount(() => {
  editorHost.value?.removeEventListener('mousedown', focusEditorWhenClickingBlankArea)
  editorView.value?.destroy()
})
</script>

<template>
  <div ref="editorHost" class="markdown-editor">
    <NoteImageViewer
      :images="images"
      :preview-path="previewPath"
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

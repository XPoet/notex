import { t, locale } from '@/i18n'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import type { NoteImage, NoteImageReference } from '@/composables/useNoteImages'

export const refreshImagePreviews = StateEffect.define<null>()
export const replaceImageReferences = StateEffect.define<readonly NoteImageReference[]>()

export interface ImagePreviewState {
  references: readonly NoteImageReference[]
  decorations: DecorationSet
}

class ImagePreviewWidget extends WidgetType {
  readonly language = locale.value

  constructor(
    readonly path: string,
    readonly label: string,
    readonly url: string | undefined,
    readonly failed: boolean,
    readonly onPreview: (path: string) => void,
    readonly onError: (path: string) => void,
  ) {
    super()
  }

  eq(other: ImagePreviewWidget): boolean {
    return (
      this.path === other.path &&
      this.language === other.language &&
      this.label === other.label &&
      this.url === other.url &&
      this.failed === other.failed
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div')
    container.className = 'cm-image-preview'
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', t('查看{value1}', { value1: this.label }))
    button.disabled = this.url === undefined || this.failed
    if (this.failed || this.url === undefined) {
      button.textContent = this.failed ? t('图片无法读取') : t('图片加载中…')
    } else {
      const image = document.createElement('img')
      image.src = this.url
      image.alt = this.label
      image.addEventListener('load', () => view.requestMeasure())
      image.addEventListener('error', () => this.onError(this.path))
      button.append(image)
      button.addEventListener('click', () => this.onPreview(this.path))
    }
    container.append(button)
    return container
  }
}

export function imagePreviews(
  images: () => NoteImage[],
  references: () => readonly NoteImageReference[],
  onPreview: (path: string) => void,
  onError: (path: string) => void,
): StateField<ImagePreviewState> {
  function decorations(state: EditorState, items: readonly NoteImageReference[]): DecorationSet {
    const byPath = new Map(images().map((image) => [image.relativePath, image]))
    return Decoration.set(
      items.map((reference) => {
        const image = byPath.get(reference.relativePath)
        return Decoration.widget({
          widget: new ImagePreviewWidget(
            reference.relativePath,
            reference.label,
            image?.url,
            image?.failed ?? false,
            onPreview,
            onError,
          ),
          block: true,
          side: 1,
        }).range(state.doc.lineAt(reference.to).to)
      }),
      true,
    )
  }

  return StateField.define<ImagePreviewState>({
    create(state) {
      return { references: references(), decorations: decorations(state, references()) }
    },
    update(value, transaction) {
      let items = value.references
      let mapped = value.decorations
      if (transaction.docChanged) {
        items = items
          .filter((reference) => transaction.changes.touchesRange(reference.from, reference.to) !== 'cover')
          .map((reference) => ({
            ...reference,
            from: transaction.changes.mapPos(reference.from, 1),
            to: transaction.changes.mapPos(reference.to, -1),
          }))
        mapped = mapped.map(transaction.changes)
      }
      let rebuild = false
      for (const effect of transaction.effects) {
        if (effect.is(replaceImageReferences)) {
          items = effect.value
          rebuild = true
        }
        if (effect.is(refreshImagePreviews)) rebuild = true
      }
      if (rebuild) mapped = decorations(transaction.state, items)
      return items === value.references && mapped === value.decorations
        ? value
        : { references: items, decorations: mapped }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  })
}

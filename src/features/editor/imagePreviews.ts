import { t, locale } from '@/i18n'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { getNoteImageReferences } from '@/composables/useNoteImages'
import type { NoteImage } from '@/composables/useNoteImages'

export const refreshImagePreviews = StateEffect.define<null>()

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
  onPreview: (path: string) => void,
  onError: (path: string) => void,
): StateField<DecorationSet> {
  function decorations(state: EditorState): DecorationSet {
    const byPath = new Map(images().map((image) => [image.relativePath, image]))
    return Decoration.set(
      getNoteImageReferences(state.doc.toString()).map((reference) => {
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

  return StateField.define<DecorationSet>({
    create: decorations,
    update(value, transaction) {
      if (transaction.docChanged || transaction.effects.some((effect) => effect.is(refreshImagePreviews))) {
        return decorations(transaction.state)
      }
      return value
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}

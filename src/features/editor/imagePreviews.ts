import { t, locale } from '@/i18n'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import type { NoteImage } from '@/composables/useNoteImages'
import type { NoteAssetReference } from './assetReferences'
import type { SavedAsset } from '@/types/assets'

export const refreshImagePreviews = StateEffect.define<null>()
export const replaceImageReferences = StateEffect.define<readonly NoteAssetReference[]>()

export interface ImagePreviewState {
  references: readonly NoteAssetReference[]
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
    readonly kind: 'image' | 'file',
    readonly size: number | undefined,
    readonly index: number,
  ) {
    super()
  }

  eq(other: ImagePreviewWidget): boolean {
    return (
      this.path === other.path &&
      this.index === other.index &&
      this.kind === other.kind &&
      this.size === other.size &&
      this.language === other.language &&
      this.label === other.label &&
      this.url === other.url &&
      this.failed === other.failed
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div')
    container.className = this.kind === 'image' ? 'cm-image-preview' : 'cm-attachment-preview'
    container.dataset.assetPath = this.path
    container.dataset.assetIndex = String(this.index)
    container.addEventListener('mousedown', (event) => {
      // WebKit selects the word under a secondary click before contextmenu fires.
      if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault()
    })
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(
      'aria-label',
      this.kind === 'image' ? t('查看{value1}', { value1: this.label }) : t('打开{value1}', { value1: this.label }),
    )
    button.disabled = this.kind === 'image' && (this.url === undefined || this.failed)
    if (this.kind === 'file') {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6')
      icon.append(path)
      const name = document.createElement('span')
      name.className = 'cm-attachment-name'
      name.textContent = this.label
      const detail = document.createElement('span')
      detail.className = 'cm-attachment-detail'
      const extension = this.path.split('.').pop()?.toUpperCase() ?? ''
      detail.textContent =
        this.size === undefined
          ? extension
          : `${extension} · ${this.size < 1024 * 1024 ? `${Math.ceil(this.size / 1024)} KB` : `${(this.size / 1024 / 1024).toFixed(1)} MB`}`
      button.append(icon, name, detail)
      button.addEventListener('click', () => this.onPreview(this.path))
    } else if (this.failed || this.url === undefined) {
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
    if (this.kind === 'image') {
      const caption = document.createElement('div')
      caption.className = 'cm-image-caption'
      caption.textContent = this.label
      container.append(caption)
    }
    return container
  }
}

export function imagePreviews(
  images: () => NoteImage[],
  references: () => readonly NoteAssetReference[],
  onPreview: (path: string) => void,
  onError: (path: string) => void,
  assets: () => readonly SavedAsset[] = () => [],
): StateField<ImagePreviewState> {
  function decorations(state: EditorState, items: readonly NoteAssetReference[]): DecorationSet {
    const byPath = new Map(images().map((image) => [image.relativePath, image]))
    const resources = new Map(assets().map((asset) => [asset.relativePath, asset]))
    return Decoration.set(
      items.map((reference, index) => {
        const image = byPath.get(reference.relativePath)
        return Decoration.widget({
          widget: new ImagePreviewWidget(
            reference.relativePath,
            resources.get(reference.relativePath)?.originalName ?? reference.label,
            image?.url,
            image?.failed ?? false,
            onPreview,
            onError,
            reference.kind,
            resources.get(reference.relativePath)?.size,
            index,
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

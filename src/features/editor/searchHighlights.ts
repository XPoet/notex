import type { Extension } from '@codemirror/state'
import { Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { createSearchPattern } from '@/features/search/highlight'

export function searchHighlights(query: string): Extension {
  const pattern = createSearchPattern(query)
  if (pattern === undefined) return []

  const matcher = new MatchDecorator({
    regexp: pattern,
    decoration: Decoration.mark({ class: 'cm-search-match' }),
  })

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }

      update(update: ViewUpdate): void {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

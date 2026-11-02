import type { NoteDetail, NotePage, NoteSaveResult, NoteSummary } from '@/types/notes'

export function noteSummary(note: NoteDetail | NoteSummary): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    contentPreview: 'contentPreview' in note ? note.contentPreview : note.content.replace(/\s+/g, ' ').slice(0, 160),
    tagNames: 'tagNames' in note ? note.tagNames : [],
    isPinned: note.isPinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  }
}

export function noteSaveResult(note: NoteDetail): NoteSaveResult {
  return { id: note.id, updatedAt: note.updatedAt, summary: noteSummary(note) }
}

export function notePage(notes: readonly NoteDetail[], request: unknown): NotePage {
  let filtered = [...notes]
  let offset = 0
  let limit = 50
  if (typeof request === 'object' && request !== null) {
    if ('categoryId' in request) filtered = filtered.filter((note) => note.categoryId === request.categoryId)
    if ('uncategorized' in request && request.uncategorized === true)
      filtered = filtered.filter((note) => note.categoryId === undefined)
    if ('query' in request && typeof request.query === 'string') {
      const query = request.query.trim().toLowerCase()
      filtered = filtered.filter((note) =>
        `${note.title}\n${noteSummary(note).contentPreview}`.toLowerCase().includes(query),
      )
    }
    if ('offset' in request && typeof request.offset === 'number') offset = request.offset
    if ('limit' in request && typeof request.limit === 'number') limit = request.limit
  }
  const items = filtered.slice(offset, offset + limit).map(noteSummary)
  return {
    items,
    total: filtered.length,
    nextOffset: offset + items.length < filtered.length ? offset + items.length : null,
  }
}

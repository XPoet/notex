import type { SavedAsset } from '@/types/assets'

export interface NoteAssetReference {
  from: number
  to: number
  relativePath: string
  label: string
  kind: 'image' | 'file'
}

export function getNoteAssetReferences(content: string): NoteAssetReference[] {
  const text = content.replace(
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n)[\s\S]*?(?:^ {0,3}\2[ \t]*(?:\n|$)|$(?![\s\S]))|(`+)[^`]*(?:\3|$)/gm,
    (code) => code.replace(/[^\n]/g, ' '),
  )
  const references: NoteAssetReference[] = []
  const pattern =
    /(!?)\[((?:\\.|[^\]\\\n])*)\]\((?:\.\/)?(assets\/(?:[\w-]+\/)?[\w-]+\.(png|jpe?g|webp|gif|pdf|docx?|pptx?|xlsx?))\)/gi
  for (const match of text.matchAll(pattern)) {
    const relativePath = match[3]
    const extension = match[4]?.toLowerCase()
    if (relativePath === undefined || extension === undefined) continue
    let escapes = 0
    for (let index = match.index - 1; index >= 0 && text[index] === '\\'; index -= 1) escapes += 1
    if (escapes % 2 !== 0) continue
    const image = match[1] === '!'
    if (image && !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) continue
    references.push({
      from: match.index,
      to: match.index + match[0].length,
      relativePath,
      label: (match[2] ?? '').replace(/\\([\\[\]])/g, '$1') || relativePath.split('/').pop() || '',
      kind: image ? 'image' : 'file',
    })
  }
  return references
}

export function assetMarkdown(asset: SavedAsset): string {
  const label = asset.originalName.replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&')
  return `${asset.mimeType.startsWith('image/') ? '!' : ''}[${label}](./${asset.relativePath})`
}

export type SplitDirection = 'right' | 'down'

export interface NotePane {
  kind: 'pane'
  id: string
  noteId?: string
}

export interface NoteSplit {
  kind: 'split'
  id: string
  direction: SplitDirection
  children: [NoteLayoutNode, NoteLayoutNode]
}

export type NoteLayoutNode = NotePane | NoteSplit

export function collectPanes(root: NoteLayoutNode): NotePane[] {
  if (root.kind === 'pane') return [root]
  return root.children.flatMap(collectPanes)
}

export function replacePaneNote(root: NoteLayoutNode, paneId: string, noteId: string | undefined): NoteLayoutNode {
  if (root.kind === 'pane') return root.id === paneId && root.noteId !== noteId ? { ...root, noteId } : root
  return {
    ...root,
    children: [replacePaneNote(root.children[0], paneId, noteId), replacePaneNote(root.children[1], paneId, noteId)],
  }
}

export function splitPane(
  root: NoteLayoutNode,
  paneId: string,
  newPane: NotePane,
  direction: SplitDirection,
  splitId: string,
): NoteLayoutNode {
  if (root.kind === 'pane') {
    return root.id === paneId ? { kind: 'split', id: splitId, direction, children: [root, newPane] } : root
  }
  return {
    ...root,
    children: [
      splitPane(root.children[0], paneId, newPane, direction, splitId),
      splitPane(root.children[1], paneId, newPane, direction, splitId),
    ],
  }
}

/** 最后一栏保持打开；移除分栏时自动合并其父级分隔。 */
export function removePane(root: NoteLayoutNode, paneId: string): NoteLayoutNode {
  if (root.kind === 'pane') return root
  const [first, second] = root.children
  if (first.kind === 'pane' && first.id === paneId) return second
  if (second.kind === 'pane' && second.id === paneId) return first
  return { ...root, children: [removePane(first, paneId), removePane(second, paneId)] }
}

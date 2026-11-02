import { Transaction } from '@codemirror/state'
import type { ChangeSet, EditorSelection, TransactionSpec } from '@codemirror/state'

interface HistoryEntry {
  undo: ChangeSet
  redo: ChangeSet
  before: EditorSelection
  after: EditorSelection
  bytes: number
  group: string | undefined
  time: number
  edits: number
}

export interface EditHistoryOptions {
  maxBytes?: number
  maxEntries?: number
  groupDelay?: number
}

function changeBytes(changes: ChangeSet): number {
  let bytes = 0
  changes.iterChanges((_from, _to, _newFrom, _newTo, inserted) => {
    bytes += inserted.length * 2 + 64
  })
  return bytes
}

// Retain changed text, never whole document snapshots. The byte budget estimates
// UTF-16 text and change metadata; it is not a measurement of the JavaScript heap.
export class EditHistory {
  private readonly undoEntries: HistoryEntry[] = []
  private readonly redoEntries: HistoryEntry[] = []
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly groupDelay: number
  private bytes = 0
  private canGroup = false

  constructor(options: EditHistoryOptions = {}) {
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    this.maxEntries = options.maxEntries ?? 200
    this.groupDelay = options.groupDelay ?? 500
  }

  get estimatedBytes(): number {
    return this.bytes
  }

  get depth(): number {
    return this.undoEntries.length
  }

  breakGroup(): void {
    this.canGroup = false
  }

  clear(): void {
    this.undoEntries.length = 0
    this.redoEntries.length = 0
    this.bytes = 0
    this.breakGroup()
  }

  record(transaction: Transaction): void {
    if (!transaction.docChanged) return
    for (const entry of this.redoEntries) this.bytes -= entry.bytes
    this.redoEntries.length = 0
    const undo = transaction.changes.invert(transaction.startState.doc)
    const event = transaction.annotation(Transaction.userEvent)
    const composition = event?.startsWith('input.type.compose') === true
    const group = composition
      ? 'input.type.compose'
      : event?.startsWith('input.type')
        ? 'input.type'
        : event?.startsWith('delete')
          ? event
          : undefined
    const time = transaction.annotation(Transaction.time) ?? Date.now()
    const previous = this.undoEntries.at(-1)
    if (
      this.canGroup &&
      group !== undefined &&
      previous !== undefined &&
      previous.group === group &&
      (composition || (previous.edits < 100 && time - previous.time <= this.groupDelay)) &&
      previous.after.eq(transaction.startState.selection)
    ) {
      this.bytes -= previous.bytes
      previous.undo = undo.compose(previous.undo)
      previous.redo = previous.redo.compose(transaction.changes)
      previous.after = transaction.state.selection
      previous.time = time
      previous.edits += 1
      previous.bytes = changeBytes(previous.undo) + changeBytes(previous.redo) + 128
      this.bytes += previous.bytes
    } else {
      const entry: HistoryEntry = {
        undo,
        redo: transaction.changes,
        before: transaction.startState.selection,
        after: transaction.state.selection,
        bytes: changeBytes(undo) + changeBytes(transaction.changes) + 128,
        group,
        time,
        edits: 1,
      }
      this.undoEntries.push(entry)
      this.bytes += entry.bytes
    }
    this.canGroup = group !== undefined
    while (this.bytes > this.maxBytes || this.undoEntries.length > this.maxEntries) {
      const removed = this.undoEntries.shift()
      if (removed === undefined) break
      this.bytes -= removed.bytes
    }
  }

  undo(): TransactionSpec | undefined {
    this.breakGroup()
    const entry = this.undoEntries.pop()
    if (entry === undefined) return undefined
    this.redoEntries.push(entry)
    return { changes: entry.undo, selection: entry.before, scrollIntoView: true }
  }

  redo(): TransactionSpec | undefined {
    this.breakGroup()
    const entry = this.redoEntries.pop()
    if (entry === undefined) return undefined
    this.undoEntries.push(entry)
    return { changes: entry.redo, selection: entry.after, scrollIntoView: true }
  }
}

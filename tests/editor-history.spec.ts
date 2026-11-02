import { EditorState, Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { EditHistory } from '@/features/editor/editHistory'

describe('增量编辑历史', () => {
  it('长文单字编辑只记录变更，恢复正文和选择，支持重做', () => {
    const content = '正文'.repeat(50_000)
    const history = new EditHistory()
    const state = EditorState.create({ doc: content, selection: { anchor: 30 } })
    const transaction = state.update({ changes: { from: 30, insert: '新' }, selection: { anchor: 31 } })
    history.record(transaction)
    expect(history.estimatedBytes).toBeLessThan(1_000)
    const undo = history.undo()
    if (undo === undefined) throw new Error('缺少撤销事务')
    const restored = transaction.state.update(undo).state
    expect(restored.doc.toString()).toBe(content)
    expect(restored.selection.main.anchor).toBe(30)
    const redo = history.redo()
    if (redo === undefined) throw new Error('缺少重做事务')
    expect(restored.update(redo).state.doc.toString()).toBe(transaction.state.doc.toString())
  })

  it('合并相邻输入和中文组合输入，粘贴保持独立撤销步骤', () => {
    const history = new EditHistory()
    let state = EditorState.create({ doc: '' })
    for (const [index, text] of ['中', '文'].entries()) {
      const transaction = state.update({
        changes: { from: index, insert: text },
        selection: { anchor: index + 1 },
        annotations: [Transaction.userEvent.of('input.type.compose'), Transaction.time.of(index * 50)],
      })
      history.record(transaction)
      state = transaction.state
    }
    expect(history.depth).toBe(1)
    const paste = state.update({ changes: { from: 2, insert: '粘贴' }, userEvent: 'input.paste' })
    history.record(paste)
    expect(history.depth).toBe(2)
    const undoPaste = history.undo()
    if (undoPaste === undefined) throw new Error('缺少粘贴撤销')
    state = paste.state.update(undoPaste).state
    expect(state.doc.toString()).toBe('中文')
    const undoTyping = history.undo()
    if (undoTyping === undefined) throw new Error('缺少输入撤销')
    expect(state.update(undoTyping).state.doc.toString()).toBe('')
  })

  it('分离光标移动后的输入并使旧重做失效', () => {
    const history = new EditHistory()
    let state = EditorState.create({ doc: 'ab' })
    const first = state.update({ changes: { from: 0, insert: '1' }, selection: { anchor: 1 }, userEvent: 'input.type' })
    history.record(first)
    history.breakGroup()
    const second = first.state.update({ changes: { from: 1, insert: '2' }, userEvent: 'input.type' })
    history.record(second)
    expect(history.depth).toBe(2)
    const undo = history.undo()
    if (undo === undefined) throw new Error('缺少撤销')
    state = second.state.update(undo).state
    const replacement = state.update({ changes: { from: 0, insert: '3' }, userEvent: 'input.type' })
    history.record(replacement)
    expect(history.redo()).toBeUndefined()
  })

  it('输入法候选停顿超过分组间隔仍完整撤销，新的组合会话独立成组', () => {
    const history = new EditHistory()
    const initial = EditorState.create({ doc: '' })
    const first = initial.update({
      changes: { from: 0, insert: '中' },
      selection: { anchor: 1 },
      annotations: [Transaction.userEvent.of('input.type.compose'), Transaction.time.of(0)],
    })
    history.record(first)
    const candidate = first.state.update({
      changes: { from: 0, to: 1, insert: '中文' },
      selection: { anchor: 2 },
      annotations: [Transaction.userEvent.of('input.type.compose'), Transaction.time.of(5_000)],
    })
    history.record(candidate)
    expect(history.depth).toBe(1)
    history.breakGroup()
    const nextSession = candidate.state.update({
      changes: { from: 2, insert: '输入' },
      userEvent: 'input.type.compose',
    })
    history.record(nextSession)
    expect(history.depth).toBe(2)
    const undo = history.undo()
    if (undo === undefined) throw new Error('缺少候选撤销')
    const restored = nextSession.state.update(undo).state
    expect(restored.doc.toString()).toBe('中文')
    const undoFirstSession = history.undo()
    if (undoFirstSession === undefined) throw new Error('缺少首组撤销')
    expect(restored.update(undoFirstSession).state.doc.toString()).toBe('')
  })

  it('预算和事件数量均受限，超过预算的大粘贴不保留整篇历史', () => {
    const history = new EditHistory({ maxBytes: 1_000, maxEntries: 2 })
    let state = EditorState.create({ doc: '' })
    for (let index = 0; index < 5; index += 1) {
      const transaction = state.update({ changes: { from: index, insert: 'a' }, userEvent: 'input.paste' })
      history.record(transaction)
      state = transaction.state
    }
    expect(history.depth).toBe(2)
    expect(history.estimatedBytes).toBeLessThanOrEqual(1_000)
    history.record(state.update({ changes: { from: 0, insert: '大'.repeat(2_000) }, userEvent: 'input.paste' }))
    expect(history.depth).toBe(0)
    expect(history.estimatedBytes).toBe(0)
  })
})

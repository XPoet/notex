import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NoteSplitLayout from '@/features/workspace/NoteSplitLayout.vue'
import { collectPanes, removePane, replacePaneNote, splitPane, type NotePane } from '@/features/workspace/splitLayout'

const first: NotePane = { kind: 'pane', id: 'pane-a', noteId: 'a' }
const second: NotePane = { kind: 'pane', id: 'pane-b', noteId: 'b' }
const third: NotePane = { kind: 'pane', id: 'pane-c', noteId: 'c' }

describe('笔记分栏布局', () => {
  it('在活动分栏右侧和下方嵌套打开笔记，保留其他分栏', () => {
    const right = splitPane(first, first.id, second, 'right', 'split-1')
    const nested = splitPane(right, second.id, third, 'down', 'split-2')
    expect(nested).toEqual({
      kind: 'split',
      id: 'split-1',
      direction: 'right',
      children: [first, { kind: 'split', id: 'split-2', direction: 'down', children: [second, third] }],
    })
    expect(collectPanes(nested)).toEqual([first, second, third])
    expect(first).toEqual({ kind: 'pane', id: 'pane-a', noteId: 'a' })
  })

  it('只替换指定分栏的笔记，同一笔记可以在多个分栏打开', () => {
    const layout = splitPane(first, first.id, second, 'right', 'split-1')
    const replaced = replacePaneNote(layout, second.id, first.noteId)
    expect(collectPanes(replaced).map((pane) => pane.noteId)).toEqual(['a', 'a'])
    expect(collectPanes(layout).map((pane) => pane.noteId)).toEqual(['a', 'b'])
    expect(collectPanes(replacePaneNote(replaced, first.id, undefined))[0]?.noteId).toBeUndefined()
  })

  it('关闭分栏合并空出的分隔，保留相邻分栏和最后一栏', () => {
    const layout = splitPane(
      splitPane(first, first.id, second, 'right', 'split-1'),
      second.id,
      third,
      'down',
      'split-2',
    )
    const collapsed = removePane(layout, second.id)
    expect(collapsed).toEqual({ kind: 'split', id: 'split-1', direction: 'right', children: [first, third] })
    expect(removePane(collapsed, first.id)).toEqual(third)
    expect(removePane(third, third.id)).toEqual(third)
    expect(collectPanes(removePane(layout, 'missing'))).toEqual([first, second, third])
  })

  it('按方向渲染可拖动分隔，转发叶子内容和激活事件', async () => {
    const layout = splitPane(
      splitPane(first, first.id, second, 'right', 'split-1'),
      second.id,
      third,
      'down',
      'split-2',
    )
    const wrapper = mount(NoteSplitLayout, {
      props: { node: layout, activePaneId: second.id },
      slots: { default: '<input :value="params.pane.noteId" :data-active="params.active" />' },
      global: {
        stubs: {
          ElSplitter: { props: ['layout'], template: '<div class="splitter" :data-layout="layout"><slot /></div>' },
          ElSplitterPanel: { template: '<div><slot /></div>' },
        },
      },
    })
    expect(wrapper.findAll('.splitter').map((splitter) => splitter.attributes('data-layout'))).toEqual([
      'horizontal',
      'vertical',
    ])
    expect(wrapper.findAll('input').map((input) => input.element.value)).toEqual(['a', 'b', 'c'])
    expect(wrapper.get('[data-pane-id="pane-b"]').classes()).toContain('note-split-pane--active')
    await wrapper.get('[data-pane-id="pane-c"] input').trigger('pointerdown')
    await wrapper.get('[data-pane-id="pane-a"] input').trigger('focusin')
    expect(wrapper.emitted('activate')).toEqual([['pane-c'], ['pane-a']])
    wrapper.unmount()
  })
})

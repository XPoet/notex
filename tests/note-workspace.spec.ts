import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import NoteWorkspace from '@/features/workspace/NoteWorkspace.vue'
import { removePane, splitPane, type NotePane } from '@/features/workspace/splitLayout'

const first: NotePane = { kind: 'pane', id: 'pane-a', noteId: 'a' }
const second: NotePane = { kind: 'pane', id: 'pane-b', noteId: 'b' }
const third: NotePane = { kind: 'pane', id: 'pane-c', noteId: 'c' }
const stubs = {
  ElSplitter: { props: ['layout'], template: '<div :data-layout="layout"><slot /></div>' },
  ElSplitterPanel: { template: '<div><slot /></div>' },
}

describe('稳定笔记编辑器容器', () => {
  it('拆分、嵌套和合并仅移动已有编辑器 DOM，保留组件状态和待完成操作', async () => {
    const mounted: string[] = []
    const unmounted: string[] = []
    const complete = new Map<string, () => void>()
    const Editor = defineComponent({
      props: { paneId: { type: String, required: true } },
      setup(props) {
        const value = ref('保留的草稿')
        onMounted(() => {
          mounted.push(props.paneId)
          complete.set(props.paneId, () => {
            value.value += '附件完成'
          })
        })
        onUnmounted(() => {
          unmounted.push(props.paneId)
          complete.delete(props.paneId)
        })
        return () => h('textarea', { value: value.value, 'data-editor-id': props.paneId })
      },
    })
    const wrapper = mount(NoteWorkspace, {
      props: { node: first, activePaneId: first.id },
      slots: { default: ({ pane }) => h(Editor, { paneId: pane.id }) },
      global: { stubs },
    })
    await flushPromises()
    const original = wrapper.get(`[data-editor-id="${first.id}"]`).element
    const right = splitPane(first, first.id, second, 'right', 'split-1')
    await wrapper.setProps({ node: right, activePaneId: second.id })
    await flushPromises()
    expect(wrapper.get(`[data-pane-id="${first.id}"] textarea`).element).toBe(original)
    expect(mounted).toEqual([first.id, second.id])
    expect(unmounted).toEqual([])

    const nested = splitPane(right, first.id, third, 'down', 'split-2')
    await wrapper.setProps({ node: nested })
    await flushPromises()
    complete.get(first.id)?.()
    await flushPromises()
    expect(wrapper.get(`[data-pane-id="${first.id}"] textarea`).element).toBe(original)
    expect(wrapper.get('textarea[data-editor-id="pane-a"]').element.value).toBe('保留的草稿附件完成')
    expect(mounted).toEqual([first.id, second.id, third.id])
    expect(unmounted).toEqual([])

    const collapsed = removePane(nested, third.id)
    await wrapper.setProps({ node: collapsed })
    await flushPromises()
    expect(wrapper.get(`[data-pane-id="${first.id}"] textarea`).element).toBe(original)
    expect(unmounted).toEqual([third.id])
    await wrapper.setProps({ node: removePane(collapsed, second.id), activePaneId: first.id })
    await flushPromises()
    expect(wrapper.get(`[data-pane-id="${first.id}"] textarea`).element).toBe(original)
    expect(mounted.filter((id) => id === first.id)).toHaveLength(1)
    expect(unmounted).toEqual([third.id, second.id])
    wrapper.unmount()
    expect(unmounted).toEqual([third.id, second.id, first.id])
  })

  it('把内容放入对应 host，转发鼠标和焦点激活，并更新插槽的活动状态', async () => {
    const wrapper = mount(NoteWorkspace, {
      props: { node: splitPane(first, first.id, second, 'right', 'split-1'), activePaneId: first.id },
      slots: { default: ({ pane, active }) => h('input', { 'data-note-id': pane.noteId, 'data-active': active }) },
      global: { stubs },
    })
    await flushPromises()
    expect(wrapper.findAll('.note-workspace-staging input')).toHaveLength(0)
    expect(wrapper.get('[data-pane-id="pane-a"] input').attributes('data-note-id')).toBe('a')
    expect(wrapper.get('[data-pane-id="pane-a"] input').attributes('data-active')).toBe('true')
    await wrapper.get('[data-pane-id="pane-b"] input').trigger('pointerdown')
    await wrapper.get('[data-pane-id="pane-b"] input').trigger('focusin')
    expect(wrapper.emitted('activate')).toEqual([[second.id], [second.id]])
    await wrapper.setProps({ activePaneId: second.id })
    await flushPromises()
    expect(wrapper.get('[data-pane-id="pane-a"] input').attributes('data-active')).toBe('false')
    expect(wrapper.get('[data-pane-id="pane-b"] input').attributes('data-active')).toBe('true')
    wrapper.unmount()
  })

  it('DOM 移动导致滚动归零时恢复原位置，保留选区并允许之后正常滚动', async () => {
    const wrapper = mount(NoteWorkspace, {
      props: { node: first, activePaneId: first.id },
      slots: {
        default: ({ pane }) =>
          h('div', { class: 'cm-scroller' }, [h('textarea', { value: (pane.noteId ?? '').repeat(20) })]),
      },
      global: { stubs },
    })
    await flushPromises()
    const scroller = wrapper.get<HTMLElement>('[data-pane-id="pane-a"] .cm-scroller').element
    const input = wrapper.get('textarea').element
    input.setSelectionRange(2, 5)
    let parent = scroller.parentElement
    let top = 120
    let left = 40
    function resetWhenMoved(): void {
      if (scroller.parentElement === parent) return
      parent = scroller.parentElement
      top = 0
      left = 0
    }
    // jsdom 不做滚动布局，模拟浏览器在 reparent 后清空滚动位置。
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 300 },
      scrollWidth: { value: 1500 },
      clientWidth: { value: 400 },
      scrollTop: {
        get() {
          resetWhenMoved()
          return top
        },
        set(value: number) {
          resetWhenMoved()
          top = value
        },
      },
      scrollLeft: {
        get() {
          resetWhenMoved()
          return left
        },
        set(value: number) {
          resetWhenMoved()
          left = value
        },
      },
    })
    const right = splitPane(first, first.id, second, 'right', 'split-1')
    await wrapper.setProps({ node: right })
    await flushPromises()
    expect(scroller.scrollTop).toBe(120)
    expect(scroller.scrollLeft).toBe(40)
    expect(wrapper.get('[data-pane-id="pane-a"] textarea').element).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])

    scroller.scrollTop = 240
    await flushPromises()
    expect(scroller.scrollTop).toBe(240)
    await wrapper.setProps({ node: removePane(right, second.id) })
    await flushPromises()
    expect(scroller.scrollTop).toBe(240)
    expect(scroller.scrollLeft).toBe(40)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
    wrapper.unmount()
  })

  it('等待分隔布局完成测量后重试恢复，用户开始滚动后取消剩余恢复', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++frameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    function runFrame(): void {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(performance.now())
    }
    const wrapper = mount(NoteWorkspace, {
      props: { node: first, activePaneId: first.id },
      slots: { default: () => h('div', { class: 'cm-scroller' }, '长文') },
      global: { stubs },
    })
    try {
      await flushPromises()
      const scroller = wrapper.get<HTMLElement>('.cm-scroller').element
      let measured = false
      let top = 180
      Object.defineProperty(scroller, 'scrollTop', {
        get: () => top,
        set: (value: number) => {
          top = measured ? value : 0
        },
      })
      const right = splitPane(first, first.id, second, 'right', 'split-1')
      await wrapper.setProps({ node: right })
      await flushPromises()
      expect(scroller.scrollTop).toBe(0)
      runFrame()
      measured = true
      runFrame()
      expect(scroller.scrollTop).toBe(180)

      measured = false
      await wrapper.setProps({ node: removePane(right, second.id) })
      await flushPromises()
      expect(scroller.scrollTop).toBe(0)
      await wrapper.get('.cm-scroller').trigger('wheel')
      measured = true
      scroller.scrollTop = 360
      runFrame()
      runFrame()
      expect(scroller.scrollTop).toBe(360)
      expect(frames.size).toBe(0)
    } finally {
      wrapper.unmount()
      vi.unstubAllGlobals()
    }
  })
})

import { DOMWrapper, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import NoteList from '@/features/notes/NoteList.vue'
import NoteContextMenu from '@/features/notes/NoteContextMenu.vue'
import type { NoteSummary } from '@/types/notes'

function createNotes(count: number): NoteSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `note-${index}`,
    title: `笔记 ${index}`,
    contentPreview: `第 ${index} 条笔记的摘要。`,
    tagNames: [],
    isPinned: false,
    createdAt: '2026-07-26T00:00:00Z',
    updatedAt: '2026-07-26T00:00:00Z',
  }))
}

describe('NoteList', () => {
  it('右键未选中的笔记显示带图标的拆分菜单，并传递该笔记及拆分方向', async () => {
    const wrapper = mount(NoteList, {
      props: { notes: createNotes(2), loading: false, selectedId: 'note-0' },
      global: {
        stubs: {
          Teleport: true,
          ElButton: { template: '<button><slot /></button>' },
          ElIcon: { template: '<i><slot /></i>' },
          ElInput: { template: '<input />' },
          ElScrollbar: { template: '<div><slot /></div>' },
        },
      },
    })
    const target = wrapper.findAll('.note-list-item')[1]
    await target?.trigger('contextmenu', { clientX: 300, clientY: 200 })
    const items = wrapper.findAll('[role="menuitem"]')
    expect(items.map((item) => item.text())).toEqual(['向右拆分', '向下拆分'])
    expect(items.every((item) => item.find('svg').exists())).toBe(true)
    expect(wrapper.emitted('select')).toBeUndefined()
    await items[0]?.trigger('click')
    expect(wrapper.emitted('split')).toEqual([['note-1', 'right']])
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await target?.trigger('contextmenu', { clientX: 300, clientY: 200 })
    await wrapper.findAll('[role="menuitem"]')[1]?.trigger('click')
    expect(wrapper.emitted('split')?.[1]).toEqual(['note-1', 'down'])
    wrapper.unmount()
  })

  it('键盘打开菜单后可导航，Escape 关闭并把焦点还给笔记', async () => {
    const wrapper = mount(NoteList, {
      attachTo: document.body,
      props: { notes: createNotes(1), loading: false },
      global: {
        stubs: {
          ElButton: { template: '<button><slot /></button>' },
          ElIcon: { template: '<i><slot /></i>' },
          ElInput: { template: '<input />' },
          ElScrollbar: { template: '<div><slot /></div>' },
        },
      },
    })
    const target = wrapper.get<HTMLButtonElement>('.note-list-item')
    target.element.focus()
    await target.trigger('keydown', { key: 'F10', shiftKey: true })
    await nextTick()
    const body = new DOMWrapper(document.body)
    const items = body.findAll('[role="menuitem"]')
    expect(document.activeElement).toBe(items[0]?.element)
    await items[0]?.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1]?.element)
    await items[1]?.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(items[0]?.element)
    await items[0]?.trigger('keydown', { key: 'Escape' })
    expect(body.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(target.element)
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })

  it('菜单避开窗口边界，点击外部和窗口失焦时关闭', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 184, 84))
    const wrapper = mount(NoteContextMenu, {
      props: { x: window.innerWidth, y: window.innerHeight },
    })
    const menu = new DOMWrapper(document.body).get<HTMLElement>('[role="menu"]')
    await nextTick()
    await nextTick()
    expect(menu.element.style.left).toBe(`${window.innerWidth - 184 - 8}px`)
    expect(menu.element.style.top).toBe(`${window.innerHeight - 84 - 8}px`)
    window.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    window.dispatchEvent(new Event('blur'))
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
    bounds.mockRestore()
  })

  it('显示当前分类标题', () => {
    const wrapper = mount(NoteList, {
      props: {
        notes: [],
        categoryName: '工作项目',
        loading: false,
      },
    })

    expect(wrapper.get('.note-list-title').text()).toBe('工作项目')
  })

  it('在大量笔记时只渲染当前可见窗口，滚动后更新窗口内容', async () => {
    const wrapper = mount(NoteList, {
      props: {
        notes: createNotes(10_000),
        loading: false,
      },
      global: {
        stubs: {
          ElButton: { template: '<button><slot /></button>' },
          ElIcon: { template: '<i><slot /></i>' },
          ElInput: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
          ElScrollbar: {
            setup() {
              return { wrapRef: ref<HTMLDivElement>() }
            },
            template: '<div ref="wrapRef"><slot /></div>',
          },
        },
      },
    })

    const listItems = wrapper.get('.note-list-items')
    Object.defineProperty(listItems.element, 'clientHeight', { configurable: true, value: 520 })
    await listItems.trigger('scroll')

    expect(wrapper.findAll('.note-list-item')).toHaveLength(18)
    expect(wrapper.text()).toContain('笔记 0')
    expect(wrapper.text()).not.toContain('笔记 9999')

    Object.defineProperty(listItems.element, 'scrollTop', { configurable: true, value: 96 * 500 })
    await listItems.trigger('scroll')

    expect(wrapper.text()).toContain('笔记 494')
    expect(wrapper.text()).toContain('笔记 510')
  })
})

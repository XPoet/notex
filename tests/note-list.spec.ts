import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import NoteList from '@/features/notes/NoteList.vue'
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
  it('显示当前分类标题', () => {
    const wrapper = mount(NoteList, {
      props: {
        notes: [],
        categoryName: '工作项目',
        loading: false,
      },
    })

    expect(wrapper.get('.note-list-title').text()).toBe('工作项目笔记')
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

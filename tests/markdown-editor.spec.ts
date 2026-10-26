import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import MarkdownEditor from '@/features/editor/MarkdownEditor.vue'

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readImage: vi.fn(),
}))

function createPlainTextPasteEvent(text: string): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (format: string) => (format === 'text/plain' ? text : ''),
      items: [],
    },
  })
  return event
}

describe('MarkdownEditor', () => {
  it('高亮中文、英文和多个关键词，忽略大小写，并将正则符号按普通文本匹配', async () => {
    const content = '学习资料 GitHub github GITHUB a+b aab [备注] 😀学习资料'
    const wrapper = mount(MarkdownEditor, {
      props: {
        noteId: 'note',
        modelValue: content,
        searchQuery: '  学习资料  github a+b [备注]  ',
        saveImage: vi.fn(),
      },
    })

    expect(wrapper.findAll('.cm-search-match').map((match) => match.text())).toEqual([
      '学习资料',
      'GitHub',
      'github',
      'GITHUB',
      'a+b',
      '[备注]',
      '学习资料',
    ])
    expect(wrapper.get('.cm-content').text()).toBe(content)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await wrapper.setProps({ searchQuery: 'aab' })
    expect(wrapper.findAll('.cm-search-match').map((match) => match.text())).toEqual(['aab'])
    await wrapper.setProps({ searchQuery: '   ' })
    expect(wrapper.find('.cm-search-match').exists()).toBe(false)
    expect(wrapper.get('.cm-content').text()).toBe(content)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('正文编辑、撤销和重做后更新匹配，不将搜索高亮写入内容或撤销历史', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        noteId: 'note',
        modelValue: '正文',
        searchQuery: '搜索',
        saveImage: vi.fn(),
      },
    })

    wrapper.get('.cm-content').element.dispatchEvent(createPlainTextPasteEvent('搜索 '))
    await nextTick()
    expect(wrapper.get('.cm-search-match').text()).toBe('搜索')
    expect(wrapper.emitted('update:modelValue')).toEqual([['搜索 正文']])

    await wrapper.setProps({ searchQuery: '正文' })
    await wrapper.get('.cm-content').trigger('keydown', { key: 'z', ctrlKey: true })
    expect(wrapper.get('.cm-content').text()).toBe('正文')
    expect(wrapper.get('.cm-search-match').text()).toBe('正文')
    await wrapper.get('.cm-content').trigger('keydown', { key: 'z', ctrlKey: true, shiftKey: true })
    expect(wrapper.get('.cm-content').text()).toBe('搜索 正文')
    expect(wrapper.get('.cm-search-match').text()).toBe('正文')

    await wrapper.setProps({ modelValue: '新正文，正文仍然可搜索' })
    expect(wrapper.findAll('.cm-search-match')).toHaveLength(2)
    wrapper.unmount()
  })

  it('由 CodeMirror 原生处理纯文本粘贴并同步模型值', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        noteId: 'note',
        modelValue: '',
        saveImage: vi.fn(),
      },
    })
    const pasteEvent = createPlainTextPasteEvent('粘贴文本')

    wrapper.find('.cm-content').element.dispatchEvent(pasteEvent)
    await nextTick()

    expect(pasteEvent.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toEqual([['粘贴文本']])
    wrapper.unmount()
  })

  it('由 CodeMirror 原生粘贴多行连字符文本并同步模型值', async () => {
    const content =
      '9xxxx-2xxxx\naxxxx-cxxxx\n0xxxx-2xxxx\nbxxxx-acccc\n5xxxx-ccccc\ndcccc-5cccc\n8cccc-1cccc\n8cccc-aaaaa\n6cccc-aaaaa\n3cccc-0aaaa\nccccc-daaaa\nbcccc-6aaaa\ndaaaa-bcccc\nfcccc-1bbbb\neaaaa-8aaaa\ndaaaa-4aaaa'
    const wrapper = mount(MarkdownEditor, {
      props: {
        noteId: 'note',
        modelValue: '',
        saveImage: vi.fn(),
      },
    })

    wrapper.find('.cm-content').element.dispatchEvent(createPlainTextPasteEvent(content))
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toEqual([[content]])
    wrapper.unmount()
  })

  it('在编辑区空白位置点击后，按回车会插入换行', async () => {
    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: {
        noteId: 'note',
        modelValue: '已有内容',
        saveImage: vi.fn(),
      },
    })

    await wrapper.find('.cm-scroller').trigger('mousedown', { button: 0 })
    await wrapper.find('.cm-content').trigger('keydown', { key: 'Enter' })
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toEqual([['已有内容\n']])
    wrapper.unmount()
  })
})

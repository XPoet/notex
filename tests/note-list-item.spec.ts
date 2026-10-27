import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NoteListItem from '@/features/notes/NoteListItem.vue'

describe('NoteListItem', () => {
  it('标题和摘要高亮多个关键词，保留原始文字，切换及清空关键词后同步更新', async () => {
    const note = {
      id: 'search-note',
      title: 'GitHub 学习指南',
      contentPreview: 'github 项目与学习资料，GitHub a+b aab [备注] 😀学习',
      tagNames: [],
      isPinned: false,
      createdAt: '2026-10-26T00:00:00Z',
      updatedAt: '2026-10-26T00:00:00Z',
    }
    const wrapper = mount(NoteListItem, {
      props: { note, selected: true, searchQuery: ' GITHUB 学习 a+b [备注] ' },
    })

    const title = wrapper.get('.note-list-item-title')
    const preview = wrapper.get('.note-list-item-preview')
    expect(title.findAll('mark').map((mark) => mark.text())).toEqual(['GitHub', '学习'])
    expect(preview.findAll('mark').map((mark) => mark.text())).toEqual([
      'github',
      '学习',
      'GitHub',
      'a+b',
      '[备注]',
      '学习',
    ])
    expect(title.text()).toBe(note.title)
    expect(preview.text()).toBe(note.contentPreview)
    await title.get('mark').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['search-note']])

    await wrapper.setProps({ searchQuery: 'git github' })
    expect(title.get('mark').text()).toBe('GitHub')
    await wrapper.setProps({ searchQuery: 'aab' })
    expect(title.find('mark').exists()).toBe(false)
    expect(preview.get('mark').text()).toBe('aab')
    await wrapper.setProps({ searchQuery: '   ' })
    expect(wrapper.find('mark').exists()).toBe(false)
    expect(title.text()).toBe(note.title)
    expect(preview.text()).toBe(note.contentPreview)
    wrapper.unmount()
  })

  it('含 HTML 的笔记始终作为纯文本展示，高亮不会创建图片或脚本节点', () => {
    const note = {
      id: 'html-note',
      title: '<img src="x" onerror="alert(1)">',
      contentPreview: '<script>alert(1)</script> a+b',
      tagNames: [],
      isPinned: false,
      createdAt: '2026-10-26T00:00:00Z',
      updatedAt: '2026-10-26T00:00:00Z',
    }
    const wrapper = mount(NoteListItem, {
      props: { note, selected: false, searchQuery: 'img script a+b' },
    })

    expect(wrapper.get('.note-list-item-title').text()).toBe(note.title)
    expect(wrapper.get('.note-list-item-preview').text()).toBe(note.contentPreview)
    expect(wrapper.findAll('mark').map((mark) => mark.text())).toEqual([
      'img',
      'script',
      'script',
      'a+b',
    ])
    expect(wrapper.find('img, script').exists()).toBe(false)
    wrapper.unmount()
  })

  it('只展示笔记内容，不展示创建时间和更新时间', () => {
    const createdAt = new Date(2026, 9, 16, 0, 1, 2).toISOString()
    const updatedAt = new Date(2026, 9, 17, 0, 1, 58).toISOString()
    const wrapper = mount(NoteListItem, {
      props: {
        note: {
          id: 'dated-note',
          title: '时间展示',
          contentPreview: '摘要',
          tagNames: [],
          isPinned: false,
          createdAt,
          updatedAt,
        },
        selected: false,
      },
      global: { stubs: { ElIcon: { template: '<i><slot /></i>' } } },
    })

    expect(wrapper.get('.note-list-item-title').text()).toBe('时间展示')
    expect(wrapper.get('.note-list-item-preview').text()).toBe('摘要')
    expect(wrapper.find('time').exists()).toBe(false)
    expect(wrapper.find('[title*="创建时间"], [title*="更新时间"]').exists()).toBe(false)
  })

  it('仅为置顶笔记显示右上角置顶图标', () => {
    const global = {
      stubs: {
        ElIcon: { template: '<i><slot /></i>' },
      },
    }
    const pinnedWrapper = mount(NoteListItem, {
      props: {
        note: {
          id: 'pinned-note',
          title: '置顶笔记',
          contentPreview: '摘要',
          tagNames: ['工作', '重要'],
          isPinned: true,
          createdAt: '2026-07-27T00:00:00Z',
          updatedAt: '2026-07-27T00:00:00Z',
        },
        selected: false,
      },
      global,
    })
    const regularWrapper = mount(NoteListItem, {
      props: {
        note: {
          id: 'regular-note',
          title: '普通笔记',
          contentPreview: '摘要',
          tagNames: [],
          isPinned: false,
          createdAt: '2026-07-27T00:00:00Z',
          updatedAt: '2026-07-27T00:00:00Z',
        },
        selected: false,
      },
      global,
    })

    expect(pinnedWrapper.find('.note-list-item-pin').exists()).toBe(true)
    expect(regularWrapper.find('.note-list-item-pin').exists()).toBe(false)
    expect(pinnedWrapper.find('.note-list-item-tags').exists()).toBe(false)
    expect(pinnedWrapper.text()).not.toContain('#工作')
    expect(pinnedWrapper.text()).not.toContain('#重要')
    expect(regularWrapper.find('.note-list-item-tags').exists()).toBe(false)
  })
})

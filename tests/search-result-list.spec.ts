import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SearchResultList from '@/features/search/SearchResultList.vue'

describe('SearchResultList', () => {
  it('为当前结果和加载更多的结果传递关键词，修改与清空查询后更新高亮', async () => {
    const first = {
      id: 'first',
      title: 'GitHub 备忘',
      contentPreview: 'github 整理资料',
      tagNames: [],
      updatedAt: '2026-10-26T00:00:00Z',
    }
    const second = {
      ...first,
      id: 'second',
      title: 'GitHub 资料',
      contentPreview: 'GitHub 项目笔记',
    }
    const wrapper = mount(SearchResultList, {
      props: {
        query: 'github',
        results: [first],
        loading: false,
        loadingMore: false,
        rebuilding: false,
        hasNextPage: true,
      },
      global: { stubs: { ElButton: { template: '<button><slot /></button>' } } },
    })

    expect(wrapper.findAll('mark').map((mark) => mark.text())).toEqual(['GitHub', 'github'])
    await wrapper.get('.search-more button').trigger('click')
    expect(wrapper.emitted('loadMore')).toEqual([[]])
    await wrapper.setProps({ results: [first, second], hasNextPage: false })
    expect(wrapper.findAll('mark').map((mark) => mark.text())).toEqual([
      'GitHub',
      'github',
      'GitHub',
      'GitHub',
    ])
    await wrapper.get('.search-result-title mark').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['first']])

    await wrapper.setProps({ query: '资料' })
    expect(wrapper.findAll('.search-result-title mark').map((mark) => mark.text())).toEqual([
      '资料',
    ])
    expect(wrapper.findAll('.search-result-preview mark').map((mark) => mark.text())).toEqual([
      '资料',
    ])
    await wrapper.setProps({ query: '' })
    expect(wrapper.find('mark').exists()).toBe(false)
    expect(wrapper.find('.search-result-item').exists()).toBe(false)
    wrapper.unmount()
  })
})

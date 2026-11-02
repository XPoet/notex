import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
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
    expect(wrapper.findAll('mark').map((mark) => mark.text())).toEqual(['GitHub', 'github', 'GitHub', 'GitHub'])
    await wrapper.get('.search-result-title mark').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['first']])

    await wrapper.setProps({ query: '资料' })
    expect(wrapper.findAll('.search-result-title mark').map((mark) => mark.text())).toEqual(['资料'])
    expect(wrapper.findAll('.search-result-preview mark').map((mark) => mark.text())).toEqual(['资料'])
    await wrapper.setProps({ query: '' })
    expect(wrapper.find('mark').exists()).toBe(false)
    expect(wrapper.find('.search-result-item').exists()).toBe(false)
    wrapper.unmount()
  })

  it('累计大量结果时只渲染可见窗口，沿用外层滚动并可用键盘进入下一窗口', async () => {
    const results = Array.from({ length: 10_000 }, (_, index) => ({
      id: `result-${index}`,
      title: `资料 ${index}`,
      contentPreview: `正文 ${index}`,
      tagNames: [],
      updatedAt: '2026-10-26T00:00:00Z',
    }))
    const scrollHost = document.createElement('div')
    scrollHost.style.overflowY = 'auto'
    Object.defineProperty(scrollHost, 'clientHeight', { value: 520 })
    document.body.append(scrollHost)
    const wrapper = mount(SearchResultList, {
      attachTo: scrollHost,
      props: {
        query: '资料',
        results,
        loading: false,
        loadingMore: false,
        rebuilding: false,
        hasNextPage: true,
      },
      global: { stubs: { ElButton: { template: '<button><slot /></button>' } } },
    })
    Object.defineProperty(wrapper.element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, -scrollHost.scrollTop, 600, 1_320_000),
    })
    await nextTick()
    expect(wrapper.findAll('.search-result-item').length).toBeLessThan(25)
    expect(wrapper.get('.search-result-row').attributes('aria-posinset')).toBe('1')

    scrollHost.scrollTop = 132 * 500
    scrollHost.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(wrapper.get('.search-result-row').attributes('data-result-id')).toBe('result-495')
    expect(wrapper.findAll('.search-result-item').length).toBeLessThan(25)
    const rows = wrapper.findAll('.search-result-row')
    const last = rows.at(-1)
    expect(last).toBeDefined()
    const nextIndex = Number(last?.attributes('aria-posinset'))
    await last?.get('button').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement?.closest('.search-result-row')?.getAttribute('data-result-id')).toBe(
      `result-${nextIndex}`,
    )

    await wrapper.setProps({ query: '新查询', results: results.slice(0, 30) })
    expect(scrollHost.scrollTop).toBe(0)
    expect(wrapper.get('.search-result-row').attributes('data-result-id')).toBe('result-0')
    wrapper.unmount()
    scrollHost.remove()
  })
})

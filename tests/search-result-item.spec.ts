import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SearchResultItem from '@/features/search/SearchResultItem.vue'

describe('SearchResultItem', () => {
  it('以纯文本呈现元信息并将打开意图交给父组件', async () => {
    const wrapper = mount(SearchResultItem, {
      props: {
        query: 'script',
        result: {
          id: 'note-1',
          title: '',
          contentPreview: '<script>不应作为 HTML 执行</script>',
          categoryPath: '工作 / 项目',
          tagNames: ['本地优先', '开发记录'],
          updatedAt: '2026-07-24T14:32:00Z',
        },
      },
      global: {
        stubs: { ElIcon: { template: '<i><slot /></i>' } },
      },
    })

    expect(wrapper.text()).toContain('无标题笔记')
    expect(wrapper.text()).toContain('工作 / 项目')
    expect(wrapper.text()).toContain('本地优先')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.findAll('mark').map((mark) => mark.text())).toEqual(['script', 'script'])

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['note-1']])
    wrapper.unmount()
  })

  it('在标题、摘要、分类和标签中高亮当前关键词，并随搜索条件同步更新', async () => {
    const result = {
      id: 'highlight-note',
      title: 'GitHub 学习路径',
      contentPreview: '在 github 查项目，再整理学习资料和 a+b。',
      categoryPath: '学习 / GitHub资料',
      tagNames: ['github', '学习资料', 'a+b', '工作'],
      updatedAt: '2026-10-26T00:00:00Z',
    }
    const wrapper = mount(SearchResultItem, {
      props: { result, query: ' GITHUB 学习 a+b ' },
      global: {
        stubs: {
          ElIcon: { template: '<i><slot /></i>' },
          ElTag: { template: '<span class="result-tag"><slot /></span>' },
        },
      },
    })

    const title = wrapper.get('.search-result-title')
    const preview = wrapper.get('.search-result-preview')
    const category = wrapper.get('.search-result-category-path')
    expect(title.findAll('mark').map((mark) => mark.text())).toEqual(['GitHub', '学习'])
    expect(preview.findAll('mark').map((mark) => mark.text())).toEqual(['github', '学习', 'a+b'])
    expect(category.findAll('mark').map((mark) => mark.text())).toEqual(['学习', 'GitHub'])
    expect(wrapper.findAll('.result-tag mark').map((mark) => mark.text())).toEqual([
      'github',
      '学习',
      'a+b',
    ])
    expect(title.text()).toBe(result.title)
    expect(preview.text()).toBe(result.contentPreview)
    expect(category.text()).toBe(result.categoryPath)
    await title.get('mark').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['highlight-note']])

    await wrapper.setProps({ query: 'a+b' })
    expect(title.find('mark').exists()).toBe(false)
    expect(category.find('mark').exists()).toBe(false)
    expect(wrapper.findAll('mark').map((mark) => mark.text())).toEqual(['a+b', 'a+b'])
    await wrapper.setProps({ query: '' })
    expect(wrapper.find('mark').exists()).toBe(false)
    expect(title.text()).toBe(result.title)
    expect(preview.text()).toBe(result.contentPreview)
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EditorStatusBar from '@/features/editor/EditorStatusBar.vue'

describe('EditorStatusBar', () => {
  it('显示正文的字数、字符数和行数', () => {
    const wrapper = mount(EditorStatusBar, {
      props: { content: '墨盒 NoteX\n第二行', saveStatus: 'saved' },
    })

    expect(wrapper.text()).toContain('字数 6')
    expect(wrapper.text()).toContain('字符 10')
    expect(wrapper.text()).toContain('行 2')
    expect(wrapper.text()).toContain('已保存')
  })

  it('空内容仍显示一行', () => {
    const wrapper = mount(EditorStatusBar, { props: { content: '', saveStatus: 'editing' } })

    expect(wrapper.text()).toContain('字数 0')
    expect(wrapper.text()).toContain('字符 0')
    expect(wrapper.text()).toContain('行 1')
  })

  it('保存失败时允许在状态栏重试', async () => {
    const wrapper = mount(EditorStatusBar, {
      props: { content: '', saveStatus: 'failed', saveError: '网络错误' },
    })

    expect(wrapper.text()).toContain('网络错误')
    await wrapper.get('el-button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})

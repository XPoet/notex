import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EditorStatusBar from '@/features/editor/EditorStatusBar.vue'
import { countContent } from '@/features/editor/contentStatistics'

describe('EditorStatusBar', () => {
  afterEach(() => vi.useRealTimers())
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

  it('连续输入每 200 ms 统计最新正文，卸载时取消待执行统计', async () => {
    vi.useFakeTimers()
    const wrapper = mount(EditorStatusBar, { props: { content: '', saveStatus: 'editing' } })
    await wrapper.setProps({ content: '中' })
    await vi.advanceTimersByTimeAsync(100)
    await wrapper.setProps({ content: '中文' })
    expect(wrapper.text()).toContain('字数 0')
    await vi.advanceTimersByTimeAsync(100)
    expect(wrapper.text()).toContain('字数 2')
    await wrapper.setProps({ content: '中文 ABC' })
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('单次遍历保持中文词、拉丁词、Unicode 字符和 CRLF 统计语义', () => {
    expect(countContent('中文abc中ABC_12 😀\r\n下一行\r末行\n')).toEqual({ words: 10, characters: 18, lines: 4 })
  })
})

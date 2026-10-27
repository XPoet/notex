import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NoteEditor from '@/features/editor/NoteEditor.vue'

const { copyText, success, error } = vi.hoisted(() => ({
  copyText: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/services/clipboard', () => ({ copyText }))
vi.mock('element-plus', () => ({ ElMessage: { success, error } }))

describe('复制笔记内容', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('复制当前正文并提示结果', async () => {
    const note = {
      id: 'note-1',
      title: '标题',
      content: '原始正文',
      isPinned: false,
      createdAt: '2026-10-26T00:00:00Z',
      updatedAt: '2026-10-26T00:00:00Z',
    }
    const wrapper = shallowMount(NoteEditor, {
      props: {
        note,
        saveStatus: 'saving',
        missingAssetCount: 0,
        saveImage: async () => '',
        categories: [],
        tags: [],
        selectedTagIds: [],
      },
      global: { stubs: { ElButton: { template: '<button><slot /></button>' } } },
    })

    await wrapper.setProps({ note: { ...note, content: '# 最新正文\n内容' } })
    await wrapper.get('button[aria-label="复制笔记内容"]').trigger('click')
    await flushPromises()
    expect(copyText).toHaveBeenCalledWith('# 最新正文\n内容')
    expect(success).toHaveBeenCalledWith('笔记内容已复制。')

    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await wrapper.get('button[aria-label="复制笔记内容"]').trigger('click')
    await flushPromises()
    expect(error).toHaveBeenCalledWith('复制失败，请重试。')
    wrapper.unmount()
  })
})

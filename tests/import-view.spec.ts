import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ importNote: vi.fn(), push: vi.fn(), loadCategories: vi.fn() }))
vi.mock('@/services/imports', () => ({
  importNote: mocks.importNote,
  toImportError: (error: unknown) => error,
}))
vi.mock('@/stores/categories', () => ({
  useCategoriesStore: () => ({ categories: [], load: mocks.loadCategories }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))

import ImportView from '@/views/ImportView.vue'
import { useImportsStore } from '@/stores/imports'

const ButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { slots, attrs }) {
    return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.())
  },
})

function mountView() {
  return mount(ImportView, {
    global: {
      stubs: {
        ManagementLayout: { template: '<main><slot name="action" /><slot /></main>' },
        ElButton: ButtonStub,
        ElIcon: { template: '<i><slot /></i>' },
      },
    },
  })
}

describe('导入笔记界面', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('从多文件选择生成清单，显示成功与失败，并打开未分类下的笔记', async () => {
    mocks.importNote.mockResolvedValueOnce({ id: 'imported', title: '会议记录' }).mockRejectedValueOnce({
      code: 'IMPORT_INVALID_ENCODING',
      message: '请转换为 UTF-8 后导入。',
    })
    const wrapper = mountView()
    const input = wrapper.get('input[type="file"]')
    expect(input.attributes('accept')).toBe('.md,.txt')
    expect(input.attributes('multiple')).toBeDefined()
    Object.defineProperty(input.element, 'files', {
      value: [new File(['# 内容'], '会议记录.md'), new File(['bad'], '旧记录.txt')],
    })
    await input.trigger('change')
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    const start = wrapper.findAll('button').find((button) => button.text().includes('开始导入'))
    await start?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('成功 1 篇，失败 1 篇')
    expect(wrapper.text()).toContain('请转换为 UTF-8 后导入。')
    await wrapper.get('[aria-label="查看笔记 会议记录"]').trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'workbench',
      query: { category: 'uncategorized', note: 'imported' },
    })
    wrapper.unmount()
    const reopened = mountView()
    expect(reopened.text()).toContain('会议记录.md')
    expect(reopened.text()).toContain('导入成功')
    reopened.unmount()
  })

  it('拖入文件后只加入清单，开始导入前允许移出', async () => {
    const wrapper = mountView()
    await wrapper.get('.import-picker').trigger('drop', { dataTransfer: { files: [new File(['text'], '拖入.txt')] } })
    expect(useImportsStore().pendingCount).toBe(1)
    expect(mocks.importNote).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="将 拖入.txt 移出列表"]').trigger('click')
    expect(wrapper.find('.import-list').exists()).toBe(false)
  })
})

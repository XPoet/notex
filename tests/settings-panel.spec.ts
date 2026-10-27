import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SettingsPanel from '@/features/settings/SettingsPanel.vue'

describe('SettingsPanel', () => {
  it('显示当前数据目录与默认导出目录的完整路径', () => {
    const wrapper = mount(SettingsPanel, {
      props: {
        settings: {
          theme: 'system',
          noteSort: 'updatedAt',
          editorFontSize: 15,
          showCategoryCounts: true,
          dataDirectory: '/Users/example/Library/Application Support/cn.xpoet.notex',
          defaultExportDirectory: '/Users/example/Desktop',
          hasCustomDefaultExportDirectory: false,
          appVersion: '0.1.0',
          schemaVersion: 3,
        },
        isSaving: false,
        isOpeningDirectory: false,
      },
      global: {
        stubs: {
          ElButton: { template: '<button><slot /></button>' },
          ElIcon: { template: '<i><slot /></i>' },
          ElOption: true,
          ElSelect: { template: '<div><slot /></div>' },
          ElSwitch: true,
        },
      },
    })

    expect(wrapper.text()).toContain('/Users/example/Library/Application Support/cn.xpoet.notex')
    expect(wrapper.text()).toContain('/Users/example/Desktop')
    expect(wrapper.text()).not.toContain('显示分类笔记数量')
    expect(wrapper.find('el-switch-stub').exists()).toBe(false)
  })
})

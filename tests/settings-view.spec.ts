import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsService = vi.hoisted(() => ({
  chooseDefaultExportDirectory: vi.fn(),
  getSettings: vi.fn(),
  openDataDirectory: vi.fn(),
  saveSettings: vi.fn(),
  toSettingsError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/settings', () => settingsService)
vi.mock('@/stores/categories', () => ({
  useCategoriesStore: () => ({ categories: [], load: vi.fn() }),
}))
vi.mock('@/stores/tags', () => ({
  useTagsStore: () => ({ tags: [], load: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import SettingsView from '@/views/SettingsView.vue'

const snapshot = {
  language: 'zh-CN' as const,
  theme: 'system' as const,
  noteSort: 'updatedAt' as const,
  editorFontSize: 15 as const,
  showCategoryCounts: true,
  dataDirectory: '/Users/example/Library/Application Support/cn.xpoet.notex',
  defaultExportDirectory: '/Users/example/Desktop',
  hasCustomDefaultExportDirectory: false,
  appVersion: '0.1.0',
  schemaVersion: 3,
}

describe('SettingsView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    settingsService.chooseDefaultExportDirectory.mockReset()
    settingsService.getSettings.mockReset()
    settingsService.openDataDirectory.mockReset()
    settingsService.saveSettings.mockReset()
    settingsService.toSettingsError.mockImplementation((error: unknown) => error)
  })

  it('选择默认导出目录后将目录写入保存请求', async () => {
    settingsService.getSettings.mockResolvedValue(snapshot)
    settingsService.chooseDefaultExportDirectory.mockResolvedValue('/Users/example/Documents/exports')
    settingsService.saveSettings.mockResolvedValue({
      ...snapshot,
      defaultExportDirectory: '/Users/example/Documents/exports',
      hasCustomDefaultExportDirectory: true,
    })
    const wrapper = mount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ManagementLayout: { template: '<main><slot /></main>' },
          SettingsPanel: {
            template: '<button @click="$emit(\'chooseDefaultExportDirectory\')">选择默认导出目录</button>',
          },
        },
      },
    })

    await flushPromises()
    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(settingsService.saveSettings).toHaveBeenCalledWith({
      language: 'zh-CN',
      theme: 'system',
      noteSort: 'updatedAt',
      editorFontSize: 15,
      showCategoryCounts: true,
      defaultExportDirectory: '/Users/example/Documents/exports',
    })
  })
})

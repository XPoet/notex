import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exportService = vi.hoisted(() => ({
  cancelExport: vi.fn(),
  chooseExportDirectory: vi.fn(),
  exportNotes: vi.fn(),
  openExportDirectory: vi.fn(),
  toExportError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/export', () => exportService)

import ExportDialog from '@/features/export/ExportDialog.vue'
import ExportDirectoryPicker from '@/features/export/ExportDirectoryPicker.vue'
import { useExportStore } from '@/stores/export'
import { useSettingsStore } from '@/stores/settings'

const scopeOptions = [
  {
    scope: { kind: 'note' as const, id: 'note-1' },
    title: '当前笔记',
    description: '仅导出正在编辑的笔记。',
  },
]

function mountDialog() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(ExportDialog, {
    props: { modelValue: true, scopeOptions },
    global: {
      plugins: [pinia],
      stubs: {
        ElButton: {
          props: ['disabled'],
          template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
        },
        ElDialog: { template: '<div><slot /><slot name="footer" /></div>' },
        ElIcon: { template: '<i><slot /></i>' },
        ElScrollbar: { template: '<div><slot /></div>' },
      },
    },
  })
}

describe('ExportDialog', () => {
  beforeEach(() => {
    exportService.cancelExport.mockReset()
    exportService.chooseExportDirectory.mockReset()
    exportService.exportNotes.mockReset()
    exportService.openExportDirectory.mockReset()
    exportService.toExportError.mockImplementation((error: unknown) => error)
  })

  it('先选择目录，再允许开始导出，并在重新打开时复用目录', async () => {
    exportService.chooseExportDirectory.mockResolvedValue('/private/export-target')
    exportService.exportNotes.mockResolvedValue({
      jobId: '118de0d6-6a4c-4f1e-bef1-5f0878069a8a',
      directoryLabel: 'NoteX 导出-20260728-173000',
      exportedCount: 1,
      failedCount: 0,
      cancelled: false,
      issues: [],
    })
    const wrapper = mountDialog()

    expect(wrapper.text()).toContain('导出范围')
    expect(wrapper.text()).toContain('导出目录')
    expect(wrapper.text()).toContain('状态反馈')
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始导出')
    expect(startButton).toBeDefined()
    await startButton?.trigger('click')
    expect(exportService.exportNotes).not.toHaveBeenCalled()

    await wrapper.findComponent(ExportDirectoryPicker).get('button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('/private/export-target')
    await startButton?.trigger('click')
    await flushPromises()

    expect(exportService.exportNotes).toHaveBeenCalledWith(
      expect.objectContaining({ targetDirectory: '/private/export-target' }),
      expect.any(Function),
    )
    expect(useExportStore().targetDirectory).toBe('/private/export-target')

    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })

    expect(wrapper.text()).toContain('/private/export-target')
    expect(useExportStore().status).toBe('idle')
  })

  it('打开时使用设置中的默认导出目录', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useSettingsStore().snapshot = {
      theme: 'system',
      noteSort: 'updatedAt',
      editorFontSize: 15,
      showCategoryCounts: true,
      dataDirectory: '/Users/example/Library/Application Support/cn.xpoet.notex',
      defaultExportDirectory: '/Users/example/Desktop',
      hasCustomDefaultExportDirectory: false,
      appVersion: '0.1.0',
      schemaVersion: 3,
    }
    const wrapper = mount(ExportDialog, {
      props: { modelValue: true, scopeOptions },
      global: {
        plugins: [pinia],
        stubs: {
          ElButton: {
            props: ['disabled'],
            template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
          },
          ElDialog: { template: '<div><slot /><slot name="footer" /></div>' },
          ElIcon: { template: '<i><slot /></i>' },
          ElScrollbar: { template: '<div><slot /></div>' },
        },
      },
    })

    expect(wrapper.text()).toContain('/Users/example/Desktop')
    expect(useExportStore().targetDirectory).toBe('/Users/example/Desktop')
  })
})

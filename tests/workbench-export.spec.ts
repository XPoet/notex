import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDetail } from '@/types/notes'

const { invoke, exportService, messages } = vi.hoisted(() => ({
  invoke: vi.fn(),
  exportService: {
    cancelExport: vi.fn(),
    chooseExportDirectory: vi.fn(),
    exportNotes: vi.fn(),
    openExportDirectory: vi.fn(),
    toExportError: vi.fn((error: unknown) => error),
  },
  messages: { error: vi.fn() },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => undefined) }),
}))
vi.mock('@/services/export', () => exportService)
vi.mock('element-plus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('element-plus')>()),
  ElMessage: messages,
}))

import WorkbenchView from '@/views/WorkbenchView.vue'
import ExportDialog from '@/features/export/ExportDialog.vue'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'

let storedNote: NoteDetail
let saveFailure: unknown

async function mountWorkbench(query: Record<string, string> = {}) {
  const pinia = createPinia()
  useSettingsStore(pinia).snapshot = {
    theme: 'system',
    noteSort: 'updatedAt',
    editorFontSize: 15,
    showCategoryCounts: true,
    dataDirectory: '/private/notex-test',
    defaultExportDirectory: '/private/export-target',
    hasCustomDefaultExportDirectory: true,
    appVersion: '0.0.9',
    schemaVersion: 3,
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'workbench', component: WorkbenchView }],
  })
  await router.push({ name: 'workbench', query })
  await router.isReady()
  const wrapper = mount(WorkbenchView, {
    global: {
      plugins: [pinia, router],
      stubs: {
        WorkspaceLayout: { template: '<div><slot name="list" /><slot name="editor" /></div>' },
        NoteList: true,
        NoteEditor: { template: '<button class="export-trigger" @click="$emit(\'export\')" />' },
        ElButton: {
          props: ['disabled'],
          template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
        },
        ElDialog: {
          props: ['modelValue'],
          template: '<div v-if="modelValue"><slot /><slot name="footer" /></div>',
        },
        ElIcon: { template: '<i><slot /></i>' },
        ElScrollbar: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return { wrapper, store: useNotesStore(pinia) }
}

describe('工作台导出范围', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    saveFailure = undefined
    storedNote = {
      id: 'note-1',
      title: '笔记一',
      content: '原正文',
      categoryId: 'work',
      isPinned: false,
      createdAt: '2026-10-16T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
    }
    exportService.exportNotes.mockResolvedValue({
      jobId: 'job',
      directoryLabel: 'NoteX 导出',
      exportedCount: 2,
      failedCount: 0,
      cancelled: false,
      issues: [],
    })
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'list_notes':
        case 'list_notes_by_category':
        case 'list_notes_by_tags':
          return [storedNote]
        case 'get_note':
          return storedNote
        case 'save_note':
          if (saveFailure !== undefined) throw saveFailure
          storedNote = { ...storedNote, ...args }
          return storedNote
        case 'list_categories':
        case 'list_tags':
        case 'list_note_tags':
          return []
        case 'get_note_asset_health':
          return { missingAssetCount: 0 }
        case 'save_recovery_draft':
          return undefined
        default:
          throw new Error(`未模拟的命令：${command}`)
      }
    })
  })

  it.each([
    { query: { category: 'work' }, categoryId: 'work' },
    { query: {}, categoryId: 'work' },
    { query: { tags: 'tag-1' }, categoryId: 'work' },
    { query: { category: 'uncategorized' }, categoryId: undefined },
  ])('从 $query 导出当前分类，先保存草稿并传入完整分类范围', async ({ query, categoryId }) => {
    storedNote.categoryId = categoryId
    const { wrapper, store } = await mountWorkbench(query)
    store.updateDraft({ title: '新标题', content: '尚未自动保存的正文' })

    await wrapper.get('.export-trigger').trigger('click')
    await flushPromises()
    const options = wrapper.findAll('.export-scope-option')
    expect(options.map((option) => option.text())).toEqual(['当前笔记', '当前分类'])
    expect(options[0].attributes('aria-pressed')).toBe('true')
    expect(storedNote.content).toBe('尚未自动保存的正文')

    await options[1].trigger('click')
    expect(options[1].attributes('aria-pressed')).toBe('true')
    const start = wrapper.findAll('button').find((button) => button.text() === '开始导出')
    expect(start).toBeDefined()
    await start?.trigger('click')
    await flushPromises()

    expect(exportService.exportNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'category', id: categoryId ?? 'uncategorized' },
        targetDirectory: '/private/export-target',
      }),
      expect.any(Function),
    )
    wrapper.unmount()
  })

  it('默认仍导出当前笔记', async () => {
    const { wrapper } = await mountWorkbench()
    await wrapper.get('.export-trigger').trigger('click')
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '开始导出')
      ?.trigger('click')
    await flushPromises()

    expect(exportService.exportNotes).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'note', id: 'note-1' } }),
      expect.any(Function),
    )
    wrapper.unmount()
  })

  it('保存失败时保留草稿并阻止导出', async () => {
    const { wrapper, store } = await mountWorkbench({ category: 'work' })
    saveFailure = { code: 'NOTE_SAVE_FAILED', message: '保存失败' }
    store.updateDraft({ title: '新标题', content: '需要保留的正文' })
    await wrapper.get('.export-trigger').trigger('click')
    await flushPromises()

    expect(wrapper.getComponent(ExportDialog).props('modelValue')).toBe(false)
    expect(exportService.exportNotes).not.toHaveBeenCalled()
    expect(store.selectedNote?.content).toBe('需要保留的正文')
    expect(messages.error).toHaveBeenCalledWith('当前笔记保存失败，暂不能导出。')
    wrapper.unmount()
  })
})

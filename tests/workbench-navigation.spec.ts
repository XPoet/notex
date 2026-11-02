import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notePage, noteSaveResult } from './helpers/note-page'
import type { NoteDetail } from '@/types/notes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import WorkbenchView from '@/views/WorkbenchView.vue'
import { useNotesStore } from '@/stores/notes'
let records: NoteDetail[]
let failure: unknown

beforeEach(() => {
  failure = undefined
  records = ['a', 'b'].map((id) => ({
    id,
    title: id,
    content: '原正文',
    categoryId: id,
    isPinned: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }))
  invoke.mockReset()
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'list_note_page') return notePage(records, args?.request)
    if (command === 'get_note') return records.find((note) => note.id === args?.id)
    if (command === 'save_note') {
      if (failure !== undefined) throw failure
      records = records.map((note) =>
        note.id === args?.id ? { ...note, title: String(args.title), content: String(args.content) } : note,
      )
      const saved = records.find((note) => note.id === args?.id)
      if (saved === undefined) throw new Error('测试笔记不存在')
      return noteSaveResult(saved)
    }
    if (command === 'get_note_asset_health') return { missingAssetCount: 0 }
    if (command === 'save_recovery_draft') return undefined
    if (['list_categories', 'list_tags', 'list_note_tags'].includes(command)) return []
    throw new Error(`未模拟命令 ${command}`)
  })
})

async function host() {
  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workbench', component: WorkbenchView },
      { path: '/settings', name: 'settings', component: { template: '<div>设置</div>' } },
    ],
  })
  await router.push({ name: 'workbench', query: { category: 'a' } })
  await router.isReady()
  const wrapper = mount(
    { template: '<RouterView />' },
    {
      global: {
        plugins: [pinia, router],
        stubs: {
          WorkspaceLayout: { template: '<main><slot name="list"/><slot name="editor"/></main>' },
          NoteList: true,
          NoteEditor: true,
          ExportDialog: true,
        },
      },
    },
  )
  await flushPromises()
  return { wrapper, router, store: useNotesStore(pinia) }
}

describe('工作台路由保存屏障', () => {
  it('在一秒自动保存之前离开工作台仍保存草稿', async () => {
    const { wrapper, router, store } = await host()
    store.updateDraft({ title: '新标题', content: '马上离开前的输入' })
    await router.push({ name: 'settings' })
    expect(records[0]?.content).toBe('马上离开前的输入')
    expect(router.currentRoute.value.name).toBe('settings')
    wrapper.unmount()
  })

  it('保存失败阻止离开，保留路由和编辑草稿', async () => {
    const { wrapper, router, store } = await host()
    store.updateDraft({ title: '新标题', content: '失败后保留' })
    failure = { code: 'NOTE_SAVE_FAILED', message: '保存失败' }
    await router.push({ name: 'settings' })
    expect(router.currentRoute.value.name).toBe('workbench')
    expect(store.selectedNote?.content).toBe('失败后保留')
    expect(store.isDirty).toBe(true)
    wrapper.unmount()
  })

  it('分类路由更新先保存旧笔记再打开目标分类', async () => {
    const { wrapper, router, store } = await host()
    store.updateDraft({ title: '新标题', content: '分类切换前的输入' })
    await router.push({ name: 'workbench', query: { category: 'b' } })
    await flushPromises()
    expect(records[0]?.content).toBe('分类切换前的输入')
    expect(store.selectedNote?.id).toBe('b')
    wrapper.unmount()
  })
})

import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDetail } from '@/types/notes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => undefined) }),
}))

import WorkbenchView from '@/views/WorkbenchView.vue'
import { useNotesStore } from '@/stores/notes'

const existingNote: NoteDetail = {
  id: 'existing',
  title: '现有笔记',
  content: '正文',
  categoryId: 'other',
  isPinned: false,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
}
let createdNote: NoteDetail | undefined

async function mountWorkbench(query: Record<string, string> = {}) {
  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workbench', component: WorkbenchView },
      ...['categories', 'tags', 'trash', 'search', 'settings'].map((name) => ({
        path: `/${name}`,
        name,
        component: { template: '<div />' },
      })),
    ],
  })
  await router.push({ name: 'workbench', query })
  await router.isReady()
  const wrapper = mount(WorkbenchView, {
    global: {
      plugins: [pinia, router],
      stubs: {
        NoteEditor: true,
        NoteList: true,
        ExportDialog: true,
        ElButton: { template: '<button><slot /></button>' },
        ElIcon: { template: '<i><slot /></i>' },
        ElScrollbar: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return { wrapper, router, store: useNotesStore(pinia) }
}

describe('工作台分类新建笔记', () => {
  beforeEach(() => {
    createdNote = undefined
    invoke.mockReset()
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'list_categories':
          return ['work', 'other'].map((id) => ({
            id,
            name: id,
            level: 1,
            sortOrder: 0,
            path: id,
            noteCount: 1,
            children: [],
          }))
        case 'list_tags':
        case 'list_note_tags':
          return []
        case 'list_notes':
          return createdNote === undefined ? [existingNote] : [createdNote, existingNote]
        case 'list_notes_by_category':
          return createdNote?.categoryId === args?.categoryId
            ? [existingNote, createdNote].filter((note) => note !== undefined)
            : [existingNote]
        case 'get_note':
          return args?.id === createdNote?.id ? createdNote : existingNote
        case 'create_note':
          createdNote = {
            ...existingNote,
            id: 'new-note',
            title: '',
            content: '',
            categoryId: typeof args?.categoryId === 'string' ? args.categoryId : undefined,
          }
          return createdNote
        case 'save_note':
          return { ...existingNote, ...args }
        case 'cleanup_empty_note':
          return undefined
        case 'get_note_asset_health':
          return { missingAssetCount: 0 }
        default:
          throw new Error(`未模拟的命令：${command}`)
      }
    })
  })

  it('点击另一分类的加号，先保存草稿再切换分类并保持新笔记选中', async () => {
    const { wrapper, router, store } = await mountWorkbench({ category: 'other' })
    store.updateDraft({ title: '编辑后的标题', content: '编辑后的正文' })

    await wrapper.get('.sidebar-category-create').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('save_note', {
      id: 'existing',
      title: '编辑后的标题',
      content: '编辑后的正文',
    })
    expect(invoke).toHaveBeenCalledWith('create_note', { categoryId: 'work' })
    expect(router.currentRoute.value.query).toEqual({ category: 'work' })
    expect(store.selectedNote?.id).toBe('new-note')
    expect(store.selectedNote?.categoryId).toBe('work')
    wrapper.unmount()
  })

  it('在当前分类连续新建，每次仅创建一条并保持新笔记选中', async () => {
    const { wrapper, router, store } = await mountWorkbench({ category: 'work' })
    const button = wrapper.get('.sidebar-category-create')

    await button.trigger('click')
    await flushPromises()
    await button.trigger('click')
    await flushPromises()

    expect(invoke.mock.calls.filter(([command]) => command === 'create_note')).toHaveLength(2)
    expect(router.currentRoute.value.query).toEqual({ category: 'work' })
    expect(store.selectedNote?.id).toBe('new-note')
    wrapper.unmount()
  })

  it('从管理页面进入创建路由后保留分类筛选和新笔记', async () => {
    const { wrapper, router, store } = await mountWorkbench({ category: 'work', create: '1' })

    expect(invoke).toHaveBeenCalledWith('create_note', { categoryId: 'work' })
    expect(router.currentRoute.value.query).toEqual({ category: 'work' })
    expect(store.selectedNote?.id).toBe('new-note')
    expect(invoke.mock.calls.filter(([command]) => command === 'create_note')).toHaveLength(1)
    wrapper.unmount()
  })

  it('全部笔记中的顶部新建按钮仍创建未分类笔记', async () => {
    const { wrapper, store } = await mountWorkbench()

    await wrapper.get('.sidebar-create-button').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('create_note', { categoryId: undefined })
    expect(store.selectedNote?.id).toBe('new-note')
    wrapper.unmount()
  })

  it.each([
    ['Command + N', { metaKey: true }],
    ['Ctrl + N', { ctrlKey: true }],
  ])('%s 保存当前草稿并在当前分类新建一条笔记', async (_shortcut, modifiers) => {
    const { wrapper, store } = await mountWorkbench({ category: 'work' })
    store.updateDraft({ title: '快捷键前的标题', content: '快捷键前的正文' })
    const event = new KeyboardEvent('keydown', { key: 'n', ...modifiers, cancelable: true })

    window.dispatchEvent(event)
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(invoke).toHaveBeenCalledWith('save_note', {
      id: 'existing',
      title: '快捷键前的标题',
      content: '快捷键前的正文',
    })
    expect(invoke).toHaveBeenCalledWith('create_note', { categoryId: 'work' })
    expect(invoke.mock.calls.filter(([command]) => command === 'create_note')).toHaveLength(1)
    expect(store.selectedNote?.id).toBe('new-note')
    wrapper.unmount()
  })
})

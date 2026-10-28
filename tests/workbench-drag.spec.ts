import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_DRAG_TYPE, type NoteDetail } from '@/types/notes'
import type { CategoryNode } from '@/types/categories'

const { invoke, messages } = vi.hoisted(() => ({
  invoke: vi.fn(),
  messages: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => undefined) }),
}))
vi.mock('element-plus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('element-plus')>()),
  ElMessage: messages,
}))

import WorkbenchView from '@/views/WorkbenchView.vue'
import { useNotesStore } from '@/stores/notes'

const categories: CategoryNode[] = [
  {
    id: 'source',
    name: '原分类',
    level: 1,
    sortOrder: 0,
    path: '原分类',
    noteCount: 2,
    children: [],
  },
  {
    id: 'work',
    name: '工作',
    level: 1,
    sortOrder: 1,
    path: '工作',
    noteCount: 0,
    children: [
      {
        id: 'child',
        name: '项目',
        parentId: 'work',
        level: 2,
        sortOrder: 0,
        path: '工作 / 项目',
        noteCount: 0,
        children: [],
      },
    ],
  },
]
let storedNotes: NoteDetail[]
let moveFailure: unknown
let saveFailure: unknown
let moveGate: Promise<void> | undefined

function createTransfer() {
  const payload = new Map<string, string>()
  return {
    get types() {
      return [...payload.keys()]
    },
    effectAllowed: 'none',
    dropEffect: 'none',
    getData: (type: string) => payload.get(type) ?? '',
    setData: (type: string, value: string) => payload.set(type, value),
  }
}

async function mountWorkbench(category?: string) {
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
  await router.push({ name: 'workbench', query: { category } })
  await router.isReady()
  const wrapper = mount(WorkbenchView, {
    global: {
      plugins: [pinia, router],
      stubs: {
        NoteEditor: true,
        ExportDialog: true,
        ElButton: { template: '<button><slot /></button>' },
        ElIcon: { template: '<i><slot /></i>' },
        ElInput: { template: '<input />' },
        ElScrollbar: { template: '<div><slot /></div>' },
        ElSplitter: { template: '<div><slot /></div>' },
        ElSplitterPanel: { template: '<section><slot /></section>' },
      },
    },
  })
  await flushPromises()
  return { wrapper, router, store: useNotesStore(pinia) }
}

describe('工作台拖拽分类', () => {
  beforeEach(() => {
    moveFailure = undefined
    saveFailure = undefined
    moveGate = undefined
    messages.success.mockReset()
    messages.error.mockReset()
    storedNotes = ['first', 'second'].map((id) => ({
      id,
      title: `${id} 笔记`,
      content: `${id} 正文`,
      categoryId: 'source',
      isPinned: false,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    }))
    invoke.mockReset()
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'list_categories':
          return categories
        case 'list_tags':
        case 'list_note_tags':
          return []
        case 'list_notes':
        case 'list_notes_by_category':
          return storedNotes
            .filter(
              (note) =>
                command === 'list_notes' ||
                note.categoryId === args?.categoryId ||
                (args?.categoryId === 'work' && note.categoryId === 'child'),
            )
            .map((note) => ({ ...note, contentPreview: note.content, tagNames: [] }))
        case 'get_note':
          return storedNotes.find((note) => note.id === args?.id)
        case 'save_note': {
          if (saveFailure !== undefined) throw saveFailure
          storedNotes = storedNotes.map((note) =>
            note.id === args?.id ? { ...note, title: String(args.title), content: String(args.content) } : note,
          )
          return storedNotes.find((note) => note.id === args?.id)
        }
        case 'set_note_category':
          if (moveFailure !== undefined) throw moveFailure
          await moveGate
          storedNotes = storedNotes.map((note) =>
            note.id === args?.noteId
              ? {
                  ...note,
                  categoryId: typeof args.categoryId === 'string' ? args.categoryId : undefined,
                }
              : note,
          )
          return undefined
        case 'save_recovery_draft':
          return undefined
        case 'get_note_asset_health':
          return { missingAssetCount: 0 }
        default:
          throw new Error(`未模拟的命令：${command}`)
      }
    })
  })

  it('拖动当前笔记到子分类，先保存草稿并在原筛选中选中相邻笔记', async () => {
    const { wrapper, router, store } = await mountWorkbench('source')
    store.updateDraft({ title: '已编辑标题', content: '尚未自动保存的内容' })
    const dataTransfer = createTransfer()
    const note = wrapper.get('.note-list-item')
    const target = wrapper.get('a[title="工作 / 项目"]')

    expect(note.attributes('draggable')).toBe('true')
    await note.trigger('dragstart', { dataTransfer })
    expect(dataTransfer.getData(NOTE_DRAG_TYPE)).toBe('first')
    expect(dataTransfer.effectAllowed).toBe('move')
    await target.trigger('dragover', { dataTransfer })
    expect(target.element.parentElement?.classList.contains('sidebar-category-item--drop-target')).toBe(true)
    await target.trigger('drop', { dataTransfer })
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('set_note_category', {
      noteId: 'first',
      categoryId: 'child',
    })
    const commands = invoke.mock.calls.map(([command]) => command)
    expect(commands.indexOf('save_note')).toBeLessThan(commands.indexOf('set_note_category'))
    expect(storedNotes.find((item) => item.id === 'first')?.content).toBe('尚未自动保存的内容')
    expect(store.notes.map((item) => item.id)).toEqual(['second'])
    expect(store.selectedNote?.id).toBe('second')
    expect(router.currentRoute.value.query.category).toBe('source')
    expect(wrapper.find('.sidebar-category-item--drop-target').exists()).toBe(false)
    expect(messages.success).toHaveBeenCalledWith('笔记已移至“项目”。')
    wrapper.unmount()
  })

  it('拖动未选中的笔记到未分类，保持当前编辑器选中态', async () => {
    const { wrapper, store } = await mountWorkbench()
    const dataTransfer = createTransfer()
    await wrapper.findAll('.note-list-item')[1].trigger('dragstart', { dataTransfer })
    await wrapper.get('a[title="未分类"]').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('set_note_category', {
      noteId: 'second',
      categoryId: undefined,
    })
    expect(storedNotes.find((item) => item.id === 'second')?.categoryId).toBeUndefined()
    expect(store.selectedNote?.id).toBe('first')
    expect(store.notes).toHaveLength(2)
    wrapper.unmount()
  })

  it('全部笔记中移动当前笔记后同步编辑器分类，并结束拖动样式', async () => {
    const { wrapper, store } = await mountWorkbench()
    const dataTransfer = createTransfer()
    const note = wrapper.get('.note-list-item')
    await note.trigger('dragstart', { dataTransfer })
    expect(note.classes()).toContain('note-list-item--dragging')
    await wrapper.get('a[title="工作"]').trigger('drop', { dataTransfer })
    await note.trigger('dragend')
    await flushPromises()

    expect(store.selectedNote?.id).toBe('first')
    expect(store.selectedNote?.categoryId).toBe('work')
    expect(store.notes).toHaveLength(2)
    expect(note.classes()).not.toContain('note-list-item--dragging')
    wrapper.unmount()
  })

  it('移走当前分类最后一条笔记后清空列表和编辑器', async () => {
    storedNotes = storedNotes.slice(0, 1)
    const { wrapper, store } = await mountWorkbench('source')
    const dataTransfer = createTransfer()
    await wrapper.get('.note-list-item').trigger('dragstart', { dataTransfer })
    await wrapper.get('a[title="工作"]').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(store.notes).toEqual([])
    expect(store.selectedNote).toBeUndefined()
    expect(store.saveStatus).toBe('idle')
    wrapper.unmount()
  })

  it('移动请求进行中继续编辑，保留新草稿并正确更新分类', async () => {
    let completeMove: (() => void) | undefined
    moveGate = new Promise<void>((resolve) => {
      completeMove = resolve
    })
    const { wrapper, store } = await mountWorkbench()
    const dataTransfer = createTransfer()
    await wrapper.get('.note-list-item').trigger('dragstart', { dataTransfer })
    await wrapper.get('a[title="工作"]').trigger('drop', { dataTransfer })
    await flushPromises()
    store.updateDraft({ title: '移动期间编辑', content: '移动期间新增的内容' })
    completeMove?.()
    await flushPromises()

    expect(store.selectedNote?.categoryId).toBe('work')
    expect(store.selectedNote?.content).toBe('移动期间新增的内容')
    expect(store.isDirty).toBe(true)
    await store.flush()
    expect(storedNotes.find((note) => note.id === 'first')?.content).toBe('移动期间新增的内容')
    expect(store.isDirty).toBe(false)
    wrapper.unmount()
  })

  it.each(['save', 'move'])('%s 失败时保留当前内容和分类，并显示错误', async (operation) => {
    const { wrapper, store } = await mountWorkbench('source')
    if (operation === 'save') {
      saveFailure = { code: 'NOTE_SAVE_FAILED', message: '草稿写入失败' }
    } else {
      moveFailure = { code: 'CATEGORY_OPERATION_FAILED', message: '分类写入失败' }
    }
    store.updateDraft({ title: '正在编辑', content: '需要保留的正文' })
    const dataTransfer = createTransfer()
    await wrapper.get('.note-list-item').trigger('dragstart', { dataTransfer })
    await wrapper.get('a[title="工作"]').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(store.selectedNote?.content).toBe('需要保留的正文')
    expect(store.selectedNote?.categoryId).toBe('source')
    expect(store.notes).toHaveLength(2)
    expect(messages.success).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledWith(operation === 'save' ? '草稿写入失败' : '分类写入失败')
    if (operation === 'save') {
      expect(invoke.mock.calls.some(([command]) => command === 'set_note_category')).toBe(false)
    }
    wrapper.unmount()
  })

  it('忽略外部文本和不在当前列表中的笔记 ID', async () => {
    const { wrapper } = await mountWorkbench()
    const target = wrapper.get('a[title="工作"]')
    const dataTransfer = createTransfer()
    dataTransfer.setData('text/plain', 'first')
    await target.trigger('dragover', { dataTransfer })
    await target.trigger('drop', { dataTransfer })
    dataTransfer.setData(NOTE_DRAG_TYPE, 'unknown-note')
    await target.trigger('drop', { dataTransfer })
    await flushPromises()

    expect(invoke.mock.calls.some(([command]) => command === 'set_note_category')).toBe(false)
    expect(messages.success).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

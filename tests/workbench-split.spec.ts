import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notePage, noteSaveResult } from './helpers/note-page'
import type { NoteDetail } from '@/types/notes'

const { invoke, messages, confirm } = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  messages: { error: vi.fn(), success: vi.fn() },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('element-plus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('element-plus')>()),
  ElMessage: messages,
  ElMessageBox: { confirm },
}))

import WorkbenchView from '@/views/WorkbenchView.vue'
import NoteEditor from '@/features/editor/NoteEditor.vue'
import NoteList from '@/features/notes/NoteList.vue'
import ExportDialog from '@/features/export/ExportDialog.vue'
import { useNotesStore } from '@/stores/notes'

let records: NoteDetail[]
let saveGate: Promise<void> | undefined
const saveFailures = new Set<string>()
const mounted: Array<{ unmount: () => void }> = []

beforeEach(() => {
  saveGate = undefined
  saveFailures.clear()
  records = ['a', 'b', 'c'].map((id) => ({
    id,
    title: `笔记 ${id}`,
    content: `${id} 的原正文`,
    categoryId: id === 'c' ? 'personal' : 'work',
    isPinned: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }))
  vi.clearAllMocks()
  confirm.mockResolvedValue('confirm')
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'list_note_page':
        return notePage(records, args?.request)
      case 'get_note': {
        const note = records.find((item) => item.id === args?.id)
        if (note === undefined) throw { code: 'NOTE_NOT_FOUND', message: '笔记不存在' }
        return { ...note }
      }
      case 'save_note': {
        if (typeof args?.id === 'string' && saveFailures.has(args.id)) {
          throw { code: 'NOTE_SAVE_FAILED', message: '保存失败' }
        }
        await saveGate
        records = records.map((note) =>
          note.id === args?.id ? { ...note, title: String(args.title), content: String(args.content) } : note,
        )
        const saved = records.find((note) => note.id === args?.id)
        if (saved === undefined) throw new Error('测试笔记不存在')
        return noteSaveResult(saved)
      }
      case 'set_note_pinned': {
        records = records.map((note) => (note.id === args?.id ? { ...note, isPinned: args.pinned === true } : note))
        return records.find((note) => note.id === args?.id)
      }
      case 'trash_note':
        records = records.filter((note) => note.id !== args?.id)
        return undefined
      case 'set_note_category':
        records = records.map((note) =>
          note.id === args?.noteId
            ? { ...note, categoryId: typeof args.categoryId === 'string' ? args.categoryId : undefined }
            : note,
        )
        return undefined
      case 'get_note_asset_health':
        return { missingAssetCount: 0 }
      case 'save_recovery_draft':
        return undefined
      case 'cleanup_empty_note':
        return false
      case 'list_categories':
      case 'list_tags':
      case 'list_note_tags':
      case 'list_note_assets':
        return []
      default:
        throw new Error(`未模拟命令 ${command}`)
    }
  })
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted.length = 0
})

async function host(query: Record<string, string> = {}) {
  const pinia = createPinia()
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
        AppSidebar: true,
        NoteList: true,
        NoteEditor: true,
        ExportDialog: true,
        ElIcon: { template: '<i><slot /></i>' },
        ElSplitter: { props: ['layout'], template: '<div :data-layout="layout"><slot /></div>' },
        ElSplitterPanel: { template: '<div><slot /></div>' },
      },
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  const store = useNotesStore(pinia)
  const editors = () => wrapper.findAllComponents(NoteEditor)
  const noteIds = () => editors().map((editor) => editor.props('note')?.id)
  function editorAt(index: number) {
    const editor = editors()[index]
    if (editor === undefined) throw new Error(`分栏 ${index} 不存在`)
    return editor
  }
  async function split(id: string, direction: 'right' | 'down') {
    wrapper.getComponent(NoteList).vm.$emit('split', id, direction)
    await flushPromises()
  }
  return { wrapper, router, store, editors, editorAt, noteIds, split }
}

describe('工作台笔记分栏', () => {
  it.each([
    ['right', 'horizontal'],
    ['down', 'vertical'],
  ] as const)('%s 拆分在对应方向同时打开当前笔记和目标笔记', async (direction, layout) => {
    const { wrapper, store, noteIds, split } = await host()
    await split('b', direction)

    expect(noteIds()).toEqual(['a', 'b'])
    expect(wrapper.get('.note-split-layout').attributes('data-layout')).toBe(layout)
    expect(wrapper.findAll('.note-split-pane--active')).toHaveLength(1)
    expect(wrapper.get('.note-split-pane--active').attributes('data-pane-id')).toBe('pane-2')
    expect(store.selectedNote?.id).toBe('b')
  })

  it('可在已有分栏中继续向下拆分，形成三个笔记的嵌套布局', async () => {
    const { wrapper, noteIds, split } = await host()
    await split('b', 'right')
    await split('c', 'down')

    expect(noteIds()).toEqual(['a', 'b', 'c'])
    const layouts = wrapper.findAll('.note-split-layout')
    expect(layouts.map((layout) => layout.attributes('data-layout'))).toEqual(['horizontal', 'vertical'])
    expect(layouts[0]?.find('.note-split-layout[data-layout="vertical"]').exists()).toBe(true)
  })

  it('点击分栏后，列表选择只替换活动分栏的笔记', async () => {
    const { wrapper, store, noteIds, split } = await host()
    await split('b', 'right')
    await wrapper.get('[data-pane-id="pane-1"]').trigger('pointerdown')
    wrapper.getComponent(NoteList).vm.$emit('select', 'c')
    await flushPromises()

    expect(noteIds()).toEqual(['c', 'b'])
    expect(store.selectedNote?.id).toBe('c')
    expect(wrapper.getComponent(NoteList).props('selectedId')).toBe('c')
  })

  it('两栏保存独立草稿，统一 flush 写入各自笔记并更新各栏保存状态', async () => {
    const { store, editorAt, split } = await host()
    await split('b', 'right')
    editorAt(0).vm.$emit('update', { title: 'A 新标题', content: 'A 的草稿' })
    editorAt(1).vm.$emit('update', { title: 'B 新标题', content: 'B 的草稿' })
    await flushPromises()

    expect(records.map((note) => note.content)).toEqual(['a 的原正文', 'b 的原正文', 'c 的原正文'])
    expect(editorAt(0).props('note')?.content).toBe('A 的草稿')
    expect(editorAt(1).props('note')?.content).toBe('B 的草稿')
    await store.flush()
    await flushPromises()

    expect(records.map((note) => note.content)).toEqual(['A 的草稿', 'B 的草稿', 'c 的原正文'])
    expect(editorAt(0).props('saveStatus')).toBe('saved')
    expect(editorAt(1).props('saveStatus')).toBe('saved')
    expect(invoke).toHaveBeenCalledWith('save_note', { id: 'a', title: 'A 新标题', content: 'A 的草稿' })
    expect(invoke).toHaveBeenCalledWith('save_note', { id: 'b', title: 'B 新标题', content: 'B 的草稿' })
  })

  it('同一笔记在多栏共享草稿，每次编辑只保存一次', async () => {
    const { store, editorAt, noteIds, split } = await host()
    await split('a', 'down')
    expect(noteIds()).toEqual(['a', 'a'])
    editorAt(0).vm.$emit('update', { title: '共享标题', content: '两栏同步正文' })
    await flushPromises()

    expect(editorAt(1).props('note')?.content).toBe('两栏同步正文')
    expect(editorAt(1).props('note')?.title).toBe('共享标题')
    await store.flush()
    const saved = invoke.mock.calls.filter(([command]) => command === 'save_note')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.[1]).toEqual({ id: 'a', title: '共享标题', content: '两栏同步正文' })
  })

  it('关闭分栏前先保存，失败保留分栏和草稿，重试成功后合并布局', async () => {
    const { wrapper, editorAt, noteIds, split } = await host()
    await split('b', 'right')
    editorAt(0).vm.$emit('update', { title: '保存失败的 A', content: '关闭前保留的草稿' })
    saveFailures.add('a')
    await wrapper.get('[data-pane-id="pane-1"] .note-pane-close').trigger('click')
    await flushPromises()

    expect(noteIds()).toEqual(['a', 'b'])
    expect(editorAt(0).props('saveStatus')).toBe('failed')
    expect(editorAt(0).props('note')?.content).toBe('关闭前保留的草稿')
    expect(invoke).toHaveBeenCalledWith('save_recovery_draft', {
      id: 'a',
      title: '保存失败的 A',
      content: '关闭前保留的草稿',
      failureCode: 'NOTE_SAVE_FAILED',
    })

    saveFailures.clear()
    await wrapper.get('[data-pane-id="pane-1"] .note-pane-close').trigger('click')
    await flushPromises()

    expect(noteIds()).toEqual(['b'])
    expect(records[0]?.content).toBe('关闭前保留的草稿')
    expect(wrapper.find('.note-split-layout').exists()).toBe(false)
    expect(wrapper.find('.note-pane-close').exists()).toBe(false)
  })

  it('列表收藏不切换活动分栏，非活动栏导出范围在切栏后保持不变', async () => {
    const { wrapper, store, editorAt, split } = await host()
    await split('b', 'right')
    expect(store.selectedNote?.id).toBe('b')
    wrapper.getComponent(NoteList).vm.$emit('togglePin', 'a')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('set_note_pinned', { id: 'a', pinned: true })
    expect(records[0]?.isPinned).toBe(true)
    expect(records[1]?.isPinned).toBe(false)
    expect(store.selectedNote?.id).toBe('b')
    wrapper.getComponent(NoteList).vm.$emit('togglePin', 'a')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('set_note_pinned', { id: 'a', pinned: false })
    await wrapper.get('[data-pane-id="pane-2"]').trigger('pointerdown')
    editorAt(0).vm.$emit('export')
    await flushPromises()
    expect(wrapper.getComponent(ExportDialog).props('modelValue')).toBe(true)
    const options = wrapper.getComponent(ExportDialog).props('scopeOptions')
    expect(options[0]?.scope).toEqual({ kind: 'note', id: 'a' })
    await wrapper.get('[data-pane-id="pane-2"]').trigger('pointerdown')
    expect(store.selectedNote?.id).toBe('b')
    expect(wrapper.getComponent(ExportDialog).props('scopeOptions')[0]?.scope).toEqual({ kind: 'note', id: 'a' })
  })

  it('删除未选中的笔记时保存草稿并保留当前笔记，取消删除不会写入', async () => {
    const { wrapper, store, editorAt, noteIds } = await host()
    editorAt(0).vm.$emit('update', { title: 'A 的草稿', content: '删除 B 前保存的 A' })
    confirm.mockRejectedValueOnce('cancel')
    wrapper.getComponent(NoteList).vm.$emit('trash', 'b')
    await flushPromises()
    expect(invoke).not.toHaveBeenCalledWith('trash_note', { id: 'b' })
    expect(noteIds()).toEqual(['a'])

    wrapper.getComponent(NoteList).vm.$emit('trash', 'b')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('trash_note', { id: 'b' })
    expect(records.map((note) => note.id)).toEqual(['a', 'c'])
    expect(records[0]?.content).toBe('删除 B 前保存的 A')
    expect(store.selectedNote?.id).toBe('a')
    expect(noteIds()).toEqual(['a'])
  })

  it('删除多栏共享的笔记后替换相关分栏，保留其他分栏的正文', async () => {
    const { wrapper, store, editorAt, noteIds, split } = await host()
    await split('a', 'right')
    await split('b', 'down')
    editorAt(2).vm.$emit('update', { title: 'B 的草稿', content: '删除 A 后保留的 B' })
    wrapper.getComponent(NoteList).vm.$emit('trash', 'a')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('trash_note', { id: 'a' })
    expect(noteIds()).toEqual(['b', 'b', 'b'])
    expect(store.selectedNote?.id).toBe('b')
    expect(editorAt(2).props('note')?.content).toBe('删除 A 后保留的 B')
  })

  it('草稿保存失败时阻止删除，并保留编辑内容供重试', async () => {
    const { wrapper, editorAt, noteIds } = await host()
    editorAt(0).vm.$emit('update', { title: 'A 的草稿', content: '保存失败后保留的 A' })
    saveFailures.add('a')
    wrapper.getComponent(NoteList).vm.$emit('trash', 'b')
    await flushPromises()

    expect(invoke).not.toHaveBeenCalledWith('trash_note', { id: 'b' })
    expect(noteIds()).toEqual(['a'])
    expect(editorAt(0).props('saveStatus')).toBe('failed')
    expect(editorAt(0).props('note')?.content).toBe('保存失败后保留的 A')
  })

  it('导出等待保存期间切换活动分栏，仍导出触发操作的笔记', async () => {
    const { wrapper, store, editorAt, noteIds, split } = await host()
    await split('b', 'right')
    editorAt(0).vm.$emit('update', { title: '导出的 A', content: 'A 的待保存正文' })
    let completeSave: (() => void) | undefined
    saveGate = new Promise<void>((resolve) => {
      completeSave = resolve
    })
    editorAt(0).vm.$emit('export')
    await flushPromises()
    expect(editorAt(0).props('saveStatus')).toBe('saving')
    await wrapper.get('[data-pane-id="pane-2"]').trigger('pointerdown')
    completeSave?.()
    await flushPromises()

    expect(store.selectedNote?.id).toBe('b')
    expect(noteIds()).toEqual(['a', 'b'])
    expect(wrapper.getComponent(ExportDialog).props('scopeOptions')[0]?.scope).toEqual({ kind: 'note', id: 'a' })
    expect(records[0]?.content).toBe('A 的待保存正文')
  })

  it('列表选择等待保存期间切换活动分栏，不把旧选择覆盖到新活动分栏', async () => {
    const { wrapper, store, editorAt, noteIds, split } = await host()
    await split('b', 'right')
    editorAt(1).vm.$emit('update', { title: '原活动 B', content: '切栏前保存的 B' })
    let completeSave: (() => void) | undefined
    saveGate = new Promise<void>((resolve) => {
      completeSave = resolve
    })
    wrapper.getComponent(NoteList).vm.$emit('select', 'c')
    await flushPromises()
    expect(editorAt(1).props('saveStatus')).toBe('saving')
    await wrapper.get('[data-pane-id="pane-1"]').trigger('pointerdown')
    completeSave?.()
    await flushPromises()

    expect(noteIds()).toEqual(['a', 'b'])
    expect(store.selectedNote?.id).toBe('a')
    expect(records[1]?.content).toBe('切栏前保存的 B')
    expect(invoke).not.toHaveBeenCalledWith('get_note', { id: 'c' })
  })

  it('分类切换保存全部草稿并只替换活动栏，保留其他栏中的笔记', async () => {
    const { router, editorAt, noteIds, split } = await host({ category: 'work' })
    await split('b', 'right')
    editorAt(0).vm.$emit('update', { title: '工作 A', content: 'A 待保存' })
    editorAt(1).vm.$emit('update', { title: '工作 B', content: 'B 待保存' })
    await router.push({ name: 'workbench', query: { category: 'personal' } })
    await flushPromises()

    expect(noteIds()).toEqual(['a', 'c'])
    expect(records[0]?.content).toBe('A 待保存')
    expect(records[1]?.content).toBe('B 待保存')
    expect(editorAt(0).props('note')?.content).toBe('A 待保存')
  })

  it('保留在非活动栏且不属于当前列表的笔记，仍可通过工具栏修改分类', async () => {
    const { router, store, editorAt, noteIds, split } = await host({ category: 'work' })
    await split('b', 'right')
    await router.push({ name: 'workbench', query: { category: 'personal' } })
    await flushPromises()
    expect(noteIds()).toEqual(['a', 'c'])
    expect(store.notes.map((note) => note.id)).toEqual(['c'])

    editorAt(0).vm.$emit('updateCategory', 'personal')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('set_note_category', { noteId: 'a', categoryId: 'personal' })
    expect(editorAt(0).props('note')?.categoryId).toBe('personal')
    expect(editorAt(1).props('note')?.id).toBe('c')
  })
})

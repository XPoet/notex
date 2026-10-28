import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NoteEditor from '@/features/editor/NoteEditor.vue'
import NoteList from '@/features/notes/NoteList.vue'
import WorkbenchView from '@/views/WorkbenchView.vue'
import type { NoteDetail } from '@/types/notes'
import type { TagSummary } from '@/types/tags'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const notes: NoteDetail[] = ['first', 'second'].map((id) => ({
  id,
  title: `${id} 笔记`,
  content: '正文包含 GitHub 和学习资料',
  isPinned: false,
  createdAt: '2026-10-26T00:00:00Z',
  updatedAt: '2026-10-26T00:00:00Z',
}))

async function mountWorkbench(query: Record<string, string> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'workbench', component: WorkbenchView }],
  })
  await router.push({ name: 'workbench', query })
  await router.isReady()
  const wrapper = mount(WorkbenchView, {
    global: {
      plugins: [createPinia(), router],
      stubs: {
        WorkspaceLayout: { template: '<main><slot name="list" /><slot name="editor" /></main>' },
        NoteEditor: true,
        ExportDialog: true,
        ElInput: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        ElIcon: { template: '<i><slot /></i>' },
        ElScrollbar: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return { wrapper, router }
}

describe('工作台搜索与标签同步', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'list_notes':
          return notes.map((note) => ({ ...note, contentPreview: note.content, tagNames: [] }))
        case 'get_note':
          return notes.find((note) => note.id === args?.id)
        case 'list_categories':
        case 'list_tags':
        case 'list_note_tags':
          return []
        case 'cleanup_empty_note':
          return undefined
        case 'get_note_asset_health':
          return { missingAssetCount: 0 }
        default:
          throw new Error(`未模拟的命令：${command}`)
      }
    })
  })

  it('列表搜索与清空同步卡片和正文高亮条件，切换笔记保留当前关键词', async () => {
    const { wrapper } = await mountWorkbench()
    const input = wrapper.get('.note-list-search')
    const editor = wrapper.getComponent(NoteEditor)

    await input.setValue('笔记')
    expect(wrapper.findAll('.note-list-item-title mark').map((mark) => mark.text())).toEqual(['笔记', '笔记'])
    expect(wrapper.find('.note-list-item-preview mark').exists()).toBe(false)

    await input.setValue('github')
    expect(editor.props('searchQuery')).toBe('github')
    expect(wrapper.findAll('.note-list-item-preview mark').map((mark) => mark.text())).toEqual(['GitHub', 'GitHub'])
    expect(wrapper.find('.note-list-item-title mark').exists()).toBe(false)
    await wrapper.findAll('.note-list-item')[1]?.trigger('click')
    await flushPromises()
    expect(editor.props('note')?.id).toBe('second')
    expect(editor.props('searchQuery')).toBe('github')
    await input.setValue('')
    expect(editor.props('searchQuery')).toBe('')
    expect(wrapper.find('.note-list-item mark').exists()).toBe(false)
    expect(invoke.mock.calls.some(([command]) => command === 'save_note')).toBe(false)
    wrapper.unmount()
  })

  it('从全局搜索打开笔记时传递全部关键词，离开搜索上下文后清除高亮', async () => {
    const { wrapper, router } = await mountWorkbench({ note: 'second', search: 'GitHub 学习' })
    const editor = wrapper.getComponent(NoteEditor)

    expect(editor.props('note')?.id).toBe('second')
    expect(editor.props('searchQuery')).toBe('GitHub 学习')
    expect(wrapper.getComponent(NoteList).findAll('.note-list-item')).toHaveLength(2)
    expect(wrapper.findAll('.note-list-item-preview mark').map((mark) => mark.text())).toEqual([
      'GitHub',
      '学习',
      'GitHub',
      '学习',
    ])
    await wrapper.get('.note-list-search').setValue('正文')
    expect(editor.props('searchQuery')).toBe('正文')
    expect(wrapper.findAll('.note-list-item-preview mark').map((mark) => mark.text())).toEqual(['正文', '正文'])
    await wrapper.get('.note-list-search').setValue('')
    expect(editor.props('searchQuery')).toBe('')
    expect(wrapper.find('.note-list-item mark').exists()).toBe(false)
    await router.push({ name: 'workbench' })
    await flushPromises()
    expect(editor.props('searchQuery')).toBe('')
    wrapper.unmount()
  })

  it('快速切换笔记时忽略旧笔记迟到的标签，避免覆盖当前标签', async () => {
    let resolveFirstTags: ((tags: TagSummary[]) => void) | undefined
    const pendingTags = new Promise<TagSummary[]>((resolve) => {
      resolveFirstTags = resolve
    })
    const defaultImplementation = invoke.getMockImplementation()
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'list_note_tags') {
        return args?.noteId === 'first'
          ? pendingTags
          : Promise.resolve([{ id: 'second-tag', name: '当前标签', noteCount: 1 }])
      }
      return defaultImplementation?.(command, args)
    })
    const { wrapper } = await mountWorkbench()
    const editor = wrapper.getComponent(NoteEditor)
    expect(editor.props('selectedTagIds')).toEqual([])

    await wrapper.findAll('.note-list-item')[1]?.trigger('click')
    await flushPromises()
    expect(editor.props('selectedTagIds')).toEqual(['second-tag'])
    resolveFirstTags?.([{ id: 'first-tag', name: '旧标签', noteCount: 1 }])
    await flushPromises()
    expect(editor.props('note')?.id).toBe('second')
    expect(editor.props('selectedTagIds')).toEqual(['second-tag'])
    wrapper.unmount()
  })
})

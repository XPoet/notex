import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shallowMount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NoteEditor from '@/features/editor/NoteEditor.vue'
import MarkdownEditor from '@/features/editor/MarkdownEditor.vue'

const noteEditorPath = resolve(process.cwd(), 'src/features/editor/NoteEditor.vue')
const noteEditorSource = readFileSync(noteEditorPath, 'utf8')
const markdownEditorPath = resolve(process.cwd(), 'src/features/editor/MarkdownEditor.vue')
const markdownEditorSource = readFileSync(markdownEditorPath, 'utf8')

describe('笔记编辑器布局', () => {
  it('分类旁只展示当前笔记的标签，修改标签或切换笔记后同步更新', async () => {
    const note = {
      id: 'note-1',
      title: '标签展示',
      content: '正文',
      isPinned: false,
      createdAt: '2026-10-26T00:00:00Z',
      updatedAt: '2026-10-26T00:00:00Z',
    }
    const wrapper = shallowMount(NoteEditor, {
      props: {
        note,
        saveStatus: 'saved',
        missingAssetCount: 0,
        saveImage: async () => '',
        categories: [],
        tags: [
          { id: 'learning', name: '学习资料', noteCount: 1 },
          { id: 'work', name: '工作', noteCount: 1 },
        ],
        selectedTagIds: ['learning'],
        searchQuery: '正文',
      },
    })

    const classification = wrapper.get('.note-editor-classification')
    expect(classification.get('.note-editor-location').text()).toBe('未分类')
    expect(classification.findAll('.note-editor-tag').map((tag) => tag.text())).toEqual([
      '#学习资料',
    ])
    expect(wrapper.getComponent(MarkdownEditor).props('searchQuery')).toBe('正文')

    await wrapper.setProps({ selectedTagIds: ['learning', 'work'] })
    expect(classification.findAll('.note-editor-tag').map((tag) => tag.text())).toEqual([
      '#学习资料',
      '#工作',
    ])
    await wrapper.setProps({ selectedTagIds: ['work'] })
    expect(classification.get('.note-editor-tag').text()).toBe('#工作')
    await wrapper.setProps({ note: { ...note, id: 'note-2' }, selectedTagIds: [] })
    expect(wrapper.find('.note-editor-tags').exists()).toBe(false)
    wrapper.unmount()
  })

  it('在标题下展示创建和更新时间，并在保存后同步更新时间，午夜显示为 00 点', async () => {
    const createdAt = new Date(2026, 9, 16, 0, 1, 2).toISOString()
    const updatedAt = new Date(2026, 9, 17, 23, 59, 58).toISOString()
    const note = {
      id: 'note-1',
      title: '时间展示',
      content: '正文',
      isPinned: false,
      createdAt,
      updatedAt,
    }
    const wrapper = shallowMount(NoteEditor, {
      props: {
        note,
        saveStatus: 'saved',
        missingAssetCount: 0,
        saveImage: async () => '',
        categories: [],
        tags: [],
        selectedTagIds: [],
      },
      global: {
        stubs: {
          ElButton: { template: '<button><slot /></button>' },
          ElPopover: { template: '<div><slot name="reference" /><slot /></div>' },
        },
      },
    })

    const toolbar = wrapper.get('.note-editor-heading .note-editor-toolbar')
    expect(toolbar.get('.note-editor-location').text()).toBe('未分类')
    expect(toolbar.findAll('time')).toHaveLength(2)
    expect(toolbar.get('button[aria-label="分类与标签"]').exists()).toBe(true)
    await toolbar.get('button[aria-label="置顶笔记"]').trigger('click')
    await toolbar.get('button[aria-label="导出笔记"]').trigger('click')
    await toolbar.get('button[aria-label="移入回收站"]').trigger('click')
    expect(wrapper.emitted('togglePin')).toHaveLength(1)
    expect(wrapper.emitted('export')).toHaveLength(1)
    expect(wrapper.emitted('trash')).toHaveLength(1)

    const metadata = wrapper.get('.note-editor-heading .note-editor-created')
    expect(metadata.text()).toContain('创建于')
    expect(metadata.get('time').text()).toBe('2026/10/16 00:01')
    expect(metadata.get('time').attributes('datetime')).toBe(createdAt)

    const updatedMetadata = wrapper.get('.note-editor-heading .note-editor-updated')
    expect(updatedMetadata.text()).toContain('更新于')
    expect(updatedMetadata.get('time').text()).toBe('2026/10/17 23:59')
    expect(updatedMetadata.get('time').attributes('datetime')).toBe(updatedAt)

    const savedAt = new Date(2026, 9, 18, 0, 2, 3).toISOString()
    await wrapper.setProps({ note: { ...note, updatedAt: savedAt } })
    expect(updatedMetadata.get('time').text()).toBe('2026/10/18 00:02')
    expect(updatedMetadata.get('time').attributes('datetime')).toBe(savedAt)
    expect(metadata.get('time').attributes('datetime')).toBe(createdAt)
    wrapper.unmount()
  })

  it('限制标题输入框和内容网格的最小内联尺寸，避免超长标题撑出编辑器', () => {
    expect(noteEditorSource).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(noteEditorSource).toContain(
      '.note-title-input {\n  inline-size: 100%;\n  min-inline-size: 0;',
    )
    expect(noteEditorSource).toContain(
      '.note-title-input :deep(.el-input__inner) {\n  min-inline-size: 0;',
    )
  })

  it('移除标题上方的独立工具栏，保留 34px 文档状态栏', () => {
    expect(noteEditorSource).toContain('grid-template-rows: minmax(0, 1fr) 34px')
    expect(noteEditorSource).not.toContain('note-editor-header')
    expect(noteEditorSource).toContain(':save-status="saveStatus"')
    expect(noteEditorSource).toContain(':save-error="saveError"')
  })

  it('将分类和标签收纳到删除按钮后的更多操作中', () => {
    expect(noteEditorSource).toContain(':icon="MoreFilled"')
    expect(noteEditorSource).toContain(
      '<el-popover placement="bottom-end" :width="360" trigger="click">',
    )
    expect(noteEditorSource).toContain(':category-id="note.categoryId"')
  })

  it('仅由 CodeMirror 内部滚动节点承载长内容滚动', () => {
    expect(markdownEditorSource).toContain(
      '.markdown-editor {\n  min-inline-size: 0;\n  min-block-size: 0;\n  block-size: 100%;\n  overflow: hidden;',
    )
    expect(markdownEditorSource).toContain(
      '.markdown-editor :deep(.cm-editor) {\n  min-inline-size: 0;\n  min-block-size: 0;\n  block-size: 100%;',
    )
    expect(markdownEditorSource).toContain('overflow-x: hidden;\n  overflow-y: auto;')
  })

  it('隐藏滚动条轨道底色并使用 Element Plus 风格的半透明滑块', () => {
    expect(markdownEditorSource).toContain(
      '.markdown-editor :deep(.cm-scroller::-webkit-scrollbar-track) {\n  background: transparent;',
    )
    expect(markdownEditorSource).toContain('background: rgb(144 147 153 / 30%);')
    expect(markdownEditorSource).toContain('background: rgb(144 147 153 / 50%);')
  })
})

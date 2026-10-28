import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MarkdownEditor from '@/features/editor/MarkdownEditor.vue'
import NoteEditor from '@/features/editor/NoteEditor.vue'
import { loadNoteImage } from '@/services/assets'

vi.mock('@/services/assets', () => ({ loadNoteImage: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readImage: vi.fn() }))

const revokeObjectURL = vi.fn()

const viewerStub = {
  props: ['urlList', 'initialIndex'],
  emits: ['close'],
  template: '<div class="image-viewer"><button @click="$emit(\'close\')">关闭</button></div>',
}

function mountEditor(modelValue: string) {
  return mount(MarkdownEditor, {
    props: { noteId: 'note-1', modelValue, saveImage: vi.fn() },
    global: { stubs: { ElImageViewer: viewerStub } },
  })
}

describe('笔记图片预览', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // jsdom 不提供文本 Range 的布局 API，CodeMirror 的异步测量需要这些接口。
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = new Range()
      range.getBoundingClientRect = () => new DOMRect()
      range.getClientRects = () => Object.assign([], { item: () => null })
      return range
    })
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL }))
    vi.mocked(loadNoteImage).mockImplementation(async (_noteId, path) => `blob:${path}`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('粘贴图片保存并同步正文后，在笔记编辑区显示可打开的内嵌图片', async () => {
    const note = {
      id: 'note-1',
      title: '图片笔记',
      content: '',
      isPinned: false,
      createdAt: '2026-10-13T00:00:00Z',
      updatedAt: '2026-10-13T00:00:00Z',
    }
    const saveImage = vi.fn(async () => '![图片](./assets/pasted.png)')
    const wrapper = mount(NoteEditor, {
      props: {
        note,
        saveStatus: 'saved',
        missingAssetCount: 0,
        saveImage,
        categories: [],
        tags: [],
        selectedTagIds: [],
      },
      global: {
        stubs: {
          ElImageViewer: viewerStub,
          ElInput: true,
          ElButton: true,
          ElPopover: true,
          ElIcon: true,
          NoteMetadata: true,
          EditorStatusBar: true,
        },
      },
    })
    const bytes = new Uint8Array([1, 2, 3])
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    })
    wrapper.find('.cm-content').element.dispatchEvent(paste)
    await flushPromises()
    expect(paste.defaultPrevented).toBe(true)
    expect(saveImage).toHaveBeenCalledWith(bytes)
    expect(wrapper.emitted('update')).toEqual([[{ title: note.title, content: '![图片](./assets/pasted.png)' }]])
    expect(wrapper.find('.cm-content .cm-image-preview img').exists()).toBe(true)
    await wrapper.setProps({ note: { ...note, content: '![图片](./assets/pasted.png)' } })
    await flushPromises()
    expect(wrapper.find('.cm-image-preview button img').attributes('src')).toBe('blob:assets/pasted.png')
    await wrapper.find('.cm-image-preview button').trigger('click')
    expect(wrapper.findComponent(viewerStub).props('urlList')).toEqual(['blob:assets/pasted.png'])
    wrapper.unmount()
  })

  it('读取已有图片，去重并按点击位置打开大图，关闭后回到编辑区', async () => {
    const wrapper = mountEditor('![图片](./assets/a.png)\n![图片](./assets/b.gif)\n![重复](./assets/a.png)')
    await flushPromises()

    expect(loadNoteImage).toHaveBeenCalledTimes(2)
    expect(loadNoteImage).toHaveBeenCalledWith('note-1', 'assets/a.png')
    expect(wrapper.findAll('.cm-content img')).toHaveLength(3)
    await wrapper.findAll('.cm-image-preview button')[1]?.trigger('click')
    const viewer = wrapper.findComponent(viewerStub)
    expect(viewer.props('urlList')).toEqual(['blob:assets/a.png', 'blob:assets/b.gif'])
    expect(viewer.props('initialIndex')).toBe(1)
    await viewer.find('button').trigger('click')
    expect(wrapper.find('.image-viewer').exists()).toBe(false)
    wrapper.unmount()
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('正文新增图片后显示内嵌图片，普通文字编辑不重复读取，移除引用时释放资源', async () => {
    const wrapper = mountEditor('正文')
    expect(wrapper.find('.cm-image-preview').exists()).toBe(false)
    await wrapper.setProps({ modelValue: '正文\n![图片](./assets/a.png)' })
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toBe('blob:assets/a.png')
    await wrapper.setProps({ modelValue: '修改正文\n![图片](./assets/a.png)' })
    expect(loadNoteImage).toHaveBeenCalledTimes(1)
    await wrapper.find('button').trigger('click')
    await wrapper.setProps({ modelValue: '移除引用' })
    expect(wrapper.find('.image-viewer').exists()).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assets/a.png')
    wrapper.unmount()
  })

  it('图片读取失败时显示提示，并禁止打开无效图片', async () => {
    vi.mocked(loadNoteImage).mockRejectedValue({ code: 'ASSET_READ_FAILED' })
    const wrapper = mountEditor('![图片](./assets/missing.png)')
    await flushPromises()
    expect(wrapper.text()).toContain('图片无法读取')
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.image-viewer').exists()).toBe(false)
    wrapper.unmount()
  })

  it('不读取远程地址、越界路径和代码示例中的图片引用', async () => {
    const wrapper = mountEditor(
      [
        '![外部](https://example.com/image.png)',
        '![越界](./assets/../image.png)',
        '`![示例](./assets/inline.png)`',
        '```markdown\n![示例](./assets/code.png)\n```',
      ].join('\n'),
    )
    await flushPromises()
    expect(loadNoteImage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('切换笔记时释放旧图片并重新校验新笔记关联', async () => {
    const wrapper = mountEditor('![图片](./assets/a.png)')
    await flushPromises()
    await wrapper.setProps({ noteId: 'note-2' })
    await flushPromises()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assets/a.png')
    expect(loadNoteImage).toHaveBeenLastCalledWith('note-2', 'assets/a.png')
    wrapper.unmount()
  })

  it('图片嵌入引用所在行后，后续正文仍在同一编辑器中可编辑', async () => {
    const wrapper = mountEditor('前文\n![截图](./assets/a.png)\n后文')
    await flushPromises()
    const preview = wrapper.find('.cm-image-preview').element
    expect(preview.parentElement?.classList.contains('cm-content')).toBe(true)
    expect(preview.previousElementSibling?.textContent).toBe('![截图](./assets/a.png)')
    expect(preview.nextElementSibling?.textContent).toBe('后文')
    expect(wrapper.find('img').attributes('alt')).toBe('截图')
    wrapper.unmount()
  })

  it('图片读取期间切换笔记时丢弃迟到结果', async () => {
    let resolveImage: ((url: string) => void) | undefined
    vi.mocked(loadNoteImage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve
        }),
    )
    const wrapper = mountEditor('![图片](./assets/a.png)')
    await wrapper.setProps({ noteId: 'note-2', modelValue: '新笔记' })
    resolveImage?.('blob:old-image')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:old-image')
    wrapper.unmount()
  })

  it('撤销和重做图片引用时同步更新编辑器内的图片', async () => {
    const wrapper = mountEditor('正文')
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], getData: () => '![图片](./assets/a.png)' },
    })
    wrapper.find('.cm-content').element.dispatchEvent(paste)
    await flushPromises()
    expect(wrapper.find('.cm-image-preview img').exists()).toBe(true)
    await wrapper.find('.cm-content').trigger('keydown', { key: 'z', ctrlKey: true })
    await flushPromises()
    expect(wrapper.find('.cm-image-preview').exists()).toBe(false)
    await wrapper.find('.cm-content').trigger('keydown', { key: 'z', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(wrapper.find('.cm-image-preview img').exists()).toBe(true)
    wrapper.unmount()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MarkdownEditor from '@/features/editor/MarkdownEditor.vue'
import { assetMarkdown, getNoteAssetReferences } from '@/features/editor/assetReferences'
import type { AttachmentHandlers, SavedAsset } from '@/types/assets'

vi.mock('@/services/assets', () => ({ loadNoteImage: vi.fn(async () => 'blob:image') }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readImage: vi.fn() }))

const asset: SavedAsset = {
  id: 'file',
  relativePath: 'assets/note/file.pdf',
  originalName: '报告 [终稿].pdf',
  mimeType: 'application/pdf',
  width: null,
  height: null,
  size: 2048,
  modifiedAt: '1',
}

function actions(): AttachmentHandlers {
  return {
    saveFile: vi.fn(async () => assetMarkdown(asset)),
    chooseFiles: vi.fn(async () => [assetMarkdown(asset)]),
    pasteFiles: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    saveAs: vi.fn(async () => undefined),
  }
}

function editor(content = assetMarkdown(asset), attachments = actions()) {
  return mount(MarkdownEditor, {
    props: { noteId: 'note', modelValue: content, saveImage: vi.fn(), attachments, assets: [asset] },
    global: {
      stubs: {
        ElPopover: { props: ['visible'], template: '<div v-if="visible"><slot /></div>' },
        ElButton: { template: '<button><slot /></button>' },
        ElImageViewer: true,
      },
    },
  })
}

function pasteEvent(items: { kind: string; type: string; getAsFile: () => File }[] = [], text = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items, getData: () => text } })
  return event
}

describe('笔记附件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = new Range()
      range.getBoundingClientRect = () => new DOMRect()
      range.getClientRects = () => Object.assign([], { item: () => null })
      return range
    })
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: vi.fn() }))
  })
  afterEach(() => vi.restoreAllMocks())

  it('保留带括号的原始文件名，并忽略代码、转义链接和越界路径', () => {
    const markdown = assetMarkdown(asset)
    expect(markdown).toBe('[报告 \\[终稿\\].pdf](./assets/note/file.pdf)')
    const references = getNoteAssetReferences(
      [
        markdown,
        '`[示例](./assets/code.pdf)`',
        '````md\n[示例](./assets/fenced.pdf)\n````',
        '\\[转义](./assets/escaped.pdf)',
        '[越界](./assets/../secret.pdf)',
      ].join('\n'),
    )
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({ relativePath: asset.relativePath, label: asset.originalName, kind: 'file' })
  })

  it('显示图标、文件名和大小，点击通过受控操作打开附件', async () => {
    const attachments = actions()
    const wrapper = editor(undefined, attachments)
    expect(wrapper.get('.cm-attachment-preview svg').exists()).toBe(true)
    expect(wrapper.get('.cm-attachment-name').text()).toBe(asset.originalName)
    expect(wrapper.get('.cm-attachment-detail').text()).toBe('PDF · 2 KB')
    await wrapper.get('.cm-attachment-preview button').trigger('click')
    expect(attachments.open).toHaveBeenCalledWith(asset.relativePath)
    wrapper.unmount()
  })

  it('右键菜单可以定位、另存为和移除当前引用，撤销后恢复附件', async () => {
    const attachments = actions()
    const wrapper = editor(undefined, attachments)
    for (const [label, handler] of [
      ['在文件管理器中显示', attachments.reveal],
      ['另存为', attachments.saveAs],
    ] as const) {
      await wrapper.get('.cm-attachment-preview').trigger('contextmenu', { clientX: 100, clientY: 100 })
      const button = wrapper.findAll('[role="menuitem"]').find((item) => item.text() === label)
      expect(button).toBeDefined()
      await button?.trigger('click')
      expect(handler).toHaveBeenCalledWith(asset.relativePath)
    }
    await wrapper.get('.cm-attachment-preview').trigger('contextmenu')
    await wrapper
      .findAll('[role="menuitem"]')
      .find((item) => item.text() === '从笔记中移除')
      ?.trigger('click')
    await flushPromises()
    expect(wrapper.find('.cm-attachment-preview').exists()).toBe(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
    await wrapper.get('.cm-content').trigger('keydown', { key: 'z', ctrlKey: true })
    await flushPromises()
    expect(wrapper.find('.cm-attachment-preview').exists()).toBe(true)
    wrapper.unmount()
  })

  it.each(['file', 'image'])('右键或 Control 单击 %s 预览时阻止默认选词，普通左键和菜单继续工作', async (kind) => {
    const content = kind === 'file' ? assetMarkdown(asset) : '![图片说明.png](./assets/note/image.png)'
    const wrapper = editor(content)
    await flushPromises()
    const target = wrapper.get(kind === 'file' ? '.cm-attachment-name' : '.cm-image-caption')
    for (const options of [{ button: 2 }, { button: 0, ctrlKey: true }]) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...options })
      target.element.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
    }
    const left = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    target.element.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
    await target.trigger('contextmenu', { button: 2 })
    expect(wrapper.get('[role="menu"]').exists()).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('一次粘贴多个文件时保留顺序，正文使用标准 Markdown 链接', async () => {
    const attachments = actions()
    vi.mocked(attachments.saveFile).mockImplementation(async (file) => `[${file.name}](./assets/note/file.pdf)`)
    const wrapper = editor('', attachments)
    const files = ['甲.pdf', '乙.docx'].map((name) => new File(['data'], name))
    const event = pasteEvent(files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })))
    wrapper.get('.cm-content').element.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(attachments.saveFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([
      '[甲.pdf](./assets/note/file.pdf)\n[乙.docx](./assets/note/file.pdf)',
    ])
    expect(attachments.pasteFiles).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('Finder 文件粘贴走原生入口，普通文本粘贴保留文本', async () => {
    const attachments = actions()
    vi.mocked(attachments.pasteFiles).mockResolvedValueOnce([assetMarkdown(asset)])
    const wrapper = editor('', attachments)
    wrapper.get('.cm-content').element.dispatchEvent(pasteEvent())
    await flushPromises()
    expect(wrapper.find('.cm-attachment-preview').exists()).toBe(true)
    wrapper.get('.cm-content').element.dispatchEvent(pasteEvent([], '正文'))
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toContain('正文')
    wrapper.unmount()
  })

  it('编辑器卸载后丢弃迟到的附件插入，避免写入另一篇笔记', async () => {
    let complete: ((value: string[]) => void) | undefined
    const attachments = actions()
    vi.mocked(attachments.pasteFiles).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const wrapper = editor('', attachments)
    wrapper.get('.cm-content').element.dispatchEvent(pasteEvent())
    wrapper.unmount()
    complete?.([assetMarkdown(asset)])
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('取消大附件时不保存文件，也不插入引用', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const attachments = actions()
    const wrapper = editor('', attachments)
    const file = new File(['data'], 'large.pdf')
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })
    wrapper.get('.cm-content').element.dispatchEvent(pasteEvent([{ kind: 'file', type: '', getAsFile: () => file }]))
    await flushPromises()
    expect(attachments.saveFile).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })
  it('在正文中插入附件时添加换行，不把文件链接与原段落拼接', async () => {
    const attachments = actions()
    const wrapper = editor('已有正文', attachments)
    const file = new File(['data'], '报告.pdf')
    wrapper.get('.cm-content').element.dispatchEvent(pasteEvent([{ kind: 'file', type: '', getAsFile: () => file }]))
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([`${assetMarkdown(asset)}\n已有正文`])
    wrapper.unmount()
  })

  it('Finder 文件 URL 优先于 WebView 生成的位图，保留原文件名和原字节', async () => {
    const attachments = actions()
    vi.mocked(attachments.pasteFiles).mockResolvedValue([assetMarkdown(asset)])
    const wrapper = editor('', attachments)
    const bitmap = new File(['data'], 'image.tiff', { type: 'image/tiff' })
    wrapper
      .get('.cm-content')
      .element.dispatchEvent(pasteEvent([{ kind: 'file', type: 'image/tiff', getAsFile: () => bitmap }]))
    await flushPromises()
    expect(attachments.saveFile).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([assetMarkdown(asset)])
    wrapper.unmount()
  })
  it('同一行多次引用同一附件时，右键移除精确作用于被点击的那一处', async () => {
    const first = `[甲](./${asset.relativePath})`
    const second = `[乙](./${asset.relativePath})`
    const wrapper = editor(`${first} 和 ${second}`)
    await wrapper.findAll('.cm-attachment-preview')[0]?.trigger('contextmenu')
    await wrapper
      .findAll('[role="menuitem"]')
      .find((item) => item.text() === '从笔记中移除')
      ?.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([` 和 ${second}`])
    expect(wrapper.findAll('.cm-attachment-preview')).toHaveLength(1)
    wrapper.unmount()
  })
})

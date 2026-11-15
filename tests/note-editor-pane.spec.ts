import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pinia } from 'pinia'
import type { NoteDetail } from '@/types/notes'
import type { SavedAsset } from '@/types/assets'
import type { TagSummary } from '@/types/tags'

const { tagService, assetService, listNotePage } = vi.hoisted(() => ({
  tagService: {
    listTags: vi.fn(),
    listNoteTags: vi.fn(),
    createTag: vi.fn(),
    setNoteTags: vi.fn(),
  },
  assetService: {
    getNoteAssetHealth: vi.fn(),
    listNoteAssets: vi.fn(),
    savePastedImage: vi.fn(),
    saveNoteAttachment: vi.fn(),
    chooseNoteAttachments: vi.fn(),
    pasteNoteAttachments: vi.fn(),
    openNoteAsset: vi.fn(),
    revealNoteAsset: vi.fn(),
    saveNoteAssetAs: vi.fn(),
  },
  listNotePage: vi.fn(),
}))
vi.mock('@/services/tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tags')>()),
  ...tagService,
}))
vi.mock('@/services/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/assets')>()),
  ...assetService,
}))
vi.mock('@/services/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/notes')>()),
  listNotePage,
}))

import NoteEditorPane from '@/features/editor/NoteEditorPane.vue'
import NoteEditor from '@/features/editor/NoteEditor.vue'
import { useTagsStore } from '@/stores/tags'
import { useNotesStore } from '@/stores/notes'

const oldTag: TagSummary = { id: 'old', name: '原标签', noteCount: 1 }
const newTag: TagSummary = { id: 'new', name: '新标签', noteCount: 0 }
const otherTag: TagSummary = { id: 'other', name: '另一标签', noteCount: 1 }
let relations: Map<string, TagSummary[]>
const mounted: Array<{ unmount: () => void }> = []

function deferred<T>() {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function note(id: string): NoteDetail {
  return {
    id,
    title: `笔记 ${id}`,
    content: `${id} 的正文`,
    isPinned: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }
}

function asset(id: string, image = false): SavedAsset {
  return {
    id: `${id}-${image ? 'image' : 'file'}`,
    relativePath: `assets/${id}/${image ? 'image.png' : 'file.pdf'}`,
    originalName: image ? 'image.png' : 'file.pdf',
    mimeType: image ? 'image/png' : 'application/pdf',
    width: image ? 20 : null,
    height: image ? 20 : null,
    size: 100,
    modifiedAt: '2026-11-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  relations = new Map([
    ['a', [oldTag]],
    ['b', [otherTag]],
    ['c', []],
  ])
  tagService.listTags.mockImplementation(async () => [oldTag, newTag, otherTag])
  tagService.listNoteTags.mockImplementation(async (id: string) => [...(relations.get(id) ?? [])])
  tagService.createTag.mockResolvedValue(newTag)
  tagService.setNoteTags.mockImplementation(async (id: string, ids: string[]) => {
    relations.set(
      id,
      [oldTag, newTag, otherTag].filter((tag) => ids.includes(tag.id)),
    )
  })
  assetService.getNoteAssetHealth.mockResolvedValue({ missingAssetCount: 0 })
  assetService.listNoteAssets.mockImplementation(async (id: string) => [asset(id)])
  assetService.savePastedImage.mockImplementation(async (id: string) => asset(id, true))
  assetService.saveNoteAttachment.mockImplementation(async (id: string) => asset(id))
  assetService.chooseNoteAttachments.mockImplementation(async (id: string) => ({
    assets: [asset(id)],
    failedNames: [],
  }))
  assetService.pasteNoteAttachments.mockResolvedValue({ assets: [], failedNames: [] })
  assetService.openNoteAsset.mockResolvedValue(undefined)
  assetService.revealNoteAsset.mockResolvedValue(undefined)
  assetService.saveNoteAssetAs.mockResolvedValue(undefined)
  listNotePage.mockResolvedValue({ items: [], total: 0, nextOffset: null })
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted.length = 0
  vi.restoreAllMocks()
})

async function host(id = 'a', pinia: Pinia = createPinia()) {
  const wrapper = mount(NoteEditorPane, {
    props: { note: note(id), active: false, multiple: true, saveStatus: 'saved', categories: [], busy: false },
    global: {
      plugins: [pinia],
      stubs: { NoteEditor: true, ElIcon: { template: '<i><slot /></i>' } },
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  return {
    wrapper,
    editor: wrapper.getComponent(NoteEditor),
    tags: useTagsStore(pinia),
    notes: useNotesStore(pinia),
  }
}

describe('笔记分栏标签和资源归属', () => {
  it('全局标签重载时保留同一笔记的原关联，直到新的关系请求完成', async () => {
    const { editor, tags } = await host()
    const pending = deferred<TagSummary[]>()
    tagService.listNoteTags.mockReturnValueOnce(pending.promise)
    await tags.load()
    await flushPromises()

    expect(editor.props('selectedTagIds')).toEqual(['old'])
    pending.resolve([oldTag, newTag])
    await flushPromises()
    expect(editor.props('selectedTagIds')).toEqual(['old', 'new'])
  })

  it('新建标签时等待笔记关系并保留已有标签，迟到的重载不能撤销新关联', async () => {
    const { editor } = await host()
    const reload = deferred<TagSummary[]>()
    const currentRelations = deferred<TagSummary[]>()
    tagService.listNoteTags.mockReturnValueOnce(reload.promise).mockReturnValueOnce(currentRelations.promise)
    editor.vm.$emit('createTag', '新标签')
    await flushPromises()

    expect(editor.props('selectedTagIds')).toEqual(['old'])
    expect(tagService.setNoteTags).not.toHaveBeenCalled()
    currentRelations.resolve([oldTag])
    await flushPromises()

    expect(tagService.createTag).toHaveBeenCalledWith('新标签')
    expect(tagService.setNoteTags).toHaveBeenCalledWith('a', ['old', 'new'])
    expect(editor.props('selectedTagIds')).toEqual(['old', 'new'])
    reload.resolve([oldTag])
    await flushPromises()
    expect(editor.props('selectedTagIds')).toEqual(['old', 'new'])
  })

  it('同一笔记的旧关系请求迟到时，不覆盖用户刚保存的最新标签', async () => {
    const { editor, tags } = await host()
    const stale = deferred<TagSummary[]>()
    tagService.listNoteTags.mockReturnValueOnce(stale.promise)
    await tags.load()
    await flushPromises()
    editor.vm.$emit('updateTags', ['new'])
    await flushPromises()
    expect(editor.props('selectedTagIds')).toEqual(['new'])

    stale.resolve([oldTag])
    await flushPromises()
    expect(editor.props('selectedTagIds')).toEqual(['new'])
    expect(relations.get('a')?.map((tag) => tag.id)).toEqual(['new'])
  })

  it('两栏的图片、附件和标签分别使用各自笔记 ID', async () => {
    const pinia = createPinia()
    const wrapper = mount(
      {
        components: { NoteEditorPane },
        setup: () => ({ first: note('a'), second: note('b') }),
        template: `<main>
          <NoteEditorPane :note="first" :active="false" multiple save-status="saved" :categories="[]" :busy="false" />
          <NoteEditorPane :note="second" active multiple save-status="saved" :categories="[]" :busy="false" />
        </main>`,
      },
      {
        global: {
          plugins: [pinia],
          stubs: { NoteEditor: true, ElIcon: { template: '<i><slot /></i>' } },
        },
      },
    )
    mounted.push(wrapper)
    await flushPromises()
    const editors = wrapper.findAllComponents(NoteEditor)
    const firstEditor = editors[0]
    const secondEditor = editors[1]
    if (firstEditor === undefined || secondEditor === undefined) throw new Error('两个笔记分栏没有挂载')
    const bytesA = new Uint8Array([1, 2])
    const bytesB = new Uint8Array([3, 4])
    const images = await Promise.all([firstEditor.props('saveImage')(bytesA), secondEditor.props('saveImage')(bytesB)])
    expect(assetService.savePastedImage).toHaveBeenCalledWith('a', bytesA)
    expect(assetService.savePastedImage).toHaveBeenCalledWith('b', bytesB)
    expect(images[0]).toContain('./assets/a/image.png')
    expect(images[1]).toContain('./assets/b/image.png')

    const file = new File(['报告'], 'file.pdf', { type: 'application/pdf' })
    const firstAttachments = firstEditor.props('attachments')
    const secondAttachments = secondEditor.props('attachments')
    await firstAttachments?.saveFile(file)
    await secondAttachments?.chooseFiles()
    await firstAttachments?.open('assets/a/file.pdf')
    await secondAttachments?.reveal('assets/b/file.pdf')
    expect(assetService.saveNoteAttachment).toHaveBeenCalledWith('a', file)
    expect(assetService.chooseNoteAttachments).toHaveBeenCalledWith('b')
    expect(assetService.openNoteAsset).toHaveBeenCalledWith('a', 'assets/a/file.pdf')
    expect(assetService.revealNoteAsset).toHaveBeenCalledWith('b', 'assets/b/file.pdf')

    firstEditor.vm.$emit('updateTags', ['old', 'new'])
    secondEditor.vm.$emit('updateTags', ['other'])
    await flushPromises()
    expect(tagService.setNoteTags).toHaveBeenCalledWith('a', ['old', 'new'])
    expect(tagService.setNoteTags).toHaveBeenCalledWith('b', ['other'])
    expect(relations.get('a')?.map((tag) => tag.id)).toEqual(['old', 'new'])
    expect(firstEditor.props('selectedTagIds')).toEqual(['old', 'new'])
    expect(secondEditor.props('selectedTagIds')).toEqual(['other'])
    expect(firstEditor.props('assets')?.map((item) => item.relativePath)).toEqual(['assets/a/file.pdf'])
    expect(secondEditor.props('assets')?.map((item) => item.relativePath)).toEqual(['assets/b/file.pdf'])
  })

  it('标签更新等待保存时切换该栏笔记，更新仍归原笔记且不覆盖新笔记标签', async () => {
    const { wrapper, editor, notes } = await host()
    const saving = deferred<void>()
    vi.spyOn(notes, 'flush').mockReturnValueOnce(saving.promise)
    editor.vm.$emit('updateTags', ['old', 'new'])
    await wrapper.setProps({ note: note('b') })
    await flushPromises()
    expect(editor.props('selectedTagIds')).toEqual(['other'])
    saving.resolve()
    await flushPromises()

    expect(tagService.setNoteTags).toHaveBeenCalledWith('a', ['old', 'new'])
    expect(editor.props('selectedTagIds')).toEqual(['other'])
    expect(relations.get('b')?.map((tag) => tag.id)).toEqual(['other'])
  })
})

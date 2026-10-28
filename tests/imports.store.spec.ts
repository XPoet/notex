import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  importNote: vi.fn(),
  toImportError: vi.fn((error: unknown) => error),
}))
vi.mock('@/services/imports', () => service)

import { useImportsStore } from '@/stores/imports'
import type { NoteDetail } from '@/types/notes'

function note(id: string): NoteDetail {
  return { id, title: id, content: '正文', isPinned: false, createdAt: '', updatedAt: '' }
}

describe('笔记导入 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    service.importNote.mockReset()
  })

  it('串行导入，单篇失败后继续，并且只重试失败项', async () => {
    const store = useImportsStore()
    const files = [
      new File(['a'], '同名.md'),
      new File(['b'], '同名.TXT'),
      new File(['c'], '记录.md'),
    ]
    store.addFiles(files)
    expect(store.items.map((item) => item.title)).toEqual(['同名', '同名', '记录'])
    service.importNote
      .mockResolvedValueOnce(note('first'))
      .mockRejectedValueOnce({ code: 'IMPORT_SAVE_FAILED', message: '保存失败' })
      .mockResolvedValueOnce(note('third'))
    await store.start()
    expect(store.items.map((item) => item.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(store.succeededCount).toBe(2)
    expect(store.failedCount).toBe(1)
    store.addFiles([new File(['d'], '还未导入.txt')])
    service.importNote.mockResolvedValueOnce(note('second'))
    await store.start(true)
    expect(service.importNote).toHaveBeenCalledTimes(4)
    expect(service.importNote).toHaveBeenLastCalledWith(files[1])
    expect(store.items[3]?.status).toBe('pending')
    expect(store.succeededCount).toBe(3)
    await store.start(true)
    expect(service.importNote).toHaveBeenCalledTimes(4)
  })

  it('导入中不能重复启动、追加、移出或清空文件', async () => {
    const store = useImportsStore()
    store.addFiles([new File(['body'], 'note.md')])
    let finish: ((value: NoteDetail) => void) | undefined
    service.importNote.mockImplementation(
      () =>
        new Promise<NoteDetail>((resolve) => {
          finish = resolve
        }),
    )
    const running = store.start()
    expect(store.items[0]?.status).toBe('importing')
    await store.start()
    store.addFiles([new File([], 'other.md')])
    store.removeItem(store.items[0]?.id ?? '')
    store.clear()
    expect(store.items).toHaveLength(1)
    expect(service.importNote).toHaveBeenCalledTimes(1)
    finish?.(note('saved'))
    await running
    expect(store.isImporting).toBe(false)
    expect(store.items[0]?.noteId).toBe('saved')
  })

  it('取消选择保留清单，超过 100 个时拒绝整批且可清空后重选', () => {
    const store = useImportsStore()
    store.addFiles([new File([], 'first.md')])
    store.addFiles([])
    expect(store.items).toHaveLength(1)
    store.addFiles(Array.from({ length: 100 }, (_, index) => new File([], `${index}.txt`)))
    expect(store.items).toHaveLength(1)
    expect(store.selectionError).toContain('100')
    store.clear()
    expect(store.items).toHaveLength(0)
    expect(store.selectionError).toBeUndefined()
  })
})

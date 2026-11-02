import { flushPromises } from '@vue/test-utils'
import { effectScope, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNoteImageReferences, useNoteImages } from '@/composables/useNoteImages'
import { loadNoteImage } from '@/services/assets'

vi.mock('@/services/assets', () => ({ loadNoteImage: vi.fn() }))
const scopes: ReturnType<typeof effectScope>[] = []
const revokeObjectURL = vi.fn()

function createCache(maxBytes = 100, concurrency = 2) {
  const scope = effectScope()
  scopes.push(scope)
  const id = shallowRef('note')
  const references = shallowRef(
    getNoteImageReferences('![a](./assets/a.png)\n![b](./assets/b.png)\n![c](./assets/c.png)'),
  )
  const visible = shallowRef<readonly string[]>(['assets/c.png'])
  const controller = scope.run(() =>
    useNoteImages(
      () => id.value,
      () => references.value,
      { maxBytes, concurrency, visiblePaths: () => visible.value },
    ),
  )
  if (controller === undefined) throw new Error('未创建图片作用域')
  return { controller, id, references, visible, scope }
}

describe('图片读取调度与字节预算', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL }))
  })
  afterEach(() => {
    for (const scope of scopes) scope.stop()
    scopes.length = 0
  })

  it('可见图片优先，缩略图读取总并发不超过配置', async () => {
    const pending = new Map<string, () => void>()
    vi.mocked(loadNoteImage).mockImplementation(
      (_id, path, options) =>
        new Promise((resolve) => {
          pending.set(path, () => {
            options?.onByteLength?.(5)
            resolve(`blob:${path}`)
          })
        }),
    )
    const { controller } = createCache()
    expect(vi.mocked(loadNoteImage).mock.calls.map((call) => call[1])).toEqual(['assets/c.png', 'assets/a.png'])
    pending.get('assets/c.png')?.()
    await flushPromises()
    expect(loadNoteImage).toHaveBeenCalledTimes(3)
    expect(controller.retainedBytes.value).toBe(5)
    pending.get('assets/a.png')?.()
    pending.get('assets/b.png')?.()
    await flushPromises()
    expect(controller.retainedBytes.value).toBe(15)
  })

  it('达到预算不淘汰可见缩略图，滚动后释放旧的非可见资源', async () => {
    vi.mocked(loadNoteImage).mockImplementation(async (_id, path, options) => {
      options?.onByteLength?.(1)
      options?.onMemoryCost?.(6)
      return `blob:${path}`
    })
    const { controller, visible } = createCache(10, 1)
    await flushPromises()
    expect(controller.retainedBytes.value).toBe(6)
    expect(controller.images.value.find((image) => image.relativePath === 'assets/c.png')?.url).toBe(
      'blob:assets/c.png',
    )
    visible.value = ['assets/b.png']
    await flushPromises()
    expect(controller.retainedBytes.value).toBe(6)
    expect(controller.images.value.find((image) => image.relativePath === 'assets/b.png')?.url).toBe(
      'blob:assets/b.png',
    )
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assets/c.png')
  })

  it('卸载后的迟到缩略图结果立即释放，不进入缓存', async () => {
    let complete: (() => void) | undefined
    vi.mocked(loadNoteImage).mockImplementation(
      (_id, _path, options) =>
        new Promise((resolve) => {
          complete = () => {
            options?.onByteLength?.(5)
            resolve('blob:late')
          }
        }),
    )
    const { controller, scope } = createCache(10, 1)
    scope.stop()
    complete?.()
    await flushPromises()
    expect(controller.retainedBytes.value).toBe(0)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:late')
  })

  it('原图按需读取并执行独立字节上限，超限结果立即释放', async () => {
    vi.mocked(loadNoteImage).mockImplementation(async (_id, path, options) => {
      options?.onByteLength?.(options.thumbnail === true ? 1 : 11)
      return `${options.thumbnail === true ? 'blob:thumb' : 'blob:original'}:${path}`
    })
    const { controller } = createCache(10, 1)
    await flushPromises()
    expect(vi.mocked(loadNoteImage).mock.calls.every((call) => call[2]?.thumbnail === true)).toBe(true)
    await expect(controller.loadOriginal('assets/c.png')).rejects.toThrow('图片无法读取')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:original:assets/c.png')
    expect(controller.retainedBytes.value).toBe(3)
  })
})

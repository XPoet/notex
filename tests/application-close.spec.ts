import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useApplicationClose } from '@/composables/useApplicationClose'
import { useNotesStore } from '@/stores/notes'

const { onExitRequested, exitApplication, messageError } = vi.hoisted(() => ({
  onExitRequested: vi.fn(),
  exitApplication: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('@/services/window', () => ({ onExitRequested, exitApplication }))
vi.mock('element-plus', () => ({ ElMessage: { error: messageError } }))

const Host = defineComponent({
  setup() {
    useApplicationClose()
    return () => null
  },
})

async function mountHost() {
  const pinia = createPinia()
  const store = useNotesStore(pinia)
  const flush = vi.spyOn(store, 'flush').mockResolvedValue()
  const wrapper = mount(Host, { global: { plugins: [pinia] } })
  await flushPromises()
  const close: () => Promise<void> = onExitRequested.mock.calls[0][0]
  return { wrapper, store, flush, close }
}

describe('应用级静默关闭', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    onExitRequested.mockResolvedValue(vi.fn())
    exitApplication.mockResolvedValue(undefined)
  })

  it('无论处于哪个页面，都在当前草稿保存完成后请求后台备份退出', async () => {
    const { wrapper, flush, close } = await mountHost()
    let finishSave: () => void = () => undefined
    flush.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSave = resolve)))

    const closing = close()
    expect(exitApplication).not.toHaveBeenCalled()
    finishSave()
    await closing

    expect(exitApplication).toHaveBeenCalledOnce()
    expect(messageError).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('保存过程中又有修改时，继续保存最新草稿再退出', async () => {
    const { wrapper, store, flush, close } = await mountHost()
    flush.mockImplementationOnce(async () => {
      store.isDirty = true
    })
    flush.mockImplementationOnce(async () => {
      store.isDirty = false
    })

    await close()

    expect(flush).toHaveBeenCalledTimes(2)
    expect(exitApplication).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('连续关闭请求只触发一次保存和备份', async () => {
    const { wrapper, flush, close } = await mountHost()
    let finishBackup: () => void = () => undefined
    exitApplication.mockImplementationOnce(() => new Promise<void>((resolve) => (finishBackup = resolve)))

    const closing = close()
    await flushPromises()
    await close()
    expect(flush).toHaveBeenCalledOnce()
    expect(exitApplication).toHaveBeenCalledOnce()
    finishBackup()
    await closing
    wrapper.unmount()
  })

  it('保存失败时阻止关闭，并允许重试', async () => {
    const { wrapper, flush, close } = await mountHost()
    flush.mockRejectedValueOnce(new Error('save failed'))

    await close()
    expect(exitApplication).not.toHaveBeenCalled()
    expect(messageError).toHaveBeenCalledOnce()

    await close()
    expect(exitApplication).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('卸载早于监听注册完成时也会注销监听', async () => {
    const stop = vi.fn()
    let finishRegistration: (value: () => void) => void = () => undefined
    onExitRequested.mockImplementationOnce(() => new Promise<() => void>((resolve) => (finishRegistration = resolve)))
    const { wrapper } = await mountHost()
    wrapper.unmount()
    finishRegistration(stop)
    await flushPromises()
    expect(stop).toHaveBeenCalledOnce()
  })
})

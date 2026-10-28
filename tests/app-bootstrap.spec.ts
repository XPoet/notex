import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppBootstrap from '@/app/AppBootstrap.vue'

const services = vi.hoisted(() => ({
  bootstrapApp: vi.fn(),
  getAccessStatus: vi.fn(),
  showMainWindow: vi.fn(),
}))

vi.mock('@/services/bootstrap', () => ({
  bootstrapApp: services.bootstrapApp,
  toBootstrapError: (error: unknown) => error,
}))

vi.mock('@/services/window', () => ({
  showMainWindow: services.showMainWindow,
}))

vi.mock('@/services/security', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/security')>()),
  getAccessStatus: services.getAccessStatus,
}))

describe('AppBootstrap', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    services.getAccessStatus.mockResolvedValue({ passwordEnabled: false, locked: false })
    services.showMainWindow.mockResolvedValue(undefined)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('初始化失败时展示安全诊断和重试入口', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    services.bootstrapApp.mockRejectedValue({
      code: 'DATA_DIRECTORY_NOT_WRITABLE',
      message: '应用数据目录不可写，请检查磁盘空间和目录权限后重试。',
    })

    const wrapper = mount(AppBootstrap, {
      global: {
        plugins: [pinia],
        stubs: {
          'el-button': {
            template: '<button><slot /></button>',
          },
        },
      },
    })

    await flushPromises()
    expect(wrapper.text()).toContain('无法初始化本地数据')
    expect(wrapper.text()).toContain('应用数据目录不可写')
    expect(wrapper.find('button').text()).toBe('重试')
    expect(services.showMainWindow).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('配置密码时展示解锁页并显示窗口，不调用工作区初始化', async () => {
    services.getAccessStatus.mockResolvedValue({ passwordEnabled: true, locked: true })
    const wrapper = mount(AppBootstrap, {
      global: {
        plugins: [createPinia()],
        stubs: {
          UnlockScreen: { template: '<section>解锁 NoteX</section>' },
        },
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('解锁 NoteX')
    expect(services.bootstrapApp).not.toHaveBeenCalled()
    expect(services.showMainWindow).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

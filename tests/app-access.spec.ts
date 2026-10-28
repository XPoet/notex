import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const services = vi.hoisted(() => ({
  getAccessStatus: vi.fn(),
  unlockApp: vi.fn(),
  configureStartupPassword: vi.fn(),
  bootstrapApp: vi.fn(),
  getSettings: vi.fn(),
}))

vi.mock('@/services/security', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/security')>()),
  getAccessStatus: services.getAccessStatus,
  unlockApp: services.unlockApp,
  configureStartupPassword: services.configureStartupPassword,
}))
vi.mock('@/services/bootstrap', () => ({
  bootstrapApp: services.bootstrapApp,
  toBootstrapError: (error: unknown) => error,
}))
vi.mock('@/services/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/settings')>()),
  getSettings: services.getSettings,
}))

import { useAppStore } from '@/stores/app'
import { useSecurityStore } from '@/stores/security'

describe('启动访问控制', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    services.getAccessStatus.mockReset()
    services.unlockApp.mockReset()
    services.bootstrapApp.mockResolvedValue({ status: 'ready', schemaVersion: 3 })
    services.getSettings.mockResolvedValue({ theme: 'light', editorFontSize: 15 })
  })

  it('配置了密码时停留在解锁状态，不初始化笔记工作区或读取设置', async () => {
    services.getAccessStatus.mockResolvedValue({ passwordEnabled: true, locked: true })
    const store = useAppStore()
    await store.bootstrap()
    expect(store.status).toBe('locked')
    expect(services.bootstrapApp).not.toHaveBeenCalled()
    expect(services.getSettings).not.toHaveBeenCalled()
  })

  it('未配置密码时先初始化数据库，再读取设置，最后显示路由', async () => {
    services.getAccessStatus.mockResolvedValue({ passwordEnabled: false, locked: false })
    const store = useAppStore()
    await store.bootstrap()
    expect(store.status).toBe('ready')
    expect(services.getAccessStatus.mock.invocationCallOrder[0]).toBeLessThan(
      services.bootstrapApp.mock.invocationCallOrder[0] ?? Infinity,
    )
    expect(services.bootstrapApp.mock.invocationCallOrder[0]).toBeLessThan(
      services.getSettings.mock.invocationCallOrder[0] ?? Infinity,
    )
  })

  it('错误密码保留锁定状态，正确密码后才进入工作区', async () => {
    services.getAccessStatus.mockResolvedValue({ passwordEnabled: true, locked: true })
    const store = useAppStore()
    await store.bootstrap()
    services.unlockApp.mockRejectedValueOnce({
      code: 'PASSWORD_INCORRECT',
      message: '密码不正确，请重新输入。',
    })
    await expect(store.unlock('错误密码')).rejects.toMatchObject({ code: 'PASSWORD_INCORRECT' })
    expect(store.status).toBe('locked')
    expect(useSecurityStore().error?.message).toContain('密码不正确')
    expect(services.bootstrapApp).not.toHaveBeenCalled()

    services.unlockApp.mockResolvedValue({ passwordEnabled: true, locked: false })
    services.getAccessStatus.mockResolvedValue({ passwordEnabled: true, locked: false })
    await store.unlock('正确密码123')
    expect(store.status).toBe('ready')
    expect(useSecurityStore().error).toBeUndefined()
    expect(services.bootstrapApp).toHaveBeenCalledTimes(1)
    expect(services.getSettings).toHaveBeenCalledTimes(1)
  })

  it('密码配置读取失败时显示诊断，不回退为免密码启动', async () => {
    services.getAccessStatus.mockRejectedValue({
      code: 'PASSWORD_READ_FAILED',
      message: '无法读取开启密码配置，请重试。',
    })
    const store = useAppStore()
    await store.bootstrap()
    expect(store.status).toBe('failed')
    expect(store.error?.code).toBe('PASSWORD_READ_FAILED')
    expect(services.bootstrapApp).not.toHaveBeenCalled()
    expect(services.getSettings).not.toHaveBeenCalled()
  })
})

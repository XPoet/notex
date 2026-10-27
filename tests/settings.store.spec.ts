import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsService = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  toSettingsError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/settings', () => settingsService)

import { useSettingsStore } from '@/stores/settings'

const snapshot = {
  theme: 'dark' as const,
  noteSort: 'title' as const,
  editorFontSize: 17 as const,
  showCategoryCounts: false,
  dataDirectory: '/Users/example/Library/Application Support/cn.xpoet.notex',
  defaultExportDirectory: '/Users/example/Desktop',
  hasCustomDefaultExportDirectory: false,
  appVersion: '0.1.0',
  schemaVersion: 3,
}

describe('settings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    settingsService.getSettings.mockReset()
    settingsService.saveSettings.mockReset()
    settingsService.toSettingsError.mockImplementation((error: unknown) => error)
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.classList.remove('dark')
    document.documentElement.style.removeProperty('--editor-font-size')
  })

  it('读取设置后立即恢复主题与编辑器字体大小', async () => {
    settingsService.getSettings.mockResolvedValue(snapshot)
    const store = useSettingsStore()

    await store.load()

    expect(store.snapshot).toEqual(snapshot)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('17px')
  })

  it('跟随系统时使用当前系统颜色模式更新 Element Plus 暗色 class', async () => {
    let systemIsDark = true
    const changeListeners: Array<() => void> = []
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        get matches() {
          return systemIsDark
        },
        addEventListener: (_event: 'change', listener: () => void) => {
          changeListeners.push(listener)
        },
      }),
    )
    settingsService.getSettings.mockResolvedValue({ ...snapshot, theme: 'system' })
    const store = useSettingsStore()

    await store.load()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(changeListeners).toHaveLength(1)

    systemIsDark = false
    changeListeners[0]?.()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('重复进入设置不会重复读取已经加载的快照', async () => {
    settingsService.getSettings.mockResolvedValue(snapshot)
    const store = useSettingsStore()

    await store.load()
    await store.load()

    expect(settingsService.getSettings).toHaveBeenCalledTimes(1)
  })

  it('保存合法设置后保留经过后端校验的目录快照', async () => {
    settingsService.saveSettings.mockResolvedValue(snapshot)
    const store = useSettingsStore()

    await store.save({
      theme: 'dark',
      noteSort: 'title',
      editorFontSize: 17,
      showCategoryCounts: false,
      defaultExportDirectory: '/private/export-target',
    })

    expect(settingsService.saveSettings).toHaveBeenCalled()
    expect(store.snapshot).toEqual(snapshot)
  })
})

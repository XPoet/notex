import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsService = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  toSettingsError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/settings', () => settingsService)

import { useSettingsStore } from '@/stores/settings'
import { locale } from '@/i18n'
import { LANGUAGE_STORAGE_KEY } from '@/i18n/locale'

const snapshot = {
  language: 'zh-CN' as const,
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
      language: 'zh-CN',
      theme: 'dark',
      noteSort: 'title',
      editorFontSize: 17,
      showCategoryCounts: false,
      defaultExportDirectory: '/private/export-target',
    })

    expect(settingsService.saveSettings).toHaveBeenCalled()
    expect(store.snapshot).toEqual(snapshot)
  })

  it('未保存语言时默认选择系统语种，无法匹配时选择英语', async () => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-Hant-HK')
    settingsService.getSettings.mockResolvedValue({ ...snapshot, language: null })
    await useSettingsStore().load()
    expect(locale.value).toBe('zh-TW')
    expect(document.documentElement.lang).toBe('zh-TW')

    setActivePinia(createPinia())
    language.mockReturnValue('fr-FR')
    await useSettingsStore().load()
    expect(locale.value).toBe('en')
    language.mockRestore()
  })

  it('保存成功后立即切换语言，并为下次解锁前的界面缓存语种', async () => {
    settingsService.getSettings.mockResolvedValue(snapshot)
    const store = useSettingsStore()
    await store.load()
    settingsService.saveSettings.mockResolvedValue({ ...snapshot, language: 'en' })
    await store.save({ ...snapshot, language: 'en' })

    expect(locale.value).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
  })

  it('保存失败保留当前语言与缓存', async () => {
    settingsService.getSettings.mockResolvedValue(snapshot)
    const store = useSettingsStore()
    await store.load()
    settingsService.saveSettings.mockRejectedValue({ code: 'SETTINGS_SAVE_FAILED' })
    await expect(store.save({ ...snapshot, language: 'en' })).rejects.toMatchObject({
      code: 'SETTINGS_SAVE_FAILED',
    })
    expect(locale.value).toBe('zh-CN')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN')
    expect(store.snapshot?.language).toBe('zh-CN')
  })
})

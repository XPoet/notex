import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { applyLanguage } from '@/i18n'
import { getSettings, saveSettings, toSettingsError } from '@/services/settings'
import type { SaveSettingsRequest, SettingsError, SettingsSnapshot } from '@/types/settings'

function applyPreferences(settings: SettingsSnapshot): void {
  applyLanguage(settings.language ?? null)
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.classList.toggle('dark', settings.theme === 'dark' || isSystemDark(settings.theme))
  root.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`)
}

function isSystemDark(theme: SettingsSnapshot['theme']): boolean {
  return (
    theme === 'system' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export const useSettingsStore = defineStore('settings', () => {
  const snapshot = shallowRef<SettingsSnapshot>()
  const error = shallowRef<SettingsError>()
  const isLoading = shallowRef(false)
  const isSaving = shallowRef(false)
  let loadingTask: Promise<void> | undefined
  let systemThemeQuery: MediaQueryList | undefined

  function observeSystemTheme(): void {
    if (systemThemeQuery !== undefined || typeof window.matchMedia !== 'function') return
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemThemeQuery.addEventListener('change', () => {
      if (snapshot.value?.theme === 'system') applyPreferences(snapshot.value)
    })
  }

  function load(): Promise<void> {
    if (snapshot.value !== undefined) return Promise.resolve()
    if (loadingTask !== undefined) return loadingTask

    isLoading.value = true
    error.value = undefined
    loadingTask = getSettings()
      .then((settings) => {
        snapshot.value = settings
        applyPreferences(settings)
        observeSystemTheme()
      })
      .catch((failure: unknown) => {
        error.value = toSettingsError(failure)
      })
      .finally(() => {
        isLoading.value = false
        loadingTask = undefined
      })

    return loadingTask
  }

  async function save(request: SaveSettingsRequest): Promise<void> {
    isSaving.value = true
    error.value = undefined
    try {
      snapshot.value = await saveSettings(request)
      applyPreferences(snapshot.value)
    } catch (failure: unknown) {
      error.value = toSettingsError(failure)
      throw error.value
    } finally {
      isSaving.value = false
    }
  }

  return { snapshot, error, isLoading, isSaving, load, save }
})

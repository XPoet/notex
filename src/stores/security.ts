import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import {
  configureStartupPassword,
  getAccessStatus,
  toAccessError,
  unlockApp,
} from '@/services/security'
import type { AccessError, AccessSnapshot, ConfigurePasswordRequest } from '@/types/security'

export const useSecurityStore = defineStore('security', () => {
  const snapshot = shallowRef<AccessSnapshot>()
  const error = shallowRef<AccessError>()
  const isUnlocking = shallowRef(false)
  const isSaving = shallowRef(false)

  function clearError(): void {
    error.value = undefined
  }

  async function load(): Promise<AccessSnapshot> {
    snapshot.value = await getAccessStatus()
    return snapshot.value
  }

  async function unlock(password: string): Promise<void> {
    if (isUnlocking.value) return
    isUnlocking.value = true
    clearError()
    try {
      snapshot.value = await unlockApp(password)
    } catch (failure: unknown) {
      error.value = toAccessError(failure)
      throw error.value
    } finally {
      isUnlocking.value = false
    }
  }

  async function configure(request: ConfigurePasswordRequest): Promise<void> {
    if (isSaving.value) return
    isSaving.value = true
    clearError()
    try {
      snapshot.value = await configureStartupPassword(request)
    } catch (failure: unknown) {
      error.value = toAccessError(failure)
      throw error.value
    } finally {
      isSaving.value = false
    }
  }

  return { snapshot, error, isUnlocking, isSaving, load, unlock, configure, clearError }
})

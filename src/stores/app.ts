import { defineStore } from 'pinia'
import { ref } from 'vue'
import { bootstrapApp, toBootstrapError } from '@/services/bootstrap'
import type { BootstrapError, BootstrapSnapshot } from '@/types/bootstrap'
import type { AccessError, AccessSnapshot } from '@/types/security'
import { toAccessError } from '@/services/security'
import { useSecurityStore } from '@/stores/security'
import { useSettingsStore } from '@/stores/settings'

export type AppBootstrapState = 'idle' | 'loading' | 'locked' | 'ready' | 'failed'

export const useAppStore = defineStore('app', () => {
  const status = ref<AppBootstrapState>('idle')
  const snapshot = ref<BootstrapSnapshot>()
  const error = ref<BootstrapError | AccessError>()
  const securityStore = useSecurityStore()

  async function bootstrap(): Promise<void> {
    status.value = 'loading'
    error.value = undefined

    try {
      let access: AccessSnapshot
      try {
        access = await securityStore.load()
      } catch (failure: unknown) {
        error.value = toAccessError(failure)
        status.value = 'failed'
        return
      }
      if (access.locked) {
        status.value = 'locked'
        return
      }
      snapshot.value = await bootstrapApp()
      await useSettingsStore().load()
      status.value = 'ready'
    } catch (failure: unknown) {
      error.value = toBootstrapError(failure)
      status.value = 'failed'
    }
  }

  async function unlock(password: string): Promise<void> {
    await securityStore.unlock(password)
    await bootstrap()
  }

  return {
    status,
    snapshot,
    error,
    bootstrap,
    unlock,
  }
})

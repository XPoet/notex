import { onBeforeUnmount, shallowRef } from 'vue'

export interface AutoSaveController {
  schedule: () => void
  flush: () => Promise<void>
  cancel: () => void
  pending: Readonly<{ value: boolean }>
}

export function useAutoSave(save: () => Promise<void>, delay = 1_000): AutoSaveController {
  const pending = shallowRef(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function cancel(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    pending.value = false
  }

  async function flush(): Promise<void> {
    cancel()
    await save()
  }

  function schedule(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    pending.value = true
    timer = setTimeout(() => {
      timer = undefined
      pending.value = false
      // 显式 flush 向调用方传播错误；定时保存的错误由 Store 留在界面中。
      void save().catch(() => undefined)
    }, delay)
  }

  onBeforeUnmount(cancel)

  return { schedule, flush, cancel, pending }
}

import { t } from '@/i18n'
import { onBeforeUnmount, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { exitApplication, onExitRequested } from '@/services/window'
import { useNotesStore } from '@/stores/notes'

export function useApplicationClose(): void {
  const notesStore = useNotesStore()
  let unlisten: (() => void) | undefined
  let disposed = false
  let closing = false

  async function close(): Promise<void> {
    if (closing) return
    closing = true
    try {
      do {
        await notesStore.flush()
      } while (notesStore.isDirty)
      await exitApplication()
    } catch {
      closing = false
      ElMessage.error(t('无法完成关闭，请检查笔记保存状态后重试。'))
    }
  }

  onMounted(async () => {
    try {
      const stop = await onExitRequested(close)
      if (disposed) {
        stop()
      } else {
        unlisten = stop
      }
    } catch {}
  })

  onBeforeUnmount(() => {
    disposed = true
    unlisten?.()
  })
}

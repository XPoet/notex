import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** 所有页面共用关闭入口，覆盖窗口关闭与系统菜单退出。 */
export function onExitRequested(handler: () => Promise<void>): Promise<UnlistenFn> {
  return listen('notex-exit-requested', () => {
    void handler()
  })
}

/** 在首屏绘制完成后显示原生主窗口，避免暴露 WebView 的空白初始帧。 */
export async function showMainWindow(): Promise<void> {
  try {
    await invoke<void>('show_main_window')
  } catch {}
}

/** 草稿落盘后隐藏窗口，由 Rust 完成静默压缩备份再退出进程。 */
export async function exitApplication(): Promise<void> {
  await invoke<void>('exit_application')
}

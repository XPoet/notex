import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const listen = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

import { exitApplication, onExitRequested, showMainWindow } from '@/services/window'

describe('window service', () => {
  it('监听原生关闭事件，并返回注销函数', async () => {
    const stop = vi.fn()
    listen.mockResolvedValueOnce(stop)
    const handler = vi.fn().mockResolvedValue(undefined)

    expect(await onExitRequested(handler)).toBe(stop)
    expect(listen).toHaveBeenCalledWith('notex-exit-requested', expect.any(Function))
    listen.mock.calls[0][1]()
    expect(handler).toHaveBeenCalledOnce()
  })
  it('只请求受控的主窗口显示命令', async () => {
    invoke.mockResolvedValue(undefined)

    await showMainWindow()

    expect(invoke).toHaveBeenCalledWith('show_main_window')
  })

  it('静态预览缺少原生 IPC 时保持页面可用', async () => {
    invoke.mockRejectedValue(new Error('Tauri IPC unavailable'))

    await expect(showMainWindow()).resolves.toBeUndefined()
  })

  it('通过受控原生命令退出应用', async () => {
    invoke.mockResolvedValue(undefined)

    await exitApplication()

    expect(invoke).toHaveBeenCalledWith('exit_application')
  })
})

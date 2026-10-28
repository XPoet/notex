import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exportService = vi.hoisted(() => ({
  cancelExport: vi.fn(),
  chooseExportDirectory: vi.fn(),
  exportNotes: vi.fn(),
  openExportDirectory: vi.fn(),
  toExportError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/export', () => exportService)

import { useExportStore } from '@/stores/export'

const scope = { kind: 'note' as const, id: 'note-1' }
const result = {
  jobId: '118de0d6-6a4c-4f1e-bef1-5f0878069a8a',
  directoryLabel: 'NoteX 导出-20260724-120000',
  exportedCount: 1,
  failedCount: 0,
  cancelled: false,
  issues: [],
}

describe('export store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    exportService.cancelExport.mockReset()
    exportService.chooseExportDirectory.mockReset()
    exportService.exportNotes.mockReset()
    exportService.openExportDirectory.mockReset()
    exportService.toExportError.mockImplementation((error: unknown) => error)
  })

  it('选择目录后接收 Channel 进度和安全结果，并在当前会话复用目标目录', async () => {
    exportService.chooseExportDirectory.mockResolvedValue('/private/export-target')
    exportService.exportNotes.mockImplementation((_request: unknown, onProgress: (value: typeof progress) => void) => {
      onProgress(progress)
      return Promise.resolve(result)
    })
    const store = useExportStore()

    await store.chooseDirectory()
    await store.start(scope)

    expect(exportService.exportNotes).toHaveBeenCalledWith(
      expect.objectContaining({ scope, targetDirectory: '/private/export-target' }),
      expect.any(Function),
    )
    expect(store.status).toBe('completed')
    expect(store.progress).toEqual(progress)
    expect(store.result).toEqual(result)
    expect(JSON.stringify(store.result)).not.toContain('/private/export-target')
    expect(store.targetDirectory).toBe('/private/export-target')
  })

  it('未选择目录时不会启动导出任务', async () => {
    const store = useExportStore()

    await store.start(scope)

    expect(exportService.exportNotes).not.toHaveBeenCalled()
    expect(store.status).toBe('idle')
  })

  it('取消时只向当前受控任务发送任务标识，并等待后端结果', async () => {
    exportService.chooseExportDirectory.mockResolvedValue('/private/export-target')
    let resolveExport: ((value: typeof result) => void) | undefined
    exportService.exportNotes.mockImplementation(
      () =>
        new Promise<typeof result>((resolve) => {
          resolveExport = resolve
        }),
    )
    exportService.cancelExport.mockResolvedValue(undefined)
    const store = useExportStore()

    await store.chooseDirectory()
    const running = store.start(scope)
    await Promise.resolve()
    await store.cancel()
    resolveExport?.({ ...result, cancelled: true, exportedCount: 0 })
    await running

    expect(exportService.cancelExport).toHaveBeenCalledWith(expect.any(String))
    expect(store.status).toBe('completed')
    expect(store.result?.cancelled).toBe(true)
  })
})

const progress = {
  total: 2,
  processed: 1,
  succeeded: 1,
  failed: 0,
  currentTitle: '第一篇笔记',
}

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importNote, toImportError } from '@/services/imports'
import { MAX_IMPORT_FILE_BYTES } from '@/types/imports'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('笔记导入 Service', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('仅传递用户选择的文件名与原始字节，由 Rust 解码和保存', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 35, 32, 0xe4, 0xb8, 0xad, 10])
    const note = { id: 'note', title: '记录' }
    vi.mocked(invoke).mockResolvedValue(note)
    await expect(importNote(new File([bytes], '记录.MD', { type: 'application/octet-stream' }))).resolves.toEqual(note)
    expect(invoke).toHaveBeenCalledWith('import_note', {
      fileName: '记录.MD',
      bytes: Array.from(bytes),
    })
  })

  it('空白 TXT 文件也可创建有标题的笔记', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 'empty' })
    await importNote(new File([], '空白.txt'))
    expect(invoke).toHaveBeenCalledWith('import_note', { fileName: '空白.txt', bytes: [] })
  })

  it('不读取超限文件、不发送不支持的文件', async () => {
    await expect(importNote(new File(['body'], 'image.png'))).rejects.toMatchObject({
      code: 'IMPORT_UNSUPPORTED_FORMAT',
    })
    const file = new File([], 'large.md')
    Object.defineProperty(file, 'size', { value: MAX_IMPORT_FILE_BYTES + 1 })
    await expect(importNote(file)).rejects.toMatchObject({ code: 'IMPORT_FILE_TOO_LARGE' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('保留后端安全错误，未知错误使用通用提示', async () => {
    const error = { code: 'IMPORT_INVALID_ENCODING', message: '请转换为 UTF-8。' }
    vi.mocked(invoke).mockRejectedValue(error)
    await expect(importNote(new File(['bad'], 'note.txt'))).rejects.toEqual(error)
    expect(toImportError(new Error('/private/sensitive-path'))).toEqual({
      code: 'IMPORT_SAVE_FAILED',
      message: '笔记导入失败，请重试。',
    })
  })
})

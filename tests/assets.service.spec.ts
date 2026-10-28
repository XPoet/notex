import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadNoteImage } from '@/services/assets'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const createObjectURL = vi.fn((_blob: Blob | MediaSource) => 'blob:preview')

describe('本地图片读取 Service', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }))
  })

  it.each(['ArrayBuffer', 'macOS 数字数组'])('将 %s 响应保留为原始图片字节', async (transport) => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 255, 128])
    vi.mocked(invoke).mockResolvedValue(transport === 'ArrayBuffer' ? bytes.buffer : Array.from(bytes))
    expect(await loadNoteImage('note', 'assets/a.jpg')).toBe('blob:preview')
    expect(invoke).toHaveBeenCalledWith('read_note_image', {
      noteId: 'note',
      relativePath: 'assets/a.jpg',
    })
    const blob = createObjectURL.mock.calls[0]?.[0]
    expect(blob).toBeInstanceOf(Blob)
    if (blob instanceof Blob) {
      expect(blob.type).toBe('image/jpeg')
      expect(blob.size).toBe(bytes.byteLength)
      const content = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          if (reader.result instanceof ArrayBuffer) resolve(reader.result)
          else reject(new Error('未读取到二进制 Blob'))
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(blob)
      })
      expect(new Uint8Array(content)).toEqual(bytes)
    }
  })

  it('保留图片读取错误码与提示', async () => {
    const failure = { code: 'ASSET_READ_FAILED', message: '图片无法读取，资源缺失或文件无效。' }
    vi.mocked(invoke).mockRejectedValue(failure)
    await expect(loadNoteImage('note', 'assets/missing.png')).rejects.toEqual(failure)
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

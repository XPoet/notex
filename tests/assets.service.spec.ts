import { invoke } from '@tauri-apps/api/core'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyNoteAsset, loadNoteImage, saveNoteAttachment } from '@/services/assets'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const createObjectURL = vi.fn((_blob: Blob | MediaSource) => 'blob:preview')

describe('本地图片读取 Service', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }))
  })

  it('附件使用原始二进制 IPC 和编码后的文件名，避免大文件数字数组序列化', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45])
    const file = new File([bytes], '报告 [终稿].pdf')
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
    vi.mocked(invoke).mockResolvedValue({ id: 'file' })
    await saveNoteAttachment('note', file)
    expect(invoke).toHaveBeenCalledWith('save_note_attachment', bytes.buffer, {
      headers: { 'x-note-id': 'note', 'x-file-name': encodeURIComponent(file.name) },
    })
  })

  it('超出附件大小限制时在读取和 IPC 前拒绝', async () => {
    const file = new File([], 'large.pdf')
    Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 })
    await expect(saveNoteAttachment('note', file)).rejects.toMatchObject({ code: 'ASSET_FILE_TOO_LARGE' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('按笔记 ID 和资源相对路径复制附件，保留剪贴板错误', async () => {
    const failure = { code: 'ASSET_CLIPBOARD_WRITE_FAILED', message: '无法将附件复制到剪贴板。' }
    vi.mocked(invoke).mockRejectedValue(failure)
    await expect(copyNoteAsset('note', 'assets/note/file.pdf')).rejects.toEqual(failure)
    expect(invoke).toHaveBeenCalledWith('copy_note_asset', { noteId: 'note', relativePath: 'assets/note/file.pdf' })
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

  it('请求受限缩略图时按 PNG 创建预览并报告实际传输字节数', async () => {
    const bytes = new Uint8Array(24)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const header = new DataView(bytes.buffer)
    header.setUint32(8, 13)
    header.setUint32(12, 0x49484452)
    header.setUint32(16, 2)
    header.setUint32(20, 3)
    vi.mocked(invoke).mockResolvedValue(Array.from(bytes))
    const onByteLength = vi.fn()
    const onMemoryCost = vi.fn()
    await loadNoteImage('note', 'assets/a.gif', { thumbnail: true, onByteLength, onMemoryCost })
    expect(invoke).toHaveBeenCalledWith('read_note_image', {
      noteId: 'note',
      relativePath: 'assets/a.gif',
      thumbnail: true,
    })
    expect(onByteLength).toHaveBeenCalledWith(24)
    expect(onMemoryCost).toHaveBeenCalledWith(48)
    const blob = createObjectURL.mock.calls[0]?.[0]
    expect(blob).toBeInstanceOf(Blob)
    if (blob instanceof Blob) expect(blob.type).toBe('image/png')
  })

  it('缩略图头无效时拒绝创建 URL，避免按未知像素体积计费', async () => {
    vi.mocked(invoke).mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    await expect(
      loadNoteImage('note', 'assets/a.png', { thumbnail: true, onMemoryCost: vi.fn() }),
    ).rejects.toMatchObject({ code: 'ASSET_SAVE_FAILED' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('跨调用限制为两个原生读取，已取消的排队请求不触发 IPC', async () => {
    const complete: (() => void)[] = []
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete.push(() => resolve(new Uint8Array([1]).buffer))
        }),
    )
    const first = loadNoteImage('note', 'assets/a.png')
    const second = loadNoteImage('note', 'assets/b.png')
    const controller = new AbortController()
    const third = loadNoteImage('note', 'assets/c.png', { signal: controller.signal }).catch((error: unknown) => error)
    await flushPromises()
    expect(invoke).toHaveBeenCalledTimes(2)
    controller.abort()
    complete[0]?.()
    await first
    await third
    expect(invoke).toHaveBeenCalledTimes(2)
    complete[1]?.()
    await second
  })
})

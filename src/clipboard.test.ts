import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard } from './clipboard'
import { hasBridge, invoke } from './bridge'

vi.mock('./bridge', () => ({
  hasBridge: vi.fn(),
  invoke: vi.fn(),
}))

const mockedHasBridge = vi.mocked(hasBridge)
const mockedInvoke = vi.mocked(invoke)

describe('writeClipboard', () => {
  let clipboardWrite: ReturnType<typeof vi.fn>
  let execCommand: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clipboardWrite = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: clipboardWrite },
      configurable: true,
    })
    class MockClipboardItem {
      constructor(
        public items: Record<string, Blob>,
        public options?: unknown,
      ) {}
    }
    vi.stubGlobal('ClipboardItem', MockClipboardItem)
    execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
  })

  afterEach(() => {
    mockedHasBridge.mockReset()
    mockedInvoke.mockReset()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(document, 'execCommand')
    document.body.innerHTML = ''
  })

  it('uses the bridge when present and records the payload', async () => {
    mockedHasBridge.mockReturnValue(true)
    mockedInvoke.mockResolvedValue(undefined)
    await expect(writeClipboard({ html: '<b>x</b>', text: 'x' })).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('copyContent', { html: '<b>x</b>', text: 'x' })
    expect(clipboardWrite).not.toHaveBeenCalled()
  })

  it('falls back to the web clipboard when the bridge call fails', async () => {
    mockedHasBridge.mockReturnValue(true)
    mockedInvoke.mockRejectedValue(new Error('boom'))
    await expect(writeClipboard({ html: '<b>x</b>', text: 'x' })).resolves.toBe(true)
    expect(clipboardWrite).toHaveBeenCalledOnce()
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('writes html and text blobs via navigator.clipboard when there is no bridge', async () => {
    mockedHasBridge.mockReturnValue(false)
    await expect(writeClipboard({ html: '<b>x</b>', text: 'x' })).resolves.toBe(true)
    expect(clipboardWrite).toHaveBeenCalledOnce()
    const [item] = clipboardWrite.mock.calls[0][0]
    const htmlBlob = item.items['text/html'] as Blob
    const textBlob = item.items['text/plain'] as Blob
    expect(htmlBlob).toBeInstanceOf(Blob)
    expect(htmlBlob.type).toBe('text/html')
    expect(htmlBlob.size).toBe('<b>x</b>'.length)
    expect(textBlob.type).toBe('text/plain')
    expect(textBlob.size).toBe(1)
  })

  it('falls back to execCommand when web clipboard write throws', async () => {
    mockedHasBridge.mockReturnValue(false)
    clipboardWrite.mockRejectedValue(new Error('denied'))
    await expect(writeClipboard({ html: '<b>x</b>', text: 'x' })).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledOnce()
  })

  it('falls back to execCommand when clipboard API is unavailable', async () => {
    mockedHasBridge.mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await expect(writeClipboard({ html: '<b>x</b>', text: 'x' })).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledOnce()
  })

  it('copies the plain text via a temporary textarea', async () => {
    mockedHasBridge.mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    let created: HTMLTextAreaElement | undefined
    const origCreate = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag)
      if (tag.toLowerCase() === 'textarea') created = el as HTMLTextAreaElement
      return el
    })
    await writeClipboard({ html: '', text: 'plain' })
    expect(created?.value).toBe('plain')
    expect(document.body.querySelector('textarea')).toBeNull()
    expect(spy).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('copy')
    spy.mockRestore()
  })

  it('propagates a failed execCommand as false', async () => {
    mockedHasBridge.mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execCommand.mockReturnValue(false)
    await expect(writeClipboard({ html: '', text: 'x' })).resolves.toBe(false)
  })
})
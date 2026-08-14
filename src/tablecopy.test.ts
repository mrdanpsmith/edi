import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  attachTableCopyControls,
  copyTable,
  previewExportBody,
  tableClipboardPayload,
} from './tablecopy'

const bridgeState = vi.hoisted(() => ({
  hasBridge: vi.fn(() => true),
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./bridge', () => ({
  hasBridge: () => bridgeState.hasBridge(),
  invoke: bridgeState.invoke,
}))

function previewContainer(inner: string): HTMLElement {
  const container = document.createElement('div')
  container.className = 'md-preview'
  container.innerHTML = inner
  return container
}

function tableOf(inner: string): HTMLTableElement {
  return previewContainer(`<table>${inner}</table>`).querySelector('table')!
}

function stubClipboardWrite(write: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { write },
    configurable: true,
  })
  globalThis.ClipboardItem = class {
    init: Record<string, Blob>
    constructor(init: Record<string, Blob>) {
      this.init = init
    }
  } as unknown as typeof ClipboardItem
}

function clearClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  })
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem
}

function stubExecCommand(returns: boolean): ReturnType<typeof vi.fn> {
  document.execCommand = vi.fn().mockReturnValue(returns) as unknown as typeof document.execCommand
  return document.execCommand as unknown as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.restoreAllMocks()
  bridgeState.hasBridge.mockReturnValue(true)
  bridgeState.invoke.mockReset()
  bridgeState.invoke.mockResolvedValue(undefined)
})

describe('tableClipboardPayload', () => {
  it('uses the table outerHTML as html payload', () => {
    const container = previewContainer(
      '<table><tr><th>A</th></tr><tr><td>1</td></tr></table>',
    )
    const table = container.querySelector('table')!
    const payload = tableClipboardPayload(table)
    expect(payload.html.startsWith('<table>')).toBe(true)
    expect(payload.html.endsWith('</table>')).toBe(true)
    expect(payload.html).toContain('<th>A</th>')
    expect(payload.html).toContain('<td>1</td>')
  })

  it('produces tab-separated rows with CRLF line endings', () => {
    const container = previewContainer(
      '<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>',
    )
    expect(tableClipboardPayload(container.querySelector('table')!).plain).toBe('a\tb\r\n1\t2')
  })

  it('ignores non-cell children and trims cell text', () => {
    const container = previewContainer('<table><tr><td>  a  </td></tr></table>')
    expect(tableClipboardPayload(container.querySelector('table')!).plain).toBe('a')
  })
})

describe('copyTable', () => {
  it('copies through the native bridge', async () => {
    bridgeState.invoke.mockResolvedValue(undefined)
    await expect(copyTable(tableOf('<tr><td>1</td></tr>'))).resolves.toBe(true)
    expect(bridgeState.invoke).toHaveBeenCalledWith(
      'copyTable',
      expect.objectContaining({ plain: '1' }),
    )
  })

  it('falls back to the web clipboard when the bridge call fails', async () => {
    bridgeState.invoke.mockRejectedValue(new Error('nope'))
    const write = vi.fn().mockResolvedValue(undefined)
    stubClipboardWrite(write)

    await expect(copyTable(tableOf('<tr><td>1</td></tr>'))).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    const [items] = write.mock.calls[0] as [unknown[]]
    expect(items).toHaveLength(1)
  })

  it('uses the web clipboard when there is no native bridge', async () => {
    bridgeState.hasBridge.mockReturnValue(false)
    const write = vi.fn().mockResolvedValue(undefined)
    stubClipboardWrite(write)

    await expect(copyTable(tableOf('<tr><td>1</td></tr>'))).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(bridgeState.invoke).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the web clipboard is unavailable', async () => {
    bridgeState.hasBridge.mockReturnValue(false)
    clearClipboard()
    const execCommand = stubExecCommand(true)

    await expect(copyTable(tableOf('<tr><td>1</td></tr>'))).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to execCommand when the web clipboard write fails', async () => {
    bridgeState.hasBridge.mockReturnValue(false)
    stubClipboardWrite(vi.fn().mockRejectedValue(new Error('denied')))
    const execCommand = stubExecCommand(true)

    await expect(copyTable(tableOf('<tr><td>1</td></tr>'))).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('reports failure when every copy path fails', async () => {
    bridgeState.hasBridge.mockReturnValue(false)
    clearClipboard()
    stubExecCommand(false)

    await expect(copyTable(tableOf('<tr><td>1</td></tr>'))).resolves.toBe(false)
  })
})

describe('attachTableCopyControls', () => {
  it('wraps each table with a copy button', () => {
    const container = previewContainer(
      '<table><tr><td>1</td></tr></table><table><tr><td>2</td></tr></table>',
    )
    attachTableCopyControls(container, { onCopied: () => undefined })
    expect(container.querySelectorAll('.table-copy-wrap')).toHaveLength(2)
    expect(container.querySelectorAll('.table-copy-btn')).toHaveLength(2)
  })

  it('does not double-wrap tables', () => {
    const container = previewContainer('<table><tr><td>1</td></tr></table>')
    attachTableCopyControls(container, { onCopied: () => undefined })
    attachTableCopyControls(container, { onCopied: () => undefined })
    expect(container.querySelectorAll('.table-copy-wrap')).toHaveLength(1)
  })

  it('reports a copy success through the callback', async () => {
    const container = previewContainer('<table><tr><td>1</td></tr></table>')
    const onCopied = vi.fn()
    attachTableCopyControls(container, { onCopied })
    const button = container.querySelector<HTMLButtonElement>('.table-copy-btn')!
    button.click()
    await vi.waitFor(() => expect(onCopied).toHaveBeenCalled())
  })

  it('skips the callback when copying fails', async () => {
    bridgeState.hasBridge.mockReturnValue(false)
    clearClipboard()
    stubExecCommand(false)

    const container = previewContainer('<table><tr><td>1</td></tr></table>')
    const onCopied = vi.fn()
    attachTableCopyControls(container, { onCopied })
    container.querySelector<HTMLButtonElement>('.table-copy-btn')!.click()
    await vi.waitFor(() => expect(bridgeState.hasBridge).toHaveBeenCalled())
    expect(onCopied).not.toHaveBeenCalled()
  })
})

describe('previewExportBody', () => {
  it('unwraps copy wrappers for export', () => {
    const container = previewContainer(
      '<div class="table-copy-wrap"><button class="table-copy-btn">Copy</button><table><tr><td>1</td></tr></table></div>',
    )
    const body = previewExportBody(container)
    expect(body).not.toContain('table-copy-wrap')
    expect(body).not.toContain('table-copy-btn')
    expect(body).toContain('<table>')
    expect(body).toContain('<td>1</td>')
  })

  it('drops copy wrappers that contain no table', () => {
    const container = previewContainer(
      '<div class="table-copy-wrap"><button class="table-copy-btn">Copy</button></div>',
    )
    const body = previewExportBody(container)
    expect(body).not.toContain('table-copy-wrap')
    expect(body).not.toContain('table-copy-btn')
  })

  it('keeps non-table preview markup', () => {
    const container = previewContainer('<p>hi</p><h1>Title</h1>')
    expect(previewExportBody(container)).toContain('<p>hi</p>')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { attachTableCopyControls, previewExportBody, tableClipboardPayload } from './tablecopy'

vi.mock('./bridge', () => ({
  hasBridge: () => true,
  invoke: vi.fn().mockResolvedValue(undefined),
}))

function previewContainer(inner: string): HTMLElement {
  const container = document.createElement('div')
  container.className = 'md-preview'
  container.innerHTML = inner
  return container
}

beforeEach(() => {
  vi.restoreAllMocks()
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

  it('keeps non-table preview markup', () => {
    const container = previewContainer('<p>hi</p><h1>Title</h1>')
    expect(previewExportBody(container)).toContain('<p>hi</p>')
  })
})

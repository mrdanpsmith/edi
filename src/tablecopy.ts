import { hasBridge, invoke } from './bridge'

export interface TableClipboardPayload {
  html: string
  plain: string
}

export interface TableCopyCallbacks {
  onCopied(): void
}

export function attachTableCopyControls(container: HTMLElement, callbacks: TableCopyCallbacks): void {
  for (const table of Array.from(container.querySelectorAll<HTMLTableElement>('.md-preview table'))) {
    if (table.parentElement?.classList.contains('table-copy-wrap')) {
      continue
    }
    const wrap = document.createElement('div')
    wrap.className = 'table-copy-wrap'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'table-copy-btn'
    button.textContent = 'Copy'
    button.addEventListener('click', () => {
      void copyTable(table).then((ok) => {
        if (ok) {
          callbacks.onCopied()
        }
      })
    })

    table.parentElement?.replaceChild(wrap, table)
    wrap.append(button, table)
  }
}

export function tableClipboardPayload(table: HTMLTableElement): TableClipboardPayload {
  return {
    html: table.outerHTML,
    plain: tableToTsv(table),
  }
}

function tableToTsv(table: HTMLTableElement): string {
  const rows: string[][] = []
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).filter(
      (child): child is HTMLTableCellElement =>
        child.tagName === 'TD' || child.tagName === 'TH',
    )
    rows.push(
      cells.map((cell) => (cell.textContent ?? '').trim().replace(/\s*\n\s*/g, ' ')),
    )
  }
  return rows.map((row) => row.join('\t')).join('\r\n')
}

export async function copyTable(table: HTMLTableElement): Promise<boolean> {
  const payload = tableClipboardPayload(table)
  if (hasBridge()) {
    try {
      await invoke('copyTable', payload)
      return true
    } catch {
      return webClipboardCopy(payload)
    }
  }
  return webClipboardCopy(payload)
}

async function webClipboardCopy(payload: TableClipboardPayload): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.write === 'function') {
      const item = new ClipboardItem({
        'text/html': new Blob([payload.html], { type: 'text/html' }),
        'text/plain': new Blob([payload.plain], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return true
    }
  } catch {
    // Fall through to the text-only fallback.
  }
  return execCommandCopy(payload.plain)
}

function execCommandCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}

export function previewExportBody(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  for (const wrap of Array.from(clone.querySelectorAll<HTMLElement>('.table-copy-wrap'))) {
    const table = wrap.querySelector('table')
    if (table) {
      wrap.replaceWith(table)
    } else {
      wrap.remove()
    }
  }
  return clone.innerHTML
}

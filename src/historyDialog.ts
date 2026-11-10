import { diffLines } from 'diff'
import type { HistoryVersion } from './files'

/** Runs of unchanged lines longer than this are folded to a count. */
const CONTEXT = 3

export interface HistoryDialogOptions {
  /** The document's file name, for the title. */
  name: string
  /** The markdown in the editor now, which every version is compared with. */
  current: string
  list: () => Promise<HistoryVersion[]>
  read: (id: string) => Promise<string>
  /**
   * Forget the document's saved versions, after the caller has asked. Resolves
   * whether it did; the dialog then shows the (fresh) history again.
   */
  clear?: () => Promise<boolean>
}

/**
 * The Version History dialog: the document's saved versions on the left, and on
 * the right the one selected, as a diff from the document as it is now.
 * Resolves with the selected version's markdown when the reader restores it, or
 * `null` when they close the dialog.
 *
 * The dialog only reads; restoring is the caller's edit to make.
 */
export function openHistoryDialog(options: HistoryDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'edi-dialog-overlay'

    const box = document.createElement('div')
    box.className = 'edi-dialog edi-history-dialog'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.tabIndex = -1

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = `Version History — ${options.name}`

    const body = document.createElement('div')
    body.className = 'edi-history-body'

    const list = document.createElement('div')
    list.className = 'edi-history-list'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Saved versions')

    const diff = document.createElement('div')
    diff.className = 'edi-history-diff'
    diff.setAttribute('aria-live', 'polite')

    body.append(list, diff)

    const note = document.createElement('div')
    note.className = 'edi-dialog-note'
    note.textContent =
      'Compared with the document now: green lines are in this version, red lines are not. Restore makes exactly this change.'

    const actions = document.createElement('div')
    actions.className = 'edi-dialog-actions'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'toolbar-btn'
    close.textContent = 'Close'
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'toolbar-btn toolbar-primary'
    restore.textContent = 'Restore'
    restore.disabled = true
    if (options.clear) {
      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'toolbar-btn edi-history-clear'
      clear.textContent = 'Clear History…'
      clear.addEventListener('click', () => {
        void options.clear!().then((cleared) => {
          if (cleared) load()
        })
      })
      actions.append(clear)
    }
    actions.append(close, restore)

    box.append(title, body, note, actions)
    overlay.append(box)
    document.body.append(overlay)
    box.focus()

    let selected: { id: string; text: string } | null = null
    // Only the last click's answer may land: reads are asynchronous.
    let request = 0

    const settle = (value: string | null): void => {
      overlay.remove()
      resolve(value)
    }

    const show = (message: string): void => {
      diff.replaceChildren()
      const line = document.createElement('div')
      line.className = 'edi-history-empty'
      line.textContent = message
      diff.append(line)
    }

    const select = async (version: HistoryVersion, item: HTMLElement): Promise<void> => {
      for (const other of list.children) other.setAttribute('aria-selected', 'false')
      item.setAttribute('aria-selected', 'true')
      selected = null
      restore.disabled = true
      const mine = ++request
      show('Loading…')
      try {
        const text = await options.read(version.id)
        if (mine !== request) return
        selected = { id: version.id, text }
        restore.disabled = text === options.current
        // From the document now to the version: the view is about the version
        // selected, so what it holds reads as added, and it is exactly the
        // change Restore would make.
        renderDiff(diff, options.current, text)
      } catch (error) {
        if (mine !== request) return
        show(`Could not read this version: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    close.addEventListener('click', () => settle(null))
    restore.addEventListener('click', () => {
      if (selected) settle(selected.text)
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) settle(null)
    })
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        settle(null)
      }
    })

    const load = (): void => {
      selected = null
      restore.disabled = true
      request++
      list.replaceChildren()
      show('Loading…')
      options.list().then(
        (versions) => listVersions(versions),
        (error: unknown) => {
          show(`Could not read the history: ${error instanceof Error ? error.message : String(error)}`)
        },
      )
    }

    const listVersions = (versions: HistoryVersion[]): void => {
      if (versions.length === 0) {
        show('No saved versions yet. Each save of this document records one.')
        return
      }
      for (const version of versions) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'edi-history-item'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', 'false')
        const when = document.createElement('span')
        when.className = 'edi-history-time'
        when.textContent = new Date(version.time * 1000).toLocaleString()
        const what = document.createElement('span')
        what.className = 'edi-history-message'
        what.textContent = version.message
        item.append(when, what)
        item.addEventListener('click', () => void select(version, item))
        list.append(item)
      }
      void select(versions[0]!, list.firstElementChild as HTMLElement)
    }

    load()
  })
}

/** A line diff from `before` to `after`: `after`'s own lines are the added ones. */
export function renderDiff(target: HTMLElement, before: string, after: string): void {
  target.replaceChildren()
  if (before === after) {
    const same = document.createElement('div')
    same.className = 'edi-history-empty'
    same.textContent = 'This version is the same as the document now.'
    target.append(same)
    return
  }
  const parts = diffLines(before, after)
  parts.forEach((part, index) => {
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (!part.added && !part.removed) {
      const first = index === 0
      const last = index === parts.length - 1
      // Keep a little context either side of a change; fold the rest.
      const head = first ? 0 : CONTEXT
      const tail = last ? 0 : CONTEXT
      if (lines.length > head + tail + 1) {
        appendLines(target, lines.slice(0, head), 'same')
        const fold = document.createElement('div')
        fold.className = 'edi-history-fold'
        fold.textContent = `… ${lines.length - head - tail} unchanged lines`
        target.append(fold)
        appendLines(target, lines.slice(lines.length - tail), 'same')
        return
      }
      appendLines(target, lines, 'same')
      return
    }
    appendLines(target, lines, part.added ? 'added' : 'removed')
  })
}

function appendLines(target: HTMLElement, lines: string[], kind: 'same' | 'added' | 'removed'): void {
  const sign = kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '
  for (const text of lines) {
    const line = document.createElement('div')
    line.className = `edi-history-line edi-history-${kind}`
    line.textContent = `${sign} ${text}`
    target.append(line)
  }
}

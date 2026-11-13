import { diffLines } from 'diff'
import type { HistoryList, HistoryVersion } from './files'

/** Runs of unchanged lines longer than this are folded to a count. */
const CONTEXT = 3

export interface HistoryDialogOptions {
  /** The document's file name, for the title. */
  name: string
  /** The markdown in the editor now, which every version is compared with. */
  current: string
  list: () => Promise<HistoryList>
  read: (version: HistoryVersion) => Promise<string>
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
      for (const other of list.querySelectorAll('.edi-history-item')) other.setAttribute('aria-selected', 'false')
      item.setAttribute('aria-selected', 'true')
      selected = null
      restore.disabled = true
      const mine = ++request
      show('Loading…')
      try {
        const text = await options.read(version)
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
        (history) => listVersions(history),
        (error: unknown) => {
          show(`Could not read the history: ${error instanceof Error ? error.message : String(error)}`)
        },
      )
    }

    const listVersions = (history: HistoryList): void => {
      const { versions } = history
      if (versions.length === 0) {
        show(
          history.git && !history.git.complete
            ? `No versions yet, and no commit of this file in the most recent ${history.git.walked.toLocaleString()} commits searched.`
            : 'No saved versions yet. Each save of this document records one.',
        )
        return
      }
      const itemFor = (version: HistoryVersion): HTMLButtonElement => {
        const item = versionItem(version)
        item.addEventListener('click', () => void select(version, item))
        return item
      }
      renderVersionList(list, versions, itemFor)
      if (history.git && !history.git.complete) {
        const more = document.createElement('div')
        more.className = 'edi-history-heading edi-history-searched'
        more.textContent = `Searched the most recent ${history.git.walked.toLocaleString()} commits`
        list.append(more)
      }
      const first = list.querySelector<HTMLButtonElement>('.edi-history-item')!
      void select(versions[0]!, first)
    }

    load()
  })
}

/** One version in the list: when, what, and for a commit its id and author. */
function versionItem(version: HistoryVersion): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = version.source === 'git' ? 'edi-history-item edi-history-commit' : 'edi-history-item'
  item.setAttribute('role', 'option')
  item.setAttribute('aria-selected', 'false')
  const when = document.createElement('span')
  when.className = 'edi-history-time'
  when.textContent = new Date(version.time * 1000).toLocaleString()
  const what = document.createElement('span')
  what.className = 'edi-history-message'
  what.textContent = version.message
  item.append(when, what)
  if (version.source === 'git') {
    const who = document.createElement('span')
    who.className = 'edi-history-commit-id'
    who.textContent = [version.short, version.author].filter(Boolean).join(' · ')
    item.append(who)
  }
  return item
}

function heading(text: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'edi-history-heading'
  row.textContent = text
  return row
}

/**
 * Lay out a document's versions, newest first. A document without git history
 * is a plain list. With commits, Edi's versions are grouped by where they fall:
 * those not yet committed under "Not committed", those between two commits
 * folded into one row that opens them, and those from before the file's first
 * commit under "Before git".
 */
export function renderVersionList(
  list: HTMLElement,
  versions: HistoryVersion[],
  itemFor: (version: HistoryVersion) => HTMLElement,
): void {
  let section: string | undefined
  let fold: { toggle: HTMLButtonElement; rows: HTMLElement; count: number } | null = null
  const closeFold = (): void => {
    if (!fold) return
    const { toggle, count } = fold
    toggle.textContent = `${count} Edi snapshot${count === 1 ? '' : 's'}`
    fold = null
  }
  for (const version of versions) {
    const where = version.source === 'git' ? 'git' : version.section
    if (where !== 'between') closeFold()
    if (where !== section) {
      if (where === 'uncommitted') list.append(heading('Not committed'))
      if (where === 'beforeGit') list.append(heading('Before git'))
      section = where
    }
    if (where === 'between') {
      if (!fold) {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'edi-history-fold-toggle'
        toggle.setAttribute('aria-expanded', 'false')
        const rows = document.createElement('div')
        rows.className = 'edi-history-folded'
        rows.hidden = true
        toggle.addEventListener('click', () => {
          rows.hidden = !rows.hidden
          toggle.setAttribute('aria-expanded', String(!rows.hidden))
        })
        list.append(toggle, rows)
        fold = { toggle, rows, count: 0 }
      }
      fold.rows.append(itemFor(version))
      fold.count++
      continue
    }
    list.append(itemFor(version))
  }
  closeFold()
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

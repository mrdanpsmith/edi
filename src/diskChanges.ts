import { readTextFile } from './files'
import { fileTextForDisplay, fileTextToMarkdown } from './documentFormat'
import { renderDiff } from './historyDialog'
import {
  describeDiskNote,
  findSessionByPath,
  getActive,
  setActiveDirty,
  setDiskNote,
  subscribe,
} from './state'
import type { AppContext } from './appContext'

/**
 * Documents changed on disk by something other than Edi — usually an agent
 * writing the file the reader has open. See `docs/disk-changes.md`.
 *
 * The backend watches every document Edi has read or written and pushes a
 * `diskChanged` or `diskDeleted` event when the file stops being what Edi last
 * saw (`backend/watcher.py`). It also refuses a save over such a change
 * (`changedOnDisk`), so nothing here is the only thing standing between an
 * agent's edit and the reader's next Ctrl+S.
 *
 * - A tab with **no unsaved edits** just takes the new text, as one undoable
 *   edit, and the status bar says so.
 * - A tab **with** unsaved edits shows a bar: *Compare…*, *Take theirs*, *Keep
 *   mine*. Compare shows the two sides' changes separately, each against the
 *   base: the text Edi last read or wrote.
 *
 * Reading the file is what tells the backend the reader has now seen it, so a
 * choice made here never needs a separate "overwrite anyway".
 *
 * Either way the tab gets a **marker** (a badge on the tab, and a note in the
 * status bar while it is in view) saying the file changed on disk and when. It
 * asks nothing. It clears when the reader is evidently done with it: an edit or
 * a save, opening Version History, any choice on the bar, or a click on the
 * marker itself.
 */
export interface DiskController {
  /** `text` is now the file at `path` as Edi read or wrote it: the base. */
  noteDiskText(path: string, text: string): void
  /** The document moved from `oldPath` to `newPath` (an Edi rename). */
  renamed(oldPath: string, newPath: string): void
  /** A `diskChanged` / `diskDeleted` event from the shell. */
  onEvent(type: 'diskChanged' | 'diskDeleted', path: string): void
  /** A save of `path` was refused because the file changed on disk. */
  saveRefused(path: string): void
  /** The tab in view changed, or its state did: show or act on what is pending. */
  refresh(): void
  /** The reader edited the document in view: its marker has done its job. */
  edited(): void
  /** Clear the marker of the document at `path`. */
  dismiss(path: string): void
  destroy(): void
}

type Pending = 'changed' | 'deleted' | null

interface Entry {
  base: string | null
  pending: Pending
}

export function createDiskController(ctx: AppContext): DiskController {
  const entries = new Map<string, Entry>()
  let bar: HTMLElement | null = null
  // Set while this controller itself rewrites the document, so that edit is
  // not taken for the reader's and does not clear the marker it just earned.
  let applying = false

  function mark(path: string, kind: 'changed' | 'deleted'): void {
    const session = findSessionByPath(path)
    if (!session) return
    const count = session.diskNote ? session.diskNote.count + 1 : 1
    setDiskNote(session.id, { kind, at: Date.now(), count })
  }

  function dismiss(path: string): void {
    const session = findSessionByPath(path)
    if (session) setDiskNote(session.id, null)
  }

  // The status-bar half of the marker: the tab in view's note, while it has one.
  const statusNote = document.createElement('button')
  statusNote.type = 'button'
  statusNote.className = 'status-disk'
  statusNote.hidden = true
  statusNote.title = 'Click to dismiss'
  statusNote.addEventListener('click', () => {
    const path = getActive()?.path
    if (path) dismiss(path)
  })
  ctx.roots.statusLeft?.after(statusNote)
  const renderStatusNote = (): void => {
    const note = getActive()?.diskNote ?? null
    statusNote.hidden = note === null
    statusNote.textContent = note ? describeDiskNote(note) : ''
  }
  const unsubscribe = subscribe(renderStatusNote)

  const entry = (path: string): Entry => {
    let found = entries.get(path)
    if (!found) {
      found = { base: null, pending: null }
      entries.set(path, found)
    }
    return found
  }

  const nameOf = (path: string): string => path.split('/').pop() ?? path

  function hideBar(): void {
    bar?.remove()
    bar = null
  }

  function showBar(path: string, pending: Exclude<Pending, null>): void {
    hideBar()
    bar = document.createElement('div')
    bar.className = 'edi-disk-bar'
    bar.setAttribute('role', 'status')
    const message = document.createElement('span')
    message.className = 'edi-disk-bar-message'
    const actions = document.createElement('span')
    actions.className = 'edi-disk-bar-actions'
    const button = (label: string, onClick: () => void, primary = false): void => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = primary ? 'toolbar-btn toolbar-primary' : 'toolbar-btn'
      element.textContent = label
      element.addEventListener('click', onClick)
      actions.append(element)
    }
    if (pending === 'changed') {
      message.textContent = `${nameOf(path)} was changed on disk while you were editing it.`
      button('Compare…', () => void compare(path), true)
      button('Take theirs', () => void takeTheirs(path))
      button('Keep mine', () => void keepMine(path))
    } else {
      message.textContent = `${nameOf(path)} was deleted or moved on disk. Saving will write it again.`
      button('Dismiss', () => {
        entry(path).pending = null
        hideBar()
      })
    }
    bar.append(message, actions)
    const container = ctx.roots.editorContainer
    container.parentElement?.insertBefore(bar, container)
  }

  /** Read the file as it is now — which also tells the shell it has been seen. */
  async function readTheirs(path: string): Promise<string | null> {
    try {
      return await readTextFile(path)
    } catch {
      // Gone between the event and the read.
      entry(path).pending = 'deleted'
      refresh()
      return null
    }
  }

  /** Put the file text `text` in the editor of the tab in view, as the saved document. */
  async function applyToActive(path: string, text: string): Promise<boolean> {
    const session = getActive()
    if (session?.path !== path || !ctx.blockEditor) return false
    await ctx.blockEditor.flushReveals()
    if (getActive()?.id !== session.id) return false
    applying = true
    try {
      const markdown = fileTextToMarkdown(path, text)
      if (ctx.blockEditor.getMarkdown() !== markdown) ctx.blockEditor.replaceMarkdown(markdown)
      ctx.blockEditor.markSavedPoint(ctx.blockEditor.getView().state.doc)
      setActiveDirty(false)
    } finally {
      applying = false
    }
    ctx.updateTitle()
    ctx.syncDirty()
    return true
  }

  function settled(path: string, text: string): void {
    const found = entry(path)
    found.base = text
    found.pending = null
    if (getActive()?.path === path) hideBar()
  }

  /** A tab with nothing unsaved simply follows the file. */
  async function reload(path: string): Promise<void> {
    const text = await readTheirs(path)
    if (text === null) return
    const before = entry(path).base
    if (await applyToActive(path, text)) {
      settled(path, text)
      if (before !== null && before !== text) ctx.flashStatus(`Reloaded ${nameOf(path)}: changed on disk`)
    }
    // Otherwise the tab left the view mid-read: it stays pending, and is
    // reloaded when it is next shown.
  }

  async function takeTheirs(path: string, known?: string): Promise<void> {
    dismiss(path)
    const text = known ?? (await readTheirs(path))
    if (text === null) return
    if (await applyToActive(path, text)) {
      settled(path, text)
      ctx.flashStatus(`Took the version on disk — Undo brings yours back`)
    }
  }

  async function keepMine(path: string, known?: string): Promise<void> {
    dismiss(path)
    const text = known ?? (await readTheirs(path))
    if (text === null) return
    settled(path, text)
    ctx.flashStatus(`Kept your version — saving will replace the one on disk`)
  }

  async function compare(path: string): Promise<void> {
    dismiss(path)
    const theirs = await readTheirs(path)
    if (theirs === null || !ctx.blockEditor) return
    await ctx.blockEditor.flushReveals()
    const choice = await openCompareDialog({
      name: nameOf(path),
      base: entry(path).base,
      // The base and theirs are file text; compare like with like.
      mine: fileTextForDisplay(path, ctx.blockEditor.getMarkdown()),
      theirs,
    })
    if (choice === 'theirs') await takeTheirs(path, theirs)
    else if (choice === 'mine') await keepMine(path, theirs)
  }

  function refresh(): void {
    const session = getActive()
    const path = session?.path
    const found = path ? entries.get(path) : undefined
    if (!session || !path || !found?.pending) {
      hideBar()
      return
    }
    if (found.pending === 'changed' && !session.dirty) {
      hideBar()
      void reload(path)
      return
    }
    showBar(path, found.pending)
  }

  return {
    noteDiskText(path, text) {
      // Read or written by Edi just now (open, save, revert): nothing pending.
      settled(path, text)
      dismiss(path)
    },
    renamed(oldPath, newPath) {
      const found = entries.get(oldPath)
      entries.delete(oldPath)
      if (found) entries.set(newPath, found)
    },
    onEvent(type, path) {
      const kind = type === 'diskDeleted' ? 'deleted' : 'changed'
      entry(path).pending = kind
      mark(path, kind)
      if (getActive()?.path === path) refresh()
    },
    saveRefused(path) {
      entry(path).pending = 'changed'
      // Usually the watcher has marked it already; this covers a missed event.
      if (!findSessionByPath(path)?.diskNote) mark(path, 'changed')
      refresh()
      ctx.flashStatus(`Not saved: ${nameOf(path)} changed on disk`)
    },
    refresh,
    edited() {
      if (applying) return
      const session = getActive()
      if (session?.diskNote) setDiskNote(session.id, null)
    },
    dismiss,
    destroy() {
      unsubscribe()
      statusNote.remove()
      hideBar()
    },
  }
}

export type CompareChoice = 'mine' | 'theirs' | null

/**
 * Both sides of a conflict, each as a diff from the base: what the other writer
 * changed, and what the reader changed. Without a base (a document Edi never
 * read itself) it is one diff, from the reader's text to the disk's.
 */
export function openCompareDialog(options: {
  name: string
  base: string | null
  mine: string
  theirs: string
}): Promise<CompareChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'edi-dialog-overlay'
    const box = document.createElement('div')
    box.className = 'edi-dialog edi-history-dialog edi-compare-dialog'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.tabIndex = -1

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = `Changed on disk while you were editing — ${options.name}`

    const panes = document.createElement('div')
    panes.className = 'edi-compare-panes'
    const pane = (heading: string, before: string, after: string, kind: string): void => {
      const section = document.createElement('section')
      section.className = `edi-compare-pane edi-compare-${kind}`
      const label = document.createElement('div')
      label.className = 'edi-dialog-label'
      label.textContent = heading
      const diff = document.createElement('div')
      diff.className = 'edi-history-diff'
      renderDiff(diff, before, after)
      section.append(label, diff)
      panes.append(section)
    }
    if (options.base !== null) {
      pane('Their changes (on disk, since you opened it)', options.base, options.theirs, 'theirs')
      pane('Your unsaved changes', options.base, options.mine, 'mine')
    } else {
      pane('The version on disk, compared with yours', options.mine, options.theirs, 'theirs')
    }

    const actions = document.createElement('div')
    actions.className = 'edi-dialog-actions'
    const settle = (choice: CompareChoice): void => {
      overlay.remove()
      resolve(choice)
    }
    const button = (label: string, choice: CompareChoice, tone = ''): void => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = `toolbar-btn ${tone}`.trim()
      element.textContent = label
      element.addEventListener('click', () => settle(choice))
      actions.append(element)
    }
    button('Close', null)
    button('Take theirs', 'theirs')
    button('Keep mine', 'mine', 'toolbar-primary')

    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        settle(null)
      }
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) settle(null)
    })

    box.append(title, panes, actions)
    overlay.append(box)
    document.body.append(overlay)
    box.focus()
  })
}

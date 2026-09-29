export interface LinkPrompt {
  text: string
  url: string
}

/** How a dialog's Enter key behaves, which is the one key it cannot share. */
type EnterKey = 'confirm' | 'ctrl'

/**
 * The modal every dialog in this file is: an overlay, a titled box, `Cancel` and
 * one confirming action, and the two ways out that are not a button — Escape
 * anywhere in the box, and a click on the backdrop. Both resolve `cancelValue`, so
 * dismissing a dialog is never the answer that acts.
 *
 * `build` fills the box between the title and the actions and returns what
 * confirming means; that is the only part each dialog has to write itself. It may
 * return ``undefined`` to refuse, which leaves the dialog open and untouched — a
 * board with no columns is a report, not an answer. Everything else, including the
 * exact buttons, the DOM order and the dismissal keys, is the same in all three.
 */
function openDialogShell<T>(
  options: {
    title: string
    confirm: string
    tone: string
    cancelValue: T
    enter: EnterKey
    build: (box: HTMLDivElement) => () => T | undefined
    onSettle: (value: T) => void
  },
): { box: HTMLDivElement; confirmButton: HTMLButtonElement; accept: () => T | undefined } {
  const overlay = document.createElement('div')
  overlay.className = 'edi-dialog-overlay'

  const box = document.createElement('div')
  box.className = 'edi-dialog'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')

  const title = document.createElement('div')
  title.className = 'edi-dialog-title'
  title.textContent = options.title
  box.append(title)

  const accept = options.build(box)

  const actions = document.createElement('div')
  actions.className = 'edi-dialog-actions'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'toolbar-btn'
  cancel.textContent = 'Cancel'
  actions.append(cancel)

  const confirmButton = document.createElement('button')
  confirmButton.type = 'button'
  confirmButton.className = `toolbar-btn ${options.tone}`
  confirmButton.textContent = options.confirm
  actions.append(confirmButton)

  box.append(actions)
  overlay.append(box)
  document.body.append(overlay)

  const settle = (value: T | undefined): void => {
    if (value === undefined) return
    overlay.remove()
    options.onSettle(value)
  }

  cancel.addEventListener('click', () => settle(options.cancelValue))
  confirmButton.addEventListener('click', () => settle(accept()))
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      settle(options.cancelValue)
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      // A focused button answers Enter itself; the field around it does not, and
      // a board dialog is a textarea, where Enter is a newline and Ctrl+Enter
      // is the board.
      if (options.enter === 'confirm' || event.ctrlKey || event.metaKey) {
        event.preventDefault()
        settle(accept())
      }
    }
  })
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      settle(options.cancelValue)
    }
  })
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) settle(options.cancelValue)
  })

  return { box, confirmButton, accept }
}

/**
 * A small centered modal dialog prompting for a link's URL and, when nothing is
 * selected to provide the link text, an optional link text defaulted to the
 * URL. Used by the toolbar's Hyperlink button for both the document
 * and spreadsheet cells (the cell flow captures its text selection on mousedown
 * so the dialog's focus change does not discard it).
 *
 * `existingText` is the text the link will cover ('' means none — the dialog
 * then asks for link text). Resolves with the entered text/url pair (``text``
 * is '' when the field was hidden), or ``null`` if the user cancels.
 *
 * `editing` is the one caller that is changing a link that is already there —
 * the context menu's "Edit link…" — so the title and the confirming button say
 * so. The label's wording is not editable either way: it is the document's
 * text, and retyping it is what the caret in it is for.
 */
export function promptForLink(
  existingText: string,
  existingUrl: string,
  options: { editing?: boolean } = {},
): Promise<LinkPrompt | null> {
  return new Promise((resolve) => {
    let urlInput!: HTMLInputElement
    openDialogShell<LinkPrompt | null>({
      title: options.editing ? 'Edit link' : 'Insert link',
      confirm: options.editing ? 'Update' : 'Insert',
      tone: 'toolbar-primary',
      cancelValue: null,
      enter: 'confirm',
      onSettle: resolve,
      build: (box) => {
        const urlLabel = document.createElement('label')
        urlLabel.className = 'edi-dialog-label'
        urlLabel.textContent = 'URL'
        box.append(urlLabel)

        urlInput = document.createElement('input')
        urlInput.className = 'edi-dialog-input'
        urlInput.type = 'url'
        urlInput.placeholder = 'https://'
        urlInput.value = existingUrl
        box.append(urlInput)

        let textInput: HTMLInputElement | null = null
        if (!existingText) {
          const textLabel = document.createElement('label')
          textLabel.className = 'edi-dialog-label'
          textLabel.textContent = 'Link text'
          box.append(textLabel)

          textInput = document.createElement('input')
          textInput.className = 'edi-dialog-input'
          textInput.type = 'text'
          textInput.placeholder = 'https://'
          textInput.value = existingUrl
          box.append(textInput)
        }

        return (): LinkPrompt => ({ text: textInput ? textInput.value : '', url: urlInput.value })
      },
    })

    urlInput.focus()
    urlInput.select()
  })
}

/**
 * Ask before removing a card or a column from a kanban board, and resolve `true`
 * only when the user confirms. `subject` is the thing being removed, already
 * quoted (`“Fix the bug”`), and `consequence` is what goes with it — the cards a
 * column delete takes down — left as `''` when there is nothing to add.
 *
 * A delete is one keystroke away from a rename and cannot be undone by the reader
 * of the board, so it is confirmed rather than applied; the note says the edit is
 * one step, because undo is how a wrong confirmation comes back.
 */
export function promptForKanbanDelete(subject: string, consequence = ''): Promise<boolean> {
  return new Promise((resolve) => {
    const { confirmButton } = openDialogShell<boolean>({
      title: `Delete ${subject}?`,
      confirm: 'Delete',
      tone: 'toolbar-danger',
      cancelValue: false,
      enter: 'confirm',
      onSettle: resolve,
      build: (box) => {
        const note = document.createElement('div')
        note.className = 'edi-dialog-note'
        note.textContent = consequence
          ? `${consequence} The diagram is one edit, so undo brings it back.`
          : 'The diagram is one edit, so undo brings it back.'
        box.append(note)
        return (): boolean => true
      },
    })

    // Delete is the answer Enter gives, so it is the button that holds the focus
    // ring; cancelling stays the safe way out, which is what Escape and the
    // backdrop already are.
    confirmButton.focus()
  })
}

/**
 * A rename names a file where it already is: a name with a separator in it, or
 * one that is `.`/`..`, is a move or a climb out of the folder, and a document
 * is not moved by a rename.
 */
function isUsableFileName(name: string): boolean {
  return name.length > 0 && !/[/\\]/.test(name) && name !== '.' && name !== '..'
}

/**
 * Ask for the new name of a document, pre-filled with its current one, and
 * resolve the name typed — or ``null`` if the user cancels (Esc, Cancel, or a
 * click on the backdrop).
 *
 * The stem is what a rename changes, so it is what the field selects: typing
 * replaces the name and leaves the extension alone. A rename deletes the old
 * file, so a name that is empty, that points somewhere else, or that is the name
 * the document already has is reported and left open rather than acted on — and
 * whether the extension is one Edi can open is the save path's business (it
 * asks the same question for a plain Save As), not this dialog's.
 */
export function promptForRename(currentName: string): Promise<string | null> {
  return new Promise((resolve) => {
    let field!: HTMLInputElement
    openDialogShell<string | null>({
      title: 'Rename document',
      confirm: 'Rename',
      tone: 'toolbar-primary',
      cancelValue: null,
      enter: 'confirm',
      onSettle: resolve,
      build: (box) => {
        const label = document.createElement('label')
        label.className = 'edi-dialog-label'
        label.textContent = 'New name for this document'
        box.append(label)

        field = document.createElement('input')
        field.className = 'edi-dialog-input'
        field.type = 'text'
        field.spellcheck = false
        field.value = currentName
        box.append(field)

        const error = document.createElement('div')
        error.className = 'edi-dialog-error'
        error.hidden = true
        box.append(error)

        const refuse = (message: string): undefined => {
          error.textContent = message
          error.hidden = false
          field.focus()
          return undefined
        }

        return (): string | undefined => {
          const name = field.value.trim()
          if (!name) return refuse('Enter a name for the document')
          if (!isUsableFileName(name)) return refuse('A document name is one file name, not a path')
          if (name === currentName) return refuse('That is the document’s current name')
          return name
        }
      },
    })

    const dot = currentName.lastIndexOf('.')
    field.focus()
    field.setSelectionRange(0, dot > 0 ? dot : currentName.length)
  })
}

/** What a new kanban board starts with when the dialog is left alone. */
export const DEFAULT_KANBAN_COLUMNS = 'Todo\nIn Progress\nReview\nDone'

/**
 * Ask for the column names of a new kanban board, one per line, and resolve them
 * trimmed and with the blank lines dropped — or ``null`` if the user cancels
 * (Esc, Cancel, or a click on the backdrop).
 *
 * A board is read top to bottom and outgrows a single-line field after three or
 * four columns, so this is a textarea and Enter is a *newline* — confirming is
 * Ctrl/Cmd+Enter or the Add button. A field with nothing in it is reported and
 * left open rather than resolving an empty board; whether a name is one the
 * kanban grammar can carry is `buildKanbanSource`'s business, not this
 * dialog's.
 */
export function promptForKanbanColumns(): Promise<string[] | null> {
  return new Promise((resolve) => {
    let field!: HTMLTextAreaElement
    openDialogShell<string[] | null>({
      title: 'New kanban board',
      confirm: 'Add',
      tone: 'toolbar-primary',
      cancelValue: null,
      enter: 'ctrl',
      onSettle: resolve,
      build: (box) => {
        const label = document.createElement('label')
        label.className = 'edi-dialog-label'
        label.textContent = 'Columns, one per line (Ctrl+Enter to add the board)'
        box.append(label)

        field = document.createElement('textarea')
        field.className = 'edi-dialog-input'
        field.rows = 6
        field.spellcheck = false
        field.value = DEFAULT_KANBAN_COLUMNS
        box.append(field)

        const error = document.createElement('div')
        error.className = 'edi-dialog-error'
        error.hidden = true
        box.append(error)

        return (): string[] | undefined => {
          const columns = field.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          if (columns.length === 0) {
            error.textContent = 'A board needs at least one column'
            error.hidden = false
            field.focus()
            return undefined
          }
          return columns
        }
      },
    })

    // The defaults are a starting point to edit, not the board itself: put the
    // caret at the end of the first column rather than selecting them all.
    field.setSelectionRange(0, 0)
    field.focus()
  })
}

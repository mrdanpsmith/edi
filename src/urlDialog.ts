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
 */
export interface LinkPrompt {
  text: string
  url: string
}

export function promptForLink(existingText: string, existingUrl: string): Promise<LinkPrompt | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'edi-dialog-overlay'

    const box = document.createElement('div')
    box.className = 'edi-dialog'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = 'Insert link'
    box.append(title)

    const urlLabel = document.createElement('label')
    urlLabel.className = 'edi-dialog-label'
    urlLabel.textContent = 'URL'
    box.append(urlLabel)

    const urlInput = document.createElement('input')
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

    const actions = document.createElement('div')
    actions.className = 'edi-dialog-actions'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'toolbar-btn'
    cancel.textContent = 'Cancel'
    actions.append(cancel)

    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'toolbar-btn toolbar-primary'
    ok.textContent = 'Insert'
    actions.append(ok)

    box.append(actions)
    overlay.append(box)
    document.body.append(overlay)

    function close(): void {
      overlay.remove()
    }

    function finish(value: LinkPrompt | null): void {
      close()
      resolve(value)
    }

    function collect(): LinkPrompt {
      return { text: textInput ? textInput.value : '', url: urlInput.value }
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', () => finish(collect()))
    for (const input of [urlInput, ...(textInput ? [textInput] : [])]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(collect())
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(null)
        }
      })
    }
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })

    urlInput.focus()
    urlInput.select()
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
    const overlay = document.createElement('div')
    overlay.className = 'edi-dialog-overlay'

    const box = document.createElement('div')
    box.className = 'edi-dialog'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = 'New kanban board'
    box.append(title)

    const label = document.createElement('label')
    label.className = 'edi-dialog-label'
    label.textContent = 'Columns, one per line (Ctrl+Enter to add the board)'
    box.append(label)

    const input = document.createElement('textarea')
    input.className = 'edi-dialog-input'
    input.rows = 6
    input.spellcheck = false
    input.value = DEFAULT_KANBAN_COLUMNS
    box.append(input)

    const error = document.createElement('div')
    error.className = 'edi-dialog-error'
    error.hidden = true
    box.append(error)

    const actions = document.createElement('div')
    actions.className = 'edi-dialog-actions'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'toolbar-btn'
    cancel.textContent = 'Cancel'
    actions.append(cancel)

    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'toolbar-btn toolbar-primary'
    ok.textContent = 'Add'
    actions.append(ok)

    box.append(actions)
    overlay.append(box)
    document.body.append(overlay)

    function finish(value: string[] | null): void {
      overlay.remove()
      resolve(value)
    }

    function submit(): void {
      const columns = input.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (columns.length === 0) {
        error.textContent = 'A board needs at least one column'
        error.hidden = false
        input.focus()
        return
      }
      finish(columns)
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', submit)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submit()
      }
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })

    input.focus()
    // The defaults are a starting point to edit, not the board itself: put the
    // caret at the end of the first column rather than selecting them all.
    input.setSelectionRange(0, 0)
  })
}
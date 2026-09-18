/**
 * A small centered modal dialog prompting for a link's URL and, when nothing is
 * selected to provide the link text, an optional link text defaulted to the
 * URL. Used by the formatting toolbar's Hyperlink button for both the document
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
    cancel.className = 'fmt-btn'
    cancel.textContent = 'Cancel'
    actions.append(cancel)

    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'fmt-btn fmt-primary'
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
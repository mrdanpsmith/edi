/**
 * A small centered modal dialog prompting the user for a URL. Used by the
 * formatting toolbar's Hyperlink button. Resolves with the entered URL (or
 * ``null`` if the user cancels).
 */
export function promptForUrl(existing: string): Promise<string | null> {
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

    const label = document.createElement('label')
    label.className = 'edi-dialog-label'
    label.textContent = 'URL'
    box.append(label)

    const input = document.createElement('input')
    input.className = 'edi-dialog-input'
    input.type = 'url'
    input.placeholder = 'https://'
    input.value = existing
    box.append(input)

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

    function finish(value: string | null): void {
      close()
      resolve(value)
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', () => finish(input.value))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(input.value)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })

    input.focus()
    input.select()
  })
}

import { validateMaskedLabel } from './node/masked'

export interface SecretCreateResult {
  label: string
  value: string
}

function createDialog(): {
  overlay: HTMLDivElement
  box: HTMLDivElement
  close: () => void
} {
  const overlay = document.createElement('div')
  overlay.className = 'edi-dialog-overlay'

  const box = document.createElement('div')
  box.className = 'edi-dialog'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')

  overlay.appendChild(box)
  document.body.appendChild(overlay)

  return {
    overlay,
    box,
    close: () => overlay.remove(),
  }
}

function errorLine(): HTMLDivElement {
  const error = document.createElement('div')
  error.className = 'edi-dialog-error'
  error.hidden = true
  return error
}

/**
 * Prompt for the password of a single masked field. Resolves with the password
 * (or ``null`` on cancel). When ``validate`` is provided it is run on OK; a
 * non-``true`` return keeps the dialog open and shows the returned string as an
 * inline error (used to surface "incorrect password" without closing).
 */
export function promptForPassword(
  context: string,
  validate?: (password: string) => Promise<true | string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, box, close } = createDialog()

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = `Enter password for ${context}`
    box.append(title)

    const label = document.createElement('label')
    label.className = 'edi-dialog-label'
    label.textContent = 'Password'
    box.append(label)

    const row = document.createElement('div')
    row.className = 'edi-dialog-input-row'

    const input = document.createElement('input')
    input.className = 'edi-dialog-input'
    input.type = 'password'
    input.autocomplete = 'off'
    row.append(input)

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'fmt-btn edi-dialog-reveal-toggle'
    toggle.textContent = 'Show'
    toggle.addEventListener('mousedown', (e) => e.preventDefault())
    toggle.addEventListener('click', () => {
      const showing = input.type === 'text'
      input.type = showing ? 'password' : 'text'
      toggle.textContent = showing ? 'Show' : 'Hide'
      input.focus()
    })
    row.append(toggle)

    box.append(row)

    const error = errorLine()
    box.append(error)

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
    ok.textContent = 'Unlock'
    actions.append(ok)

    box.append(actions)

    function finish(value: string | null): void {
      close()
      resolve(value)
    }

    function submit(): void {
      const password = input.value
      if (!validate) {
        finish(password)
        return
      }
      validate(password).then((result) => {
        if (result === true) {
          finish(password)
        } else {
          error.textContent = result
          error.hidden = false
          input.focus()
          input.select()
        }
      })
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', submit)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })

    input.focus()
  })
}

/**
 * Prompt for a new masked field's optional label and secret value. Resolves
 * with ``{ label, value }`` (label already sanitized/validated) or ``null`` on
 * cancel.
 */
export function promptForSecretCreate(): Promise<SecretCreateResult | null> {
  return new Promise((resolve) => {
    const { overlay, box, close } = createDialog()

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = 'Insert encrypted field'
    box.append(title)

    const labelText = document.createElement('label')
    labelText.className = 'edi-dialog-label'
    labelText.textContent = 'Label (optional)'
    box.append(labelText)

    const nameInput = document.createElement('input')
    nameInput.className = 'edi-dialog-input'
    nameInput.type = 'text'
    nameInput.placeholder = 'e.g. API Key'
    box.append(nameInput)

    const valueText = document.createElement('label')
    valueText.className = 'edi-dialog-label'
    valueText.textContent = 'Secret value'
    box.append(valueText)

    const valueInput = document.createElement('input')
    valueInput.className = 'edi-dialog-input'
    valueInput.type = 'text'
    valueInput.placeholder = 'value stored encrypted'
    box.append(valueInput)

    const error = errorLine()
    box.append(error)

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

    function fail(message: string, focus: HTMLInputElement): void {
      error.textContent = message
      error.hidden = false
      focus.focus()
    }

    function finish(value: SecretCreateResult | null): void {
      close()
      resolve(value)
    }

    function submit(): void {
      const label = nameInput.value.trim()
      const value = valueInput.value
      const problem = validateMaskedLabel(label)
      if (problem) {
        fail(problem, nameInput)
        return
      }
      if (!value) {
        fail('Secret value is required', valueInput)
        return
      }
      finish({ label, value })
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', submit)
    for (const inputEl of [nameInput, valueInput]) {
      inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(null)
        }
      })
    }
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })

    nameInput.focus()
  })
}
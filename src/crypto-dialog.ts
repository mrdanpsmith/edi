import { validateMaskedLabel } from './node/masked'

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

export interface PasswordPromptOptions {
  okText?: string
  title?: string
}

/**
 * Prompt for the password of a single masked field. Resolves with the password
 * (or ``null`` on cancel). When ``validate`` is provided it is run on OK; a
 * non-``true`` return keeps the dialog open and shows the returned string as an
 * inline error (used to surface "incorrect password" without closing).
 *
 * ``opts.okText`` / ``opts.title`` customize the action button and dialog title
 * (the default "Unlock" does not fit the create/re-encrypt flows).
 */

/**
 * Warn about a blank password and require an explicit opt-in. Defaults to No:
 * Escape, backdrop click and plain Enter all bounce back to the password
 * fields, so a real password is the path of least resistance.
 */
function confirmBlankPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, box, close } = createDialog()
    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = 'Use a blank password?'
    box.append(title)
    const msg = document.createElement('p')
    msg.className = 'edi-dialog-label'
    msg.textContent =
      'The content will still be encrypted, but there is no password to guess — anyone opening this document can decrypt it with an empty password. Continue with a blank password, or go back and set a real one?'
    box.append(msg)
    const actions = document.createElement('div')
    actions.className = 'edi-dialog-actions'
    const useBlank = document.createElement('button')
    useBlank.type = 'button'
    useBlank.className = 'toolbar-btn toolbar-danger'
    useBlank.textContent = 'Use blank password'
    const setReal = document.createElement('button')
    setReal.type = 'button'
    setReal.className = 'toolbar-btn toolbar-primary'
    setReal.textContent = 'Set a real password'
    actions.append(useBlank, setReal)
    box.append(actions)

    function done(value: boolean): void {
      close()
      resolve(value)
    }

    useBlank.addEventListener('click', () => done(true))
    setReal.addEventListener('click', () => done(false))
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) done(false)
    })
    for (const btn of [useBlank, setReal]) {
      btn.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); btn.click() }
        else if (event.key === 'Escape') { event.preventDefault(); done(false) }
      })
    }
    setReal.focus()
  })
}

function labelledInput(box: HTMLElement, text: string, type: 'text' | 'password'): HTMLInputElement {
  const label = document.createElement('label')
  label.className = 'edi-dialog-label'
  label.textContent = text
  box.append(label)
  const input = document.createElement('input')
  input.className = 'edi-dialog-input'
  input.type = type
  input.autocomplete = 'off'
  box.append(input)
  return input
}

function dialogActions(box: HTMLElement, okText: string): { cancel: HTMLButtonElement; ok: HTMLButtonElement } {
  const actions = document.createElement('div')
  actions.className = 'edi-dialog-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'toolbar-btn'
  cancel.textContent = 'Cancel'
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'toolbar-btn toolbar-primary'
  ok.textContent = okText
  actions.append(cancel, ok)
  box.append(actions)
  return { cancel, ok }
}

/**
 * The Password / Confirm pair every new password is typed into, and the rule it has
 * to pass: the two entries match, and a blank one is an explicit choice.
 *
 * `read` resolves with the password, or `null` when the dialog has to stay open (it
 * has already said why and put the caret where the fix goes).
 */
function newPasswordFields(box: HTMLElement, error: HTMLDivElement): {
  first: HTMLInputElement
  second: HTMLInputElement
  read: () => Promise<string | null>
} {
  const first = labelledInput(box, 'Password', 'password')
  const second = labelledInput(box, 'Confirm password', 'password')
  async function read(): Promise<string | null> {
    if (first.value !== second.value) {
      error.textContent = 'Passwords do not match'
      error.hidden = false
      second.value = ''
      second.focus()
      return null
    }
    if (first.value === '' && !(await confirmBlankPassword())) {
      first.focus()
      return null
    }
    return first.value
  }
  return { first, second, read }
}

/**
 * Wire a dialog's keyboard: Enter moves through `inputs` and submits from the last,
 * Escape and a backdrop press cancel.
 */
function wireDialogKeys(
  overlay: HTMLElement,
  inputs: HTMLInputElement[],
  submit: () => void,
  cancel: () => void,
): void {
  inputs.forEach((input, i) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const next = inputs[i + 1]
        if (next) { next.focus(); next.select() } else submit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    })
  })
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) cancel()
  })
}

/**
 * Set a brand-new password: the dialog asks twice and only accepts a match. */
export function promptForNewPassword(
  context: string,
  opts?: PasswordPromptOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, box, close } = createDialog()

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = opts?.title ?? `Set password for ${context}`
    box.append(title)

    const error = errorLine()
    const password = newPasswordFields(box, error)
    box.append(error)
    const { cancel, ok } = dialogActions(box, opts?.okText ?? 'Encrypt')

    function finish(value: string | null): void {
      close()
      resolve(value)
    }

    function submit(): void {
      void password.read().then((value) => {
        if (value !== null) finish(value)
      })
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', submit)
    wireDialogKeys(overlay, [password.first, password.second], submit, () => finish(null))

    password.first.focus()
  })
}

export function promptForPassword(
  context: string,
  validate?: (password: string) => Promise<true | string>,
  opts?: PasswordPromptOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, box, close } = createDialog()

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = opts?.title ?? `Enter password for ${context}`
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
    toggle.className = 'toolbar-btn edi-dialog-reveal-toggle'
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
    cancel.className = 'toolbar-btn'
    cancel.textContent = 'Cancel'
    actions.append(cancel)

    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'toolbar-btn toolbar-primary'
    ok.textContent = opts?.okText ?? 'Unlock'
    actions.append(ok)

    box.append(actions)

    function finish(value: string | null): void {
      close()
      resolve(value)
    }

    let submitting = false

    function submit(): void {
      if (submitting) return
      submitting = true
      const password = input.value
      if (!validate) {
        finish(password)
        return
      }
      validate(password).then((result) => {
        if (result === true) {
          finish(password)
        } else {
          submitting = false
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

export interface EncryptRequest {
  /** What is being made: a field takes a value, a block encrypts the selection itself. */
  kind: 'field' | 'block'
  /** A field's prefilled value — the selected text it will replace. */
  initialValue?: string
}

export interface EncryptResult {
  label: string
  /** The field's secret; always `''` for a block. */
  value: string
  password: string
  /** Leave the result locked rather than showing what was just encrypted. */
  lockImmediately: boolean
}

/**
 * The one dialog behind **Encrypt…**, for a field and a block alike: an optional
 * label, the value (a field only), the password asked twice, and Lock immediately.
 * Resolves with everything the caller needs to encrypt, or `null` on cancel.
 *
 * **Lock immediately defaults differ by kind, on purpose:** a field's value is a
 * secret just typed and is hidden by default; a block is text the reader is about
 * to keep working on and stays open.
 */
export function promptForEncrypt(request: EncryptRequest): Promise<EncryptResult | null> {
  const isField = request.kind === 'field'
  return new Promise((resolve) => {
    const { overlay, box, close } = createDialog()

    const title = document.createElement('div')
    title.className = 'edi-dialog-title'
    title.textContent = isField ? 'Encrypt field' : 'Encrypt block'
    box.append(title)

    const nameInput = labelledInput(box, 'Label (optional)', 'text')
    nameInput.placeholder = isField ? 'e.g. API Key' : 'e.g. Deployment credentials'

    let valueInput: HTMLInputElement | null = null
    if (isField) {
      const valueText = document.createElement('label')
      valueText.className = 'edi-dialog-label'
      valueText.textContent = 'Secret value'
      box.append(valueText)
      const row = document.createElement('div')
      row.className = 'edi-dialog-input-row'
      const input = document.createElement('input')
      input.className = 'edi-dialog-input'
      input.type = 'password'
      input.autocomplete = 'off'
      input.placeholder = 'value stored encrypted'
      input.value = request.initialValue ?? ''
      row.append(input)
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'toolbar-btn edi-dialog-reveal-toggle'
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
      valueInput = input
    }

    const error = errorLine()
    const password = newPasswordFields(box, error)

    const lockCheck = document.createElement('label')
    lockCheck.className = 'edi-dialog-label'
    const lockBox = document.createElement('input')
    lockBox.type = 'checkbox'
    lockBox.checked = isField
    lockCheck.append(lockBox, document.createTextNode(' Lock immediately'))
    box.append(lockCheck)

    box.append(error)
    const { cancel, ok } = dialogActions(box, 'Encrypt')

    function fail(message: string, focus: HTMLInputElement): void {
      error.textContent = message
      error.hidden = false
      focus.focus()
    }

    function finish(value: EncryptResult | null): void {
      close()
      resolve(value)
    }

    let submitting = false
    async function submit(): Promise<void> {
      if (submitting) return
      const label = nameInput.value.trim()
      const problem = isField ? validateMaskedLabel(label) : null
      if (problem) return fail(problem, nameInput)
      const value = valueInput?.value ?? ''
      if (valueInput && !value) return fail('Secret value is required', valueInput)
      submitting = true
      const pw = await password.read()
      submitting = false
      if (pw === null) return
      finish({ label, value, password: pw, lockImmediately: lockBox.checked })
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', () => void submit())
    const inputs = [nameInput, ...(valueInput ? [valueInput] : []), password.first, password.second]
    wireDialogKeys(overlay, inputs, () => void submit(), () => finish(null))

    nameInput.focus()
  })
}
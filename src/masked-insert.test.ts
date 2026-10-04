import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { createBlockEditor } from './editor'
import { insertMaskedFieldCommand } from './node/masked'
import { promptForNewPassword, promptForSecretCreate } from './crypto-dialog'

vi.mock('./crypto-dialog', () => ({
  promptForPassword: vi.fn(),
  promptForNewPassword: vi.fn(),
  promptForSecretCreate: vi.fn(),
  promptForEncryptedBlockLabel: vi.fn(),
}))

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(promptForSecretCreate).mockReset()
  vi.mocked(promptForNewPassword).mockReset()
  vi.mocked(promptForSecretCreate).mockResolvedValue({ label: '', value: 'pw-secret', showValueInitially: true })
  vi.mocked(promptForNewPassword).mockResolvedValue('pw')
})

describe('insertMaskedFieldCommand create flow', () => {
  it('honours the inline-hide default when showValueInitially is unchecked', async () => {
    vi.mocked(promptForSecretCreate).mockResolvedValue({ label: '', value: 'topsecret', showValueInitially: false })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = createBlockEditor(host, 'x', {})
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    await insertMaskedFieldCommand(view)
    expect(document.querySelector('.masked-field-value')).toBeNull()
    editor.destroy()
    host.remove()
  })
})

describe('insertMaskedFieldCommand', () => {
  it('prefills the secret value with the current selection and replaces it', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = createBlockEditor(host, 'store pw-secret now', {})
    const view = editor.getView()
    const pos = view.state.doc.textContent.indexOf('pw-secret') + 1
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos + 'pw-secret'.length)))
    const ok = await insertMaskedFieldCommand(view)
    expect(ok).toBe(true)
    expect(promptForSecretCreate).toHaveBeenCalledWith('pw-secret')
    expect(view.state.doc.textContent).not.toContain('pw-secret')
    expect(document.querySelector('.masked-field-value')?.textContent).toBe('pw-secret')
    editor.destroy()
    host.remove()
  })

  it('opens with the plaintext visible (no second prompt on insert)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = createBlockEditor(host, 'x', {})
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    await insertMaskedFieldCommand(view)
    expect(promptForNewPassword).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.masked-field-value')).toBeTruthy()
    editor.destroy()
    host.remove()
  })
})

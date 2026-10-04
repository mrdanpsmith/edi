import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBlockEditor } from '../editor'
import { encryptField } from '../crypto'
import { promptForPassword } from '../crypto-dialog'
import { confirmAction } from '../bridge'

vi.mock('../crypto-dialog', () => ({
  promptForPassword: vi.fn(),
  promptForEncryptedBlockLabel: vi.fn(),
  promptForSecretCreate: vi.fn(),
}))
vi.mock('../bridge', () => ({
  confirmAction: vi.fn(),
}))

const password = 'pw'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(promptForPassword).mockReset()
  vi.mocked(confirmAction).mockReset()
  vi.mocked(promptForPassword).mockResolvedValue(password)
})

async function editorWithEncrypted(innerMarkdown: string) {
  const envelope = await encryptField(innerMarkdown, password)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const md = '```encrypted type="paragraph" label="Secret"\n' + envelope + '\n```\n\nafter'
  return createBlockEditor(host, md, {})
}

const tick = () => new Promise((r) => setTimeout(r, 120))

describe('encrypted_block', () => {
  it('shows the block type in the chrome with underscores replaced by spaces', async () => {
    const editor = await (async () => {
      const envelope = await encryptField('x', password)
      const host = document.createElement('div')
      document.body.appendChild(host)
      const md = '```encrypted type="code_block" label="Keys"\n' + envelope + '\n```'
      return createBlockEditor(host, md, {})
    })()
    const chip = document.querySelector('.encrypted-block-label')!
    expect(chip.textContent).toBe('🔒 encrypted · code block · Keys')
    expect(chip.textContent).not.toContain('_')
    editor.destroy()
  })

  it('Show decrypts into an inline editable render without touching the document', async () => {
    const editor = await editorWithEncrypted('hello **secret**')
    const view = editor.getView()
    const docBefore = view.state.doc.childCount
    const viewBtn = document.querySelector<HTMLButtonElement>('.encrypted-block-toggle')!
    viewBtn.click()
    await tick()
    const reveal = document.querySelector('.encrypted-block-reveal')!
    expect(reveal.textContent).toContain('hello')
    expect(reveal.textContent).toContain('secret')
    expect(view.state.doc.childCount).toBe(docBefore)
    expect(promptForPassword).toHaveBeenCalled()
    editor.destroy()
  })

  it('gives the password dialog a validator that flags a wrong password', async () => {
    const editor = await editorWithEncrypted('hello **secret**')
    const viewBtn = document.querySelector<HTMLButtonElement>('.encrypted-block-toggle')!
    viewBtn.click()
    await tick()
    const validate = vi.mocked(promptForPassword).mock.calls[0]![1]!
    await expect(validate('wrong-password')).resolves.toBe('Incorrect password')
    await expect(validate(password)).resolves.toBe(true)
    editor.destroy()
  })

  it('Unmask replaces the encrypted block with its real markdown after confirmation', async () => {
    const editor = await editorWithEncrypted('# Title\n\neventual')
    const view = editor.getView()
    vi.mocked(confirmAction).mockResolvedValue(true)
    const unmaskBtn = document.querySelector<HTMLButtonElement>('.encrypted-block-unmask')!
    unmaskBtn.click()
    await tick()
    expect(confirmAction).toHaveBeenCalled()
    expect(view.state.doc.firstChild?.type.name).toBe('heading')
    expect(view.state.doc.textContent).toContain('eventual')
    editor.destroy()
  })

  it('Show with a wrong password leaves the block unchanged', async () => {
    const editor = await editorWithEncrypted('hello secret')
    const view = editor.getView()
    vi.mocked(promptForPassword).mockResolvedValue('wrong')
    const viewBtn = document.querySelector<HTMLButtonElement>('.encrypted-block-toggle')!
    viewBtn.click()
    await tick()
    expect(document.querySelector('.encrypted-block-reveal')).toBeNull()
    expect(view.state.doc.firstChild?.type.name).toBe('encrypted_block')
    editor.destroy()
  })
})

it('editing inside Show persists by re-encrypting the block', async () => {
  const editor = await editorWithEncrypted('- [ ] one\n- [x] two')
  const view = editor.getView()
  const before = String(view.state.doc.firstChild?.attrs.content ?? '')
  const toggleBtn = document.querySelector<HTMLButtonElement>('.encrypted-block-toggle')!
  toggleBtn.click()
  await tick()
  const input = document.querySelector<HTMLInputElement>('.encrypted-block-reveal input[data-task-check]')!
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // persist debounce is 600 ms; encryption adds time on top.
  await new Promise((r) => setTimeout(r, 1500))
  const after = String(view.state.doc.firstChild?.attrs.content ?? '')
  expect(after).not.toBe(before)
  editor.destroy()
})

it('Show view stays open across the persist cycle', async () => {
  const editor = await editorWithEncrypted('- [ ] one\n- [x] two')
  const view = editor.getView()
  const before = String(view.state.doc.firstChild?.attrs.content ?? '')
  document.querySelector<HTMLButtonElement>('.encrypted-block-toggle')!.click()
  await tick()
  const input = document.querySelector<HTMLInputElement>('.encrypted-block-reveal input[data-task-check]')!
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 1500))
  expect(document.querySelector('.encrypted-block-reveal')).toBeTruthy()
  const after = String(view.state.doc.firstChild?.attrs.content ?? '')
  expect(after).not.toBe(before)
  editor.destroy()
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBlockEditor } from '../editor'
import { decryptField, encryptField, openEnvelope, openWithKey } from '../crypto'
import { promptForPassword } from '../crypto-dialog'
import { confirmAction } from '../bridge'
import { getActiveEncryptedBlockView } from './encryptedblock'

vi.mock('../crypto-dialog', () => ({
  promptForPassword: vi.fn(),
  promptForEncrypt: vi.fn(),
}))
vi.mock('../bridge', () => ({
  confirmAction: vi.fn(),
}))

const password = 'pw'
const SECRET = { kind: 'block', label: 'Secret' } as const

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(promptForPassword).mockReset()
  vi.mocked(confirmAction).mockReset()
  vi.mocked(promptForPassword).mockResolvedValue(password)
})

async function editorWithEncrypted(innerMarkdown: string) {
  const envelope = await encryptField(innerMarkdown, password, SECRET)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const md = '```encrypted type="paragraph" label="Secret"\n' + envelope + '\n```\n\nafter'
  return createBlockEditor(host, md, {})
}

const tick = () => new Promise((r) => setTimeout(r, 800))

/**
 * The cluster's **one** interaction control: the button that opens a reveal and the
 * button that closes it.
 *
 * It used to be `.encrypted-block-toggle` (`Unlock ▸` / `Lock ▾`), which sat beside
 * the generated `Edit` / `Done` and did the same act under a second name. Every
 * test below was pressing one of the pair; they all press this one now, which is
 * also what makes "both buttons do the same thing" a fact about the tests rather
 * than only about the UI.
 */
const interactionButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('.encrypted-block .block-control-interaction')!

describe('encrypted_block', () => {
  it('names the block by its label only, not the type it was made from', async () => {
    const editor = await (async () => {
      const envelope = await encryptField('x', password, { kind: 'block', label: 'Keys' })
      const host = document.createElement('div')
      document.body.appendChild(host)
      const md = '```encrypted type="code_block" label="Keys"\n' + envelope + '\n```'
      return createBlockEditor(host, md, {})
    })()
    const chip = document.querySelector('.encrypted-block-label')!
    expect(chip.textContent).toBe('🔒 encrypted · Keys')
    editor.destroy()
  })

  it('carries one control for its edit step, not two that both open the reveal', async () => {
    // `blockModeFor` declares this block interactive, so the cluster generates
    // one control for that step from the descriptor — and this block's `toggle` *is*
    // `toggleShow_`. A second `Unlock ▸` button stood next to it and did the same
    // act: the same gesture was reachable under two names in one 100px row, and
    // only one of the two was repainted by the record. The whole row, closed and
    // open — and `Unlock` / `Lock` rather than a diagram's `Edit` / `Done`, because
    // this axis declares its own verbs.
    const editor = await editorWithEncrypted('hello')
    // The block's *own* row, not a descendant match: an open reveal is a nested
    // block editor living inside this element, and its blocks have clusters of
    // their own. `>` is what says "this block's row".
    const row = (): string[] =>
      [...document.querySelectorAll('.encrypted-block > .block-controls button')]
        .map((b) => b.getAttribute('aria-label') ?? '')

    expect(row()).toEqual(['Unlock', 'Normalize', 'Source'])

    interactionButton().click()
    await tick()
    // Open, the same one button reads the other end — and it is the same button,
    // not a second one that happens to agree.
    expect(row()).toEqual(['Lock', 'Normalize', 'Source'])
    expect(document.querySelectorAll('.encrypted-block .block-control-interaction').length).toBe(1)

    interactionButton().click()
    await tick()
    expect(document.querySelector('.encrypted-block-reveal')).toBeNull()
    expect(row()).toEqual(['Unlock', 'Normalize', 'Source'])
    editor.destroy()
  })

  it('Show decrypts into an inline editable render without touching the document', async () => {
    const editor = await editorWithEncrypted('hello **secret**')
    const view = editor.getView()
    const docBefore = view.state.doc.childCount
    const viewBtn = interactionButton()
    viewBtn.click()
    await tick()
    const reveal = document.querySelector('.encrypted-block-reveal')!
    expect(reveal.textContent).toContain('hello')
    expect(reveal.textContent).toContain('secret')
    expect(view.state.doc.childCount).toBe(docBefore)
    expect(promptForPassword).toHaveBeenCalled()
    editor.destroy()
  })

  it('answers for the reveal that holds focus, and only for that one', async () => {
    const editor = await editorWithEncrypted('hello')
    interactionButton().click()
    await tick()
    const reveal = getActiveEncryptedBlockView()
    expect(reveal).not.toBeNull()
    expect(reveal!.dom.classList.contains('encrypted-block-reveal-editor')).toBe(true)
    expect(document.activeElement).toBe(reveal!.dom)

    // **Expectation change, and the reason is the mechanism.** This used to be
    // `expect(...).toBeNull()` after a `focusin` on the document's own DOM. It could
    // be that way because the answer came from a *remembered* editor and any stray
    // `focusin` anywhere demoted it — and that is exactly the bug: a dialog closing, a
    // node view rebuilding or a grid taking the caret back and giving it back all
    // silently moved every later command out of the block the reader was standing in.
    // The rule this exists for is "a nested editor owns its own selection and its own
    // keyboard, **by virtue of holding focus**", so the answer is read from where the
    // caret is, and an event that does not move focus cannot change it.
    editor.getView().dom.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(getActiveEncryptedBlockView()).toBe(reveal)

    // ...and focus genuinely leaving is what releases it. Blur first, so this is the
    // real gesture rather than the remembered editor being told to forget: with the
    // caret still in the reveal the answer *should* stay the reveal, and a test that
    // asserted otherwise would be asking the function to lie about where the caret is.
    reveal!.dom.blur()
    document.body.focus()
    expect(getActiveEncryptedBlockView()).toBeNull()
    editor.destroy()
  })

  it('commits reveal edits back into the encrypted envelope on change and on lock', async () => {
    const editor = await editorWithEncrypted('hello')
    interactionButton().click()
    await tick()
    const reveal = getActiveEncryptedBlockView()!
    reveal.dispatch(reveal.state.tr.insertText(' world'))
    await vi.waitFor(async () => {
      const md = editor.getMarkdown()
      const m = md.match(/```encrypted[^\n]*\n([^\n]*)\n```/)
      expect(await decryptField(m![1]!, password, SECRET)).toContain('world')
    }, { timeout: 10000, interval: 200 })
    reveal.dispatch(reveal.state.tr.insertText(' again'))
    interactionButton().click()
    await vi.waitFor(async () => {
      const inner = await decryptField(
        editor.getMarkdown().match(/```encrypted[^\n]*\n([^\n]*)\n```/)![1]!,
        password,
        SECRET,
      )
      expect(inner).toContain('again')
    }, { timeout: 10000, interval: 200 })
    editor.destroy()
  })

  it('saves an open block with the key it unlocked with, deriving nothing per save', async () => {
    const editor = await editorWithEncrypted('hello')
    const envelope = editor.getMarkdown().match(/```encrypted[^\n]*\n([^\n]*)\n```/)![1]!
    // Saves keep the block's salt, so this key opens every later save.
    const { key } = await openEnvelope(envelope, password, SECRET)
    interactionButton().click()
    await tick()
    const derive = vi.spyOn(crypto.subtle, 'deriveKey')
    const reveal = getActiveEncryptedBlockView()!
    for (const word of [' one', ' two']) {
      reveal.dispatch(reveal.state.tr.insertText(word))
      await vi.waitFor(async () => {
        const m = editor.getMarkdown().match(/```encrypted[^\n]*\n([^\n]*)\n```/)
        const opened = await openWithKey(m![1]!, key, SECRET).catch(() => '')
        expect(opened).toContain(word.trim())
      }, { timeout: 10000, interval: 200 })
    }
    expect(derive).not.toHaveBeenCalled()
    derive.mockRestore()
    editor.destroy()
  })

  it('commits edits for blocks with a blank password', async () => {
    const envelope = await encryptField('hello', '', SECRET)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const md = '```encrypted type="paragraph" label="Secret"\n' + envelope + '\n```\n\nafter'
    const editor = createBlockEditor(host, md, {})
    vi.mocked(promptForPassword).mockResolvedValue('')
    interactionButton().click()
    await tick()
    const reveal = getActiveEncryptedBlockView()!
    reveal.dispatch(reveal.state.tr.insertText(' again'))
    interactionButton().click()
    await vi.waitFor(async () => {
      const inner = await decryptField(
        (editor.getMarkdown().match(/```encrypted[^\n]*\n([^\n]*)\n```/)!)[1]!,
        '',
        SECRET,
      )
      expect(inner).toContain('again')
    }, { timeout: 10000, interval: 200 })
    editor.destroy()
  })

  it('gives the password dialog a validator that flags a wrong password', async () => {
    const editor = await editorWithEncrypted('hello **secret**')
    const viewBtn = interactionButton()
    viewBtn.click()
    await tick()
    const validate = vi.mocked(promptForPassword).mock.calls[0]![1]!
    await expect(validate('wrong-password')).resolves.toBe('Incorrect password, or the label was changed after encrypting')
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
    const viewBtn = interactionButton()
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
  const toggleBtn = interactionButton()
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
  interactionButton().click()
  await tick()
  const input = document.querySelector<HTMLInputElement>('.encrypted-block-reveal input[data-task-check]')!
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 1500))
  expect(document.querySelector('.encrypted-block-reveal')).toBeTruthy()
  const after = String(view.state.doc.firstChild?.attrs.content ?? '')
  expect(after).not.toBe(before)
  editor.destroy()
})

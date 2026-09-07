import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createBlockEditor } from '../editor'
import { proseToMarkdown } from '../markdown'
import { encryptField } from '../crypto'

beforeEach(() => {
  document.body.innerHTML = ''
})

async function unlockViaDialog(password: string): Promise<void> {
  const overlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
  expect(overlay, 'expected a password dialog to be open').toBeTruthy()
  const input = overlay.querySelector('.edi-dialog-input') as HTMLInputElement
  input.value = password
  const ok = overlay.querySelector('.fmt-primary') as HTMLButtonElement
  ok.click()
  await vi.waitFor(
    () => {
      expect(document.body.querySelector('.edi-dialog-overlay')).toBeNull()
    },
    { timeout: 15000 },
  )
}

describe('masked field reveal/copy/hide is not a document change', () => {
  it('revealing and hiding never marks the document dirty', async () => {
    const envelope = await encryptField('top-s3cret', 'pw')
    const original = `field: !masked[${envelope}]{label="Key"}`
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, original, { onChange })
    onChange.mockClear()

    const field = document.body.querySelector('.masked-field') as HTMLElement
    expect(field).toBeTruthy()

    ;(field.querySelector('.masked-field-eye') as HTMLButtonElement).click()
    await unlockViaDialog('pw')

    expect(onChange).not.toHaveBeenCalled()
    expect(field.querySelector('.masked-field-value')?.textContent).toBe('top-s3cret')

    ;(field.querySelector('.masked-field-eye') as HTMLButtonElement).click()
    expect(onChange).not.toHaveBeenCalled()
    expect(field.querySelector('.masked-field-dots')).toBeTruthy()

    expect(proseToMarkdown(editor.getView().state.doc)).toBe(original + '\n')
    editor.destroy()
  })

  it('copying a masked field without revealing never marks the document dirty', async () => {
    const envelope = await encryptField('copy-me', 'pw')
    const original = `field: !masked[${envelope}]{label="Key"}`
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, original, { onChange })
    onChange.mockClear()

    const field = document.body.querySelector('.masked-field') as HTMLElement
    ;(field.querySelector('.masked-field-copy') as HTMLButtonElement).click()
    await unlockViaDialog('pw')

    expect(onChange).not.toHaveBeenCalled()
    // The field stays masked after a clipboard copy.
    expect(field.querySelector('.masked-field-value')).toBeNull()
    expect(proseToMarkdown(editor.getView().state.doc)).toBe(original + '\n')
    editor.destroy()
  })
})
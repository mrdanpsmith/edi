import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promptForEncrypt, promptForNewPassword } from './crypto-dialog'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('promptForNewPassword', () => {
  it('stays open with an error when the two entries do not match', async () => {
    const p = promptForNewPassword('field', {})
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay = document.querySelector('.edi-dialog-overlay') as HTMLElement
    const inputs = overlay.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    inputs[0]!.value = 'a'
    inputs[1]!.value = 'b'
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    const err = overlay.querySelector<HTMLElement>('.edi-dialog-error')!
    expect(err.hidden).toBe(false)
    expect(err.textContent).toContain('match')
    expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    expect(await Promise.race([p, Promise.resolve('pending')])).toBe('pending')
  })

  it('resolves with the password when they match', async () => {
    const p = promptForNewPassword('field', {})
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay = document.querySelector('.edi-dialog-overlay') as HTMLElement
    const inputs = overlay.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    inputs[0]!.value = 'same'
    inputs[1]!.value = 'same'
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toBe('same')
  })
})

async function openDialog(): Promise<{ overlay: HTMLElement; inputs: HTMLInputElement[] }> {
  await vi.waitFor(() => {
    expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
  })
  const overlay = document.querySelector('.edi-dialog-overlay') as HTMLElement
  return { overlay, inputs: [...overlay.querySelectorAll<HTMLInputElement>('.edi-dialog-input')] }
}

describe('promptForEncrypt', () => {
  it('asks a field for its label, value and password in one dialog, locked by default', async () => {
    const p = promptForEncrypt({ kind: 'field' })
    const { overlay, inputs } = await openDialog()
    expect(overlay.querySelector('.edi-dialog-title')!.textContent).toBe('Encrypt field')
    expect(inputs).toHaveLength(4)
    const lock = overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(lock.checked).toBe(true)
    expect(overlay.textContent).toContain('Lock immediately')
    inputs[0]!.value = 'API Key'
    inputs[1]!.value = 'hunter2'
    inputs[2]!.value = 'pw'
    inputs[3]!.value = 'pw'
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toEqual({ label: 'API Key', value: 'hunter2', password: 'pw', lockImmediately: true })
  })

  it('asks a block for its label and password only, open by default', async () => {
    const p = promptForEncrypt({ kind: 'block' })
    const { overlay, inputs } = await openDialog()
    expect(overlay.querySelector('.edi-dialog-title')!.textContent).toBe('Encrypt block')
    expect(inputs).toHaveLength(3)
    const lock = overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(lock.checked).toBe(false)
    inputs[0]!.value = 'Keys'
    inputs[1]!.value = 'pw'
    inputs[2]!.value = 'pw'
    lock.click()
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toEqual({ label: 'Keys', value: '', password: 'pw', lockImmediately: true })
  })

  it('stays open when a field has no value or the passwords differ', async () => {
    const p = promptForEncrypt({ kind: 'field' })
    const { overlay, inputs } = await openDialog()
    const ok = overlay.querySelector('.toolbar-primary') as HTMLButtonElement
    const err = overlay.querySelector<HTMLElement>('.edi-dialog-error')!
    ok.click()
    await vi.waitFor(() => expect(err.textContent).toContain('required'))
    inputs[1]!.value = 'v'
    inputs[2]!.value = 'a'
    inputs[3]!.value = 'b'
    ok.click()
    await vi.waitFor(() => expect(err.textContent).toContain('match'))
    expect(await Promise.race([p, Promise.resolve('pending')])).toBe('pending')
  })

  it('hints at the password strength as it is typed, without blocking a weak one', async () => {
    const p = promptForEncrypt({ kind: 'block' })
    const { overlay, inputs } = await openDialog()
    const hint = overlay.querySelector<HTMLElement>('.edi-dialog-strength')!
    expect(hint.hidden).toBe(true)
    inputs[1]!.value = 'P@ssw0rd'
    inputs[1]!.dispatchEvent(new Event('input'))
    expect(hint.hidden).toBe(false)
    expect(hint.dataset.score).toBe('0')
    expect(hint.textContent).toContain('Very weak')
    inputs[2]!.value = 'P@ssw0rd'
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toMatchObject({ password: 'P@ssw0rd' })
  })

  it('moves through the fields on Enter and submits from the last', async () => {
    const p = promptForEncrypt({ kind: 'block' })
    const { inputs } = await openDialog()
    const enter = (el: HTMLInputElement): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    enter(inputs[0]!)
    expect(document.activeElement).toBe(inputs[1])
    inputs[1]!.value = 'pw'
    inputs[2]!.value = 'pw'
    enter(inputs[2]!)
    await expect(p).resolves.toMatchObject({ password: 'pw' })
  })

  it('focuses the label field and masks the secret value, even with a prefill', async () => {
    const p = promptForEncrypt({ kind: 'field', initialValue: 'prefill' })
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay = document.querySelector('.edi-dialog-overlay') as HTMLElement
    const inputs = overlay.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    expect(inputs[0]!.value).toBe('')
    expect(inputs[1]!.value).toBe('prefill')
    expect(inputs[1]!.type).toBe('password')
    expect(document.activeElement).toBe(inputs[0])
    const toggle = overlay.querySelector<HTMLButtonElement>('.edi-dialog-reveal-toggle')!
    expect(toggle.textContent).toBe('Show')
    toggle.click()
    expect(inputs[1]!.type).toBe('text')
    expect(toggle.textContent).toBe('Hide')
    ;(overlay.querySelector('.edi-dialog-actions .toolbar-btn') as HTMLButtonElement).click()
    await expect(p).resolves.toBeNull()
  })
})

describe('promptForNewPassword blank guard', () => {
  async function openBlankPrompt() {
    const p = promptForNewPassword('field', {})
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlays = document.querySelectorAll<HTMLElement>('.edi-dialog-overlay')
    const first = overlays[0]!
    const inputs = first.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    inputs[0]!.value = ''
    inputs[1]!.value = ''
    ;(first.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.edi-dialog-overlay').length).toBe(2)
    })
    return { p, first, inputs }
  }

  it('warns on a blank password and defaults to a real one; yes only on explicit opt-in', async () => {
    const { p, first, inputs } = await openBlankPrompt()
    const warn = document.querySelectorAll<HTMLElement>('.edi-dialog-overlay')[1]!
    expect(warn.textContent?.toLowerCase()).toContain('blank password')
    const safe = [...warn.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Set a real password')!
    expect(document.activeElement).toBe(safe)
    safe.click()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.edi-dialog-overlay').length).toBe(1)
    })
    expect(await Promise.race([p, Promise.resolve('pending')])).toBe('pending')

    inputs[0]!.value = ''
    inputs[1]!.value = ''
    ;(first.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.edi-dialog-overlay').length).toBe(2)
    })
    const warn2 = document.querySelectorAll<HTMLElement>('.edi-dialog-overlay')[1]!
    const useBlank = [...warn2.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Use blank password')!
    expect(useBlank.className).toContain('toolbar-danger')
    useBlank.click()
    await expect(p).resolves.toBe('')
  })

  it('lets the user type a real password after the warning', async () => {
    const { p, first, inputs } = await openBlankPrompt()
    const warn = document.querySelectorAll<HTMLElement>('.edi-dialog-overlay')[1]!
    ;[...warn.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Set a real password')!.click()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.edi-dialog-overlay').length).toBe(1)
    })
    inputs[0]!.value = 'hunter2'
    inputs[1]!.value = 'hunter2'
    ;(first.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toBe('hunter2')
  })
})

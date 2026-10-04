import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promptForNewPassword, promptForSecretCreate, promptForEncryptedBlockLabel } from './crypto-dialog'

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

describe('promptForSecretCreate', () => {
  it('focuses the label field and masks the secret value, even with a prefill', async () => {
    const p = promptForSecretCreate('prefill')
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

  it('resolves hidden when Lock immediately is checked (default), unlocked when unchecked', async () => {
    const p = promptForSecretCreate()
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay = document.querySelector('.edi-dialog-overlay') as HTMLElement
    const inputs = overlay.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    const lock = overlay.querySelector<HTMLInputElement>('#edi-masked-show-immediately')!
    expect(lock.checked).toBe(true)
    expect(overlay.textContent).toContain('Lock immediately')
    inputs[0]!.value = 'API Key'
    inputs[1]!.value = 'hunter2'
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toEqual({ label: 'API Key', value: 'hunter2', showValueInitially: false })

    const p2 = promptForSecretCreate()
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay2 = document.querySelector('.edi-dialog-overlay') as HTMLElement
    const inputs2 = overlay2.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    const lock2 = overlay2.querySelector<HTMLInputElement>('#edi-masked-show-immediately')!
    lock2.click()
    expect(lock2.checked).toBe(false)
    inputs2[0]!.value = 'Token'
    inputs2[1]!.value = 'abc'
    ;(overlay2.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p2).resolves.toEqual({ label: 'Token', value: 'abc', showValueInitially: true })
  })
})

describe('promptForEncryptedBlockLabel', () => {
  it('offers Lock immediately, unchecked by default, and resolves the label', async () => {
    const p = promptForEncryptedBlockLabel('code_block')
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay = document.querySelector('.edi-dialog-overlay') as HTMLElement
    const lock = overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(lock.checked).toBe(false)
    expect(overlay.textContent).toContain('Lock immediately')
    const input = overlay.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.value = 'API keys table'
    ;(overlay.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p).resolves.toEqual({ label: 'API keys table', lockImmediately: false })

    const p2 = promptForEncryptedBlockLabel('code_block')
    await vi.waitFor(() => {
      expect(document.querySelector('.edi-dialog-overlay')).toBeTruthy()
    })
    const overlay2 = document.querySelector('.edi-dialog-overlay') as HTMLElement
    overlay2.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    ;(overlay2.querySelector('.toolbar-primary') as HTMLButtonElement).click()
    await expect(p2).resolves.toEqual({ label: '', lockImmediately: true })
  })
})

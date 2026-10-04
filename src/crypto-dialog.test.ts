import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promptForNewPassword } from './crypto-dialog'

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

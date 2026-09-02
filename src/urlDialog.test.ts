import { describe, it, expect, afterEach } from 'vitest'
import { promptForUrl } from './urlDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('promptForUrl', () => {
  it('resolves with the entered URL on Insert', async () => {
    const promise = promptForUrl('')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.value = 'https://example.com'
    const insert = document.querySelector<HTMLButtonElement>('.fmt-primary')!
    insert.click()
    await expect(promise).resolves.toBe('https://example.com')
  })

  it('resolves with the entered URL on Enter', async () => {
    const promise = promptForUrl('')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.value = 'example.org'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect(promise).resolves.toBe('example.org')
  })

  it('resolves with null on Cancel', async () => {
    const promise = promptForUrl('')
    const cancel = document.querySelectorAll<HTMLButtonElement>('.edi-dialog-actions button')[0]!
    cancel.click()
    await expect(promise).resolves.toBeNull()
  })

  it('resolves with null on Escape', async () => {
    const promise = promptForUrl('')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(promise).resolves.toBeNull()
  })

  it('prefills the existing URL and removes the overlay after resolving', async () => {
    const promise = promptForUrl('https://oldsite.com')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    expect(input.value).toBe('https://oldsite.com')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await promise
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })
})

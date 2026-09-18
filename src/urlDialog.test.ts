import { describe, it, expect, afterEach } from 'vitest'
import { promptForLink } from './urlDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('promptForLink', () => {
  it('hides the link-text field when link text exists', () => {
    const promise = promptForLink('selected', 'https://oldsite.com')
    const inputs = document.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    expect(inputs.length).toBe(1)
    expect(inputs[0]!.value).toBe('https://oldsite.com')
    void promise
  })

  it('asks for link text defaulted to the URL when there is no link text', () => {
    const promise = promptForLink('', 'https://oldsite.com')
    const inputs = document.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    expect(inputs.length).toBe(2)
    expect(inputs[0]!.value).toBe('https://oldsite.com')
    expect(inputs[1]!.value).toBe('https://oldsite.com')
    void promise
  })

  it('resolves with the link text and URL on Insert', async () => {
    const promise = promptForLink('', '')
    const inputs = document.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    inputs[0]!.value = 'https://example.com'
    inputs[1]!.value = 'My site'
    document.querySelector<HTMLButtonElement>('.fmt-primary')!.click()
    await expect(promise).resolves.toEqual({ text: 'My site', url: 'https://example.com' })
  })

  it('resolves with empty text when the text field is hidden', async () => {
    const promise = promptForLink('selected', 'https://oldsite.com')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.value = 'https://new.example'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect(promise).resolves.toEqual({ text: '', url: 'https://new.example' })
  })

  it('resolves with the entered URL on Enter', async () => {
    const promise = promptForLink('', '')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.value = 'example.org'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect(promise).resolves.toEqual({ text: '', url: 'example.org' })
  })

  it('resolves with null on Cancel', async () => {
    const promise = promptForLink('', '')
    const cancel = document.querySelectorAll<HTMLButtonElement>('.edi-dialog-actions button')[0]!
    cancel.click()
    await expect(promise).resolves.toBeNull()
  })

  it('resolves with null on Escape', async () => {
    const promise = promptForLink('', '')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(promise).resolves.toBeNull()
  })

  it('removes the overlay after resolving', async () => {
    const promise = promptForLink('', '')
    const input = document.querySelector<HTMLInputElement>('.edi-dialog-input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await promise
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })
})
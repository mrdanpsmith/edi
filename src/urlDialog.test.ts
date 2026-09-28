import { describe, it, expect, afterEach } from 'vitest'
import { promptForKanbanColumns, promptForLink } from './urlDialog'

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
    document.querySelector<HTMLButtonElement>('.toolbar-primary')!.click()
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

describe('promptForKanbanColumns', () => {
  function textarea(): HTMLTextAreaElement {
    return document.querySelector<HTMLTextAreaElement>('.edi-dialog-input')!
  }

  function add(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>('.toolbar-primary')!
  }

  function cancel(): HTMLButtonElement {
    return document.querySelectorAll<HTMLButtonElement>('.edi-dialog-actions button')[0]!
  }

  function ctrlEnter(el: HTMLElement): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  }

  it('asks for the columns on a prefilled line per column', () => {
    const promise = promptForKanbanColumns()
    expect(document.querySelector('.edi-dialog-title')?.textContent).toBe('New kanban board')
    expect(textarea().value.split('\n')).toEqual(['Todo', 'In Progress', 'Review', 'Done'])
    expect(textarea().tagName).toBe('TEXTAREA')
    void promise
  })

  it('resolves the parsed column list on Add', async () => {
    const promise = promptForKanbanColumns()
    textarea().value = 'Backlog\n  In Progress  \n\nDone'
    add().click()
    await expect(promise).resolves.toEqual(['Backlog', 'In Progress', 'Done'])
  })

  it('resolves the parsed column list on Ctrl+Enter', async () => {
    const promise = promptForKanbanColumns()
    textarea().value = 'Todo\nDone'
    ctrlEnter(textarea())
    await expect(promise).resolves.toEqual(['Todo', 'Done'])
  })

  // Enter is a newline here: it is how a second column gets typed at all, so it
  // must not resolve the dialog on the way.
  it('leaves Enter to add a column', () => {
    promptForKanbanColumns()
    const field = textarea()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    field.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('.edi-dialog-overlay')).not.toBeNull()
  })

  it('reports an empty field instead of resolving an empty board', async () => {
    const promise = promptForKanbanColumns()
    textarea().value = '  \n\n'
    add().click()
    const error = document.querySelector<HTMLElement>('.edi-dialog-error')!
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe('A board needs at least one column')
    expect(document.querySelector('.edi-dialog-overlay')).not.toBeNull()

    // ...and it goes through once there is something to insert.
    textarea().value = 'Todo'
    add().click()
    await expect(promise).resolves.toEqual(['Todo'])
  })

  it('keeps repeated names: de-duplicating them is the builder’s job', async () => {
    const promise = promptForKanbanColumns()
    textarea().value = 'Doing\nDoing'
    add().click()
    await expect(promise).resolves.toEqual(['Doing', 'Doing'])
  })

  it('resolves with null on Cancel, on Escape and on a backdrop click', async () => {
    const byCancel = promptForKanbanColumns()
    cancel().click()
    await expect(byCancel).resolves.toBeNull()

    const byEscape = promptForKanbanColumns()
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(byEscape).resolves.toBeNull()

    const byBackdrop = promptForKanbanColumns()
    document.querySelector<HTMLElement>('.edi-dialog-overlay')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    )
    await expect(byBackdrop).resolves.toBeNull()
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })
})
import { describe, it, expect, afterEach } from 'vitest'
import {
  promptForKanbanColumns,
  promptForKanbanDelete,
  promptForLink,
  promptForRename,
} from './urlDialog'

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

  it('says it is editing when asked to, and still edits only the URL', async () => {
    const promise = promptForLink('notes', 'https://oldsite.com', { editing: true })
    expect(document.querySelector('.edi-dialog-title')!.textContent).toBe('Edit link')
    expect(document.querySelector('.toolbar-primary')!.textContent).toBe('Update')
    expect(document.querySelectorAll('.edi-dialog-input')).toHaveLength(1)
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

describe('promptForKanbanDelete', () => {
  function actions(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-dialog-actions button'))
  }

  it('names what goes, and what goes with it', () => {
    const promise = promptForKanbanDelete('the In review column', 'Its 2 cards go with it.')
    expect(document.querySelector('.edi-dialog-title')?.textContent).toBe('Delete the In review column?')
    const note = document.querySelector('.edi-dialog-note')?.textContent
    expect(note).toContain('Its 2 cards go with it.')
    // Undo is the way back from the wrong answer, so the prompt says so.
    expect(note).toContain('undo')
    void promise
  })

  it('leaves out the consequence when there is none to add', () => {
    const promise = promptForKanbanDelete('“Fix the bug”')
    expect(document.querySelector('.edi-dialog-note')?.textContent).toBe(
      'The diagram is one edit, so undo brings it back.',
    )
    void promise
  })

  it('resolves true only on Delete', async () => {
    const confirmed = promptForKanbanDelete('“One”')
    actions()[1]!.click()
    await expect(confirmed).resolves.toBe(true)
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })

  it('resolves false on Cancel, on Escape and on a backdrop click', async () => {
    const byCancel = promptForKanbanDelete('“One”')
    actions()[0]!.click()
    await expect(byCancel).resolves.toBe(false)

    const byEscape = promptForKanbanDelete('“One”')
    document.querySelector<HTMLElement>('.edi-dialog')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await expect(byEscape).resolves.toBe(false)

    const byBackdrop = promptForKanbanDelete('“One”')
    document.querySelector<HTMLElement>('.edi-dialog-overlay')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    )
    await expect(byBackdrop).resolves.toBe(false)
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })
})

describe('promptForRename', () => {
  function field(): HTMLInputElement {
    return document.querySelector<HTMLInputElement>('.edi-dialog-input')!
  }

  function rename(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>('.toolbar-primary')!
  }

  function error(): HTMLElement {
    return document.querySelector<HTMLElement>('.edi-dialog-error')!
  }

  it('asks for a new name, pre-filled with the current one', () => {
    const promise = promptForRename('notes.md')
    expect(document.querySelector('.edi-dialog-title')?.textContent).toBe('Rename document')
    expect(field().value).toBe('notes.md')
    void promise
  })

  // The stem is what a rename changes, so it is what the field selects: typing
  // replaces the name and leaves the extension (and the format) alone.
  it('selects the name, not the extension', () => {
    const withExtension = promptForRename('notes.markdown')
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 5])
    document.body.innerHTML = ''

    const withoutExtension = promptForRename('notes')
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 5])
    void withExtension
    void withoutExtension
  })

  it('resolves the typed name on Rename', async () => {
    const promise = promptForRename('notes.md')
    field().value = '  ideas.md  '
    rename().click()
    await expect(promise).resolves.toBe('ideas.md')
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })

  it('resolves with null on Cancel, on Escape and on a backdrop click', async () => {
    const byCancel = promptForRename('notes.md')
    document.querySelectorAll<HTMLButtonElement>('.edi-dialog-actions button')[0]!.click()
    await expect(byCancel).resolves.toBeNull()

    const byEscape = promptForRename('notes.md')
    document.querySelector<HTMLElement>('.edi-dialog')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await expect(byEscape).resolves.toBeNull()

    const byBackdrop = promptForRename('notes.md')
    document.querySelector<HTMLElement>('.edi-dialog-overlay')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    )
    await expect(byBackdrop).resolves.toBeNull()
  })

  // A rename deletes the old file, so a name that names nothing, names a path,
  // or names the document itself is reported rather than acted on.
  it('reports a name it cannot act on and stays open', async () => {
    const promise = promptForRename('notes.md')

    field().value = '   '
    rename().click()
    expect(error().textContent).toBe('Enter a name for the document')

    field().value = 'archive/notes.md'
    rename().click()
    expect(error().textContent).toBe('A document name is one file name, not a path')

    field().value = 'archive\\notes.md'
    rename().click()
    expect(error().textContent).toBe('A document name is one file name, not a path')

    field().value = '..'
    rename().click()
    expect(error().textContent).toBe('A document name is one file name, not a path')

    field().value = 'notes.md'
    rename().click()
    expect(error().textContent).toBe('That is the document’s current name')

    expect(document.querySelector('.edi-dialog-overlay')).not.toBeNull()
    expect(error().hidden).toBe(false)

    field().value = 'ideas.md'
    rename().click()
    await expect(promise).resolves.toBe('ideas.md')
  })

  it('confirms with Enter', async () => {
    const promise = promptForRename('notes.md')
    field().value = 'ideas.md'
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect(promise).resolves.toBe('ideas.md')
  })
})

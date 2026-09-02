import { describe, it, expect, beforeEach } from 'vitest'
import { createBlockEditor } from './editor'

beforeEach(() => {
  document.body.innerHTML = ''
})

function fakeMouseEvent(): MouseEvent {
  return { preventDefault: () => {} } as unknown as MouseEvent
}

describe('createBlockEditor link clicks', () => {
  it('invokes onOpenLink with the href and text when clicking inside a link', () => {
    const opened: Array<{ href: string; text: string }> = []
    const editor = createBlockEditor(document.body, 'See [notes](other.md) here', {
      onOpenLink: (href, text) => opened.push({ href, text }),
    })
    const view = editor.getView()
    const inside = view.state.doc.textContent.indexOf('notes') + 2
    let handled = false
    view.someProp('handleClick', (fn) => {
      handled = fn(view, inside, fakeMouseEvent()) === true
    })
    expect(handled).toBe(true)
    expect(opened).toEqual([{ href: 'other.md', text: 'notes' }])
  })

  it('does not open when clicking plain text', () => {
    const called: unknown[] = []
    const editor = createBlockEditor(document.body, 'just plain text', {
      onOpenLink: (...args) => called.push(args),
    })
    const view = editor.getView()
    view.someProp('handleClick', (fn) => fn(view, 2, fakeMouseEvent()))
    expect(called).toEqual([])
  })

  it('does not open when clicking at the trailing boundary of a link', () => {
    const called: unknown[] = []
    const editor = createBlockEditor(document.body, 'See [notes](other.md) here', {
      onOpenLink: (...args) => called.push(args),
    })
    const view = editor.getView()
    const doc = view.state.doc
    // link text "notes" spans doc positions 5..10; position 10 is the
    // boundary right after the last character ('s' at position 9).
    const endBoundary = doc.textContent.indexOf('notes') + 'notes'.length + 1
    let handled = false
    view.someProp('handleClick', (fn) => {
      handled = fn(view, endBoundary, fakeMouseEvent()) === true
    })
    expect(handled).toBe(false)
    expect(called).toEqual([])
  })

  it('opens when clicking on the last character of a link', () => {
    const called: Array<{ href: string; text: string }> = []
    const editor = createBlockEditor(document.body, 'See [notes](other.md) here', {
      onOpenLink: (href, text) => called.push({ href, text }),
    })
    const view = editor.getView()
    const doc = view.state.doc
    // position of the last link character ('s' in "notes")
    const lastChar = doc.textContent.indexOf('notes') + 'notes'.length
    let handled = false
    view.someProp('handleClick', (fn) => {
      handled = fn(view, lastChar, fakeMouseEvent()) === true
    })
    expect(handled).toBe(true)
    expect(called).toEqual([{ href: 'other.md', text: 'notes' }])
  })
})

describe('misleading link highlighting', () => {
  it('marks a link whose text and href point to different hosts as misleading', () => {
    const editor = createBlockEditor(
      document.body,
      'Go to [https://www.google.com](https://attacker.address) now',
    )
    const view = editor.getView()
    const misleading = view.dom.querySelector<HTMLElement>('a .ml-misleading')
    expect(misleading).not.toBeNull()
    expect(misleading!.closest('a')!.getAttribute('href')).toBe('https://attacker.address')
    // The whole link text should be highlighted, not just the first character.
    expect(misleading!.textContent).toBe('https://www.google.com')
  })

  it('marks a filename link whose basename differs from the href as misleading', () => {
    const editor = createBlockEditor(document.body, 'See [README.md](ATTACKER.md) here')
    const view = editor.getView()
    expect(view.dom.querySelector('a .ml-misleading')).not.toBeNull()
  })

  it('does not mark a trusted link as misleading', () => {
    const editor = createBlockEditor(
      document.body,
      '[https://example.com](https://example.com) and [read](https://example.com) text',
    )
    const view = editor.getView()
    expect(view.dom.querySelector('a .ml-misleading')).toBeNull()
  })
})

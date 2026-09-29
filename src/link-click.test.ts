import { describe, it, expect, beforeEach } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { createBlockEditor, linkRangeAt } from './editor'
import { schema } from './schema'
import { markdownToProse } from './markdown'

beforeEach(() => {
  document.body.innerHTML = ''
})

function fakeMouseEvent(button = 0): MouseEvent {
  return { button, preventDefault: () => {} } as unknown as MouseEvent
}

/** An editor over one link, and the record of every `onOpenLink` it fired. */
function linkEditor(
  markdown = 'See [notes](other.md) here',
): { view: EditorView; opened: Array<{ href: string; text: string }> } {
  const opened: Array<{ href: string; text: string }> = []
  const editor = createBlockEditor(document.body, markdown, {
    onOpenLink: (href, text) => opened.push({ href, text }),
  })
  return { view: editor.getView(), opened }
}

/** A document position inside the link text, two characters in. */
function insideLink(view: EditorView): number {
  return view.state.doc.textContent.indexOf('notes') + 2
}

describe('createBlockEditor link clicks', () => {
  it('invokes onOpenLink with the href and text when clicking inside a link', () => {
    const { view, opened } = linkEditor()
    let handled = false
    view.someProp('handleClick', (fn) => {
      handled = fn(view, insideLink(view), fakeMouseEvent()) === true
    })
    expect(handled).toBe(true)
    expect(opened).toEqual([{ href: 'other.md', text: 'notes' }])
  })

  it('leaves a right-click to the context menu instead of opening the link', () => {
    // ProseMirror hands every button's click to `handleClick`, so the plugin
    // has to turn the right-click away itself: a link that opened on
    // right-click could not also be edited from the context menu.
    const { view, opened } = linkEditor()
    let handled = true
    view.someProp('handleClick', (fn) => {
      handled = fn(view, insideLink(view), fakeMouseEvent(2)) === true
    })
    expect(handled).toBe(false)
    expect(opened).toEqual([])
  })

  it('leaves a middle click to the browser, which opens the <a> in a new tab', () => {
    const { view, opened } = linkEditor()
    view.someProp('handleClick', (fn) => fn(view, insideLink(view), fakeMouseEvent(1)))
    expect(opened).toEqual([])
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

describe('linkRangeAt', () => {
  const docOf = (markdown: string) => markdownToProse(markdown, schema)

  it('reports the range, href and text of the link at a position', () => {
    const doc = docOf('See [notes](other.md) here')
    const range = linkRangeAt(doc, doc.textContent.indexOf('notes') + 1)
    expect(range).not.toBeNull()
    expect(doc.textBetween(range!.from, range!.to)).toBe('notes')
    expect(range!.href).toBe('other.md')
  })

  it('covers a label that emphasis split into several text nodes', () => {
    const doc = docOf('See [read *the* docs](guide.md) now')
    const start = doc.textContent.indexOf('read') + 1
    // The click lands in the middle piece, which is the case a single text
    // node cannot answer.
    const range = linkRangeAt(doc, start + 'read '.length + 1)
    expect(doc.textBetween(range!.from, range!.to)).toBe('read the docs')
  })

  it('reports only the clicked link, not every link to the same place', () => {
    const doc = docOf('[README.md](README.md) and again [README.md](README.md)')
    const first = linkRangeAt(doc, doc.textContent.indexOf('README.md') + 1)
    const secondStart = doc.textContent.lastIndexOf('README.md') + 1
    const second = linkRangeAt(doc, secondStart)
    expect(first!.from).toBeLessThan(second!.from)
    expect(doc.textBetween(second!.from, second!.to)).toBe('README.md')
  })

  it('returns null for plain text and for the boundary after a link', () => {
    const doc = docOf('See [notes](other.md) here')
    expect(linkRangeAt(doc, 1)).toBeNull()
    const endBoundary = doc.textContent.indexOf('notes') + 'notes'.length + 1
    expect(linkRangeAt(doc, endBoundary)).toBeNull()
  })
})

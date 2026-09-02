import { describe, it, expect, beforeEach } from 'vitest'
import { createBlockEditor } from './editor'

beforeEach(() => {
  document.body.innerHTML = ''
})

function fakeMouseEvent(): MouseEvent {
  return { preventDefault: () => {} } as unknown as MouseEvent
}

describe('createBlockEditor link clicks', () => {
  it('invokes onOpenLink with the href when clicking inside a link', () => {
    const opened: string[] = []
    const editor = createBlockEditor(document.body, 'See [notes](other.md) here', {
      onOpenLink: (href) => opened.push(href),
    })
    const view = editor.getView()
    const inside = view.state.doc.textContent.indexOf('notes') + 2
    let handled = false
    view.someProp('handleClick', (fn) => {
      handled = fn(view, inside, fakeMouseEvent()) === true
    })
    expect(handled).toBe(true)
    expect(opened).toEqual(['other.md'])
  })

  it('does not open when clicking plain text', () => {
    const opened: string[] = []
    const editor = createBlockEditor(document.body, 'just plain text', {
      onOpenLink: (href) => opened.push(href),
    })
    const view = editor.getView()
    view.someProp('handleClick', (fn) => fn(view, 2, fakeMouseEvent()))
    expect(opened).toEqual([])
  })
})

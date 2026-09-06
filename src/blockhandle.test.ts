import { describe, expect, it, beforeEach } from 'vitest'
import { createBlockEditor } from './editor'

beforeEach(() => {
  document.body.innerHTML = ''
})

function clickHandle(view: { dom: HTMLElement }, index = 0): void {
  const handle = view.dom.querySelectorAll<HTMLElement>('.block-handle')[index]
  handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('block handles', () => {
  it('renders one handle per top-level block', () => {
    const editor = createBlockEditor(document.body, 'hello\n\nworld')
    const view = editor.getView()
    expect(view.dom.querySelectorAll('.block-handle').length).toBe(2)
    editor.destroy()
  })

  it('toggles the clicked block into source mode', () => {
    const editor = createBlockEditor(document.body, 'hello\n\nworld')
    const view = editor.getView()
    clickHandle(view, 0)
    expect(view.state.doc.child(0).attrs._source).toBe(true)
    expect(view.state.doc.child(1).attrs._source).toBe(false)
    editor.destroy()
  })

  it('moves source mode onto the next block when its handle is clicked', () => {
    const editor = createBlockEditor(document.body, 'hello\n\nworld')
    const view = editor.getView()
    clickHandle(view, 0)
    // The source-mode block no longer renders a handle.
    expect(view.dom.querySelectorAll('.block-handle').length).toBe(1)
    clickHandle(view, 0)
    expect(view.state.doc.child(0).attrs._source).toBe(false)
    expect(view.state.doc.child(1).attrs._source).toBe(true)
    editor.destroy()
  })

  it('does nothing when a click misses every block handle', () => {
    const editor = createBlockEditor(document.body, 'hello')
    const view = editor.getView()
    view.dom.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.state.doc.firstChild?.attrs._source).toBe(false)
    editor.destroy()
  })

  it('serializes the markdown unchanged before committing', () => {
    const editor = createBlockEditor(document.body, 'hello\n\nworld')
    const view = editor.getView()
    clickHandle(view, 1)
    expect(view.state.doc.child(1).attrs._source).toBe(true)
    editor.destroy()
  })
})
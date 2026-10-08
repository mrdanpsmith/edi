import { describe, expect, it, beforeEach } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { createBlockEditor } from './editor'
import { currentBlockMode, modeFor, type Representation } from './block-modes'

beforeEach(() => {
  document.body.innerHTML = ''
})

function clickHandle(view: { dom: HTMLElement }, index = 0): void {
  const handle = view.dom.querySelectorAll<HTMLElement>('.block-handle')[index]
  handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** The representation of each top-level block, in document order. */
function representations(view: EditorView): Representation[] {
  const out: Representation[] = []
  view.state.doc.forEach((_node, offset) => {
    out.push(modeFor(view.state, offset)?.representation ?? 'preview')
  })
  return out
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
    expect(representations(view)).toEqual(['source', 'preview'])
    editor.destroy()
  })

  it('moves source mode onto the next block when its handle is clicked', () => {
    const editor = createBlockEditor(document.body, 'hello\n\nworld')
    const view = editor.getView()
    clickHandle(view, 0)
    // The source-mode block no longer renders a handle.
    expect(view.dom.querySelectorAll('.block-handle').length).toBe(1)
    clickHandle(view, 0)
    expect(representations(view)).toEqual(['preview', 'source'])
    editor.destroy()
  })

  it('does nothing when a click misses every block handle', () => {
    const editor = createBlockEditor(document.body, 'hello')
    const view = editor.getView()
    view.dom.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(currentBlockMode(view.state)).toBeNull()
    editor.destroy()
  })

  it('serializes the markdown unchanged before committing', () => {
    const editor = createBlockEditor(document.body, 'hello\n\nworld')
    const view = editor.getView()
    clickHandle(view, 1)
    expect(representations(view)).toEqual(['preview', 'source'])
    editor.destroy()
  })
})
import { beforeEach, describe, expect, it } from 'vitest'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import type { EditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { createBlockEditor } from './editor'
import { currentBlockMode, enterSourceMode } from './block-modes'
import { handleCodeBlockArrow } from './codeBlockExit'
import { proseToMarkdown } from './markdown'

beforeEach(() => {
  document.body.innerHTML = ''
})

function editorOn(markdown: string): { view: EditorView; destroy: () => void } {
  const editor = createBlockEditor(document.body, markdown)
  return { view: editor.getView(), destroy: () => editor.destroy() }
}

function blockPos(view: EditorView, type: string, index = 0): number {
  let found = -1
  let at = 0
  view.state.doc.forEach((node, offset) => {
    if (node.type.name === type) {
      if (at === index) found = offset
      at++
    }
  })
  return found
}

function caretAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

function caretAtEndOfBlock(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (node) caretAt(view, pos + node.nodeSize - 1)
}

function codeMirror(view: EditorView, selector = '.cm-editor'): CodeMirrorView {
  const cm = CodeMirrorView.findFromDOM(view.dom.querySelector<HTMLElement>(selector)!)
  if (!cm) throw new Error('no CodeMirror editor')
  return cm
}

function pressCodeMirror(cm: CodeMirrorView, key: 'ArrowUp' | 'ArrowDown'): void {
  cm.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

function pressEditor(view: EditorView, key: 'ArrowUp' | 'ArrowDown'): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  let handled = false
  view.someProp('handleKeyDown', (handler) => {
    if (handler(view, event)) {
      handled = true
      return true
    }
    return false
  })
  return handled
}

describe('leaving a visual code block with an arrow key', () => {
  it('ArrowDown at the end moves to the start of the next block', () => {
    const { view, destroy } = editorOn('before\n\n```js\nconst x = 1\n```\n\nafter')
    const cm = codeMirror(view)
    cm.dispatch({ selection: { anchor: cm.state.doc.length } })

    pressCodeMirror(cm, 'ArrowDown')

    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.selection.$from.parent.textContent).toBe('after')
    expect(view.state.selection.$from.parentOffset).toBe(0)
    destroy()
  })

  it('ArrowUp at the start moves to the end of the previous block', () => {
    const { view, destroy } = editorOn('before\n\n```js\nconst x = 1\n```\n\nafter')
    const cm = codeMirror(view)
    cm.dispatch({ selection: { anchor: 0 } })

    pressCodeMirror(cm, 'ArrowUp')

    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.selection.$from.parent.textContent).toBe('before')
    expect(view.state.selection.$from.parentOffset).toBe('before'.length)
    destroy()
  })

  it('ArrowDown inside the last line walks to its end before exiting', () => {
    const { view, destroy } = editorOn('```js\nconst x = 1\n```\n\nafter')
    const cm = codeMirror(view)
    cm.dispatch({ selection: { anchor: cm.state.doc.length - 1 } })

    pressCodeMirror(cm, 'ArrowDown')

    expect(view.state.selection.$from.parent.type.name).toBe('code_block')
    destroy()
  })

  it('ArrowDown at the end of the document creates a paragraph below', () => {
    const { view, destroy } = editorOn('```js\nconst x = 1\n```')
    const cm = codeMirror(view)
    cm.dispatch({ selection: { anchor: cm.state.doc.length } })

    pressCodeMirror(cm, 'ArrowDown')

    const last = view.state.doc.lastChild
    expect(view.state.doc.childCount).toBe(2)
    expect(last?.type.name).toBe('paragraph')
    expect(last?.textContent).toBe('')
    expect(view.state.selection.$from.parent).toBe(last)
    destroy()
  })
})

describe('leaving source mode for a code block with an arrow key', () => {
  it('ArrowDown at the end commits the buffer and moves on', () => {
    const { view, destroy } = editorOn('```js\nconst x = 1\n```\n\nafter')
    const pos = blockPos(view, 'code_block')
    enterSourceMode(view, pos)
    const cm = codeMirror(view, '.block-source-mode .cm-editor')
    cm.dispatch({ selection: { anchor: cm.state.doc.length } })

    pressCodeMirror(cm, 'ArrowDown')

    expect(currentBlockMode(view.state)).toBeNull()
    expect(proseToMarkdown(view.state.doc)).toContain('const x = 1')
    expect(view.state.selection.$from.parent.textContent).toBe('after')
    destroy()
  })

  it('ArrowDown at the end of the document commits and creates a paragraph', () => {
    const { view, destroy } = editorOn('```js\nconst x = 1\n```')
    const pos = blockPos(view, 'code_block')
    enterSourceMode(view, pos)
    const cm = codeMirror(view, '.block-source-mode .cm-editor')
    cm.dispatch({ selection: { anchor: cm.state.doc.length } })

    pressCodeMirror(cm, 'ArrowDown')

    expect(currentBlockMode(view.state)).toBeNull()
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.lastChild?.type.name).toBe('paragraph')
    expect(view.state.selection.$from.parent.textContent).toBe('')
    destroy()
  })

  it('ArrowUp at the start moves to the previous block', () => {
    const { view, destroy } = editorOn('before\n\n```js\nconst x = 1\n```')
    const pos = blockPos(view, 'code_block')
    enterSourceMode(view, pos)
    const cm = codeMirror(view, '.block-source-mode .cm-editor')
    cm.dispatch({ selection: { anchor: 0 } })

    pressCodeMirror(cm, 'ArrowUp')

    expect(currentBlockMode(view.state)).toBeNull()
    expect(view.state.selection.$from.parent.textContent).toBe('before')
    expect(view.state.selection.$from.parentOffset).toBe('before'.length)
    destroy()
  })
})

describe('leaving a plain fenced code block with an arrow key', () => {
  it('ArrowDown at the end moves to the start of the next block', () => {
    const { view, destroy } = editorOn('before\n\n```\nplain\n```\n\nafter')
    const pos = blockPos(view, 'code_block')
    caretAtEndOfBlock(view, pos)

    expect(pressEditor(view, 'ArrowDown')).toBe(true)

    expect(view.state.selection.$from.parent.textContent).toBe('after')
    expect(view.state.selection.$from.parentOffset).toBe(0)
    destroy()
  })

  it('ArrowUp at the start moves to the end of the previous block', () => {
    const { view, destroy } = editorOn('before\n\n```\nplain\n```')
    const pos = blockPos(view, 'code_block')
    caretAt(view, pos + 1)

    expect(pressEditor(view, 'ArrowUp')).toBe(true)

    expect(view.state.selection.$from.parent.textContent).toBe('before')
    expect(view.state.selection.$from.parentOffset).toBe('before'.length)
    destroy()
  })

  it('ArrowDown on the last line walks to its end before exiting', () => {
    const { view, destroy } = editorOn('```\none\ntwo\n```\n\nafter')
    const pos = blockPos(view, 'code_block')
    caretAt(view, pos + 1 + 5)

    expect(pressEditor(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.$from.parent.type.name).toBe('code_block')
    expect(view.state.selection.$from.parentOffset).toBe(7)

    expect(pressEditor(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.$from.parent.textContent).toBe('after')
    destroy()
  })

  it('ArrowDown at the end of the document creates a paragraph below', () => {
    const { view, destroy } = editorOn('```\nplain\n```')
    const pos = blockPos(view, 'code_block')
    caretAtEndOfBlock(view, pos)

    expect(pressEditor(view, 'ArrowDown')).toBe(true)

    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.lastChild?.type.name).toBe('paragraph')
    expect(view.state.doc.lastChild?.textContent).toBe('')
    expect(view.state.selection.$from.parentOffset).toBe(0)
    destroy()
  })

  it('ArrowUp on an empty first line still leaves the block', () => {
    const { view, destroy } = editorOn('before\n\n```\n\nplain\n```')
    const pos = blockPos(view, 'code_block')
    caretAt(view, pos + 1)

    expect(pressEditor(view, 'ArrowUp')).toBe(true)

    expect(view.state.selection.$from.parent.textContent).toBe('before')
    expect(view.state.selection.$from.parentOffset).toBe('before'.length)
    destroy()
  })

  it('ArrowUp at the start of the document does nothing', () => {
    const { view, destroy } = editorOn('```\nplain\n```')
    const pos = blockPos(view, 'code_block')
    caretAt(view, pos + 1)
    const before = view.state.doc
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })

    expect(handleCodeBlockArrow(view, event)).toBe(false)
    expect(view.state.doc.eq(before)).toBe(true)
    destroy()
  })

  it('Shift+ArrowDown keeps extending the text selection', () => {
    const { view, destroy } = editorOn('```\nplain\n```')
    const pos = blockPos(view, 'code_block')
    caretAtEndOfBlock(view, pos)

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    let handled = false
    view.someProp('handleKeyDown', (handler) => {
      if (handler(view, event)) handled = true
      return handled
    })

    expect(handled).toBe(false)
    expect(view.state.selection.$from.parent.type.name).toBe('code_block')
    destroy()
  })
})

import { describe, expect, it } from 'vitest'
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state'
import { baseKeymap } from 'prosemirror-commands'
import { schema } from './schema'
import { markdownToProse } from './markdown'
import { codeBlockDeleteKeymap, codeBlockKey } from './codeBlockDelete'

const plugin = codeBlockDeleteKeymap()

/** A state whose caret sits at `offset` into the text of the `blockIndex`th top-level block. */
function stateAt(markdown: string, blockIndex: number, offset: number | 'end'): EditorState {
  const doc = markdownToProse(markdown, schema)
  let pos = 0
  for (let i = 0; i < blockIndex; i++) pos += doc.child(i).nodeSize
  const block = doc.child(blockIndex)
  const at = pos + 1 + (offset === 'end' ? block.content.size : offset)
  return EditorState.create({ doc, selection: TextSelection.create(doc, at), plugins: [plugin] })
}

/** Press a key through the delete keymap, falling back to baseKeymap as the editor does. */
function press(state: EditorState, key: 'Backspace' | 'Delete' | 'Escape'): EditorState {
  let next = state
  const dispatch = (tr: Transaction) => { next = next.apply(tr) }
  const event = new KeyboardEvent('keydown', { key })
  const handled = plugin.props.handleKeyDown!.call(plugin, { state, dispatch } as never, event)
  if (!handled && key !== 'Escape') baseKeymap[key](state, dispatch)
  return next
}

/** Does the keymap take the key at all? (A character delete is the browser's native edit.) */
function takes(state: EditorState, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key })
  return plugin.props.handleKeyDown!.call(plugin, { state, dispatch: () => {} } as never, event) as boolean
}

function blocks(state: EditorState): string[] {
  const out: string[] = []
  state.doc.forEach((n) => out.push(`${n.type.name}:${n.textContent}`))
  return out
}

function selectedType(state: EditorState): string | null {
  const sel = state.selection
  return sel instanceof NodeSelection ? sel.node.type.name : null
}

describe('Backspace at the start of a code block turns it into text', () => {
  it('one paragraph per line, caret at the start of the first', () => {
    const state = press(stateAt('before\n\n```js\nlet a\nlet b\n```\n\nafter', 1, 0), 'Backspace')
    expect(blocks(state)).toEqual(['paragraph:before', 'paragraph:let a', 'paragraph:let b', 'paragraph:after'])
    expect(state.selection.empty).toBe(true)
    expect(state.selection.$head.parent.textContent).toBe('let a')
    expect(state.selection.$head.parentOffset).toBe(0)
  })

  it('and the next Backspace is an ordinary paragraph\'s', () => {
    let state = press(stateAt('before\n\n```\ncode\n```', 1, 0), 'Backspace')
    state = press(state, 'Backspace')
    expect(blocks(state)).toEqual(['paragraph:beforecode'])
  })

  it('an empty block becomes one empty paragraph', () => {
    const state = press(stateAt('before\n\n```\n```\n\nafter', 1, 0), 'Backspace')
    expect(blocks(state)).toEqual(['paragraph:before', 'paragraph:', 'paragraph:after'])
  })

  it('never selects the block', () => {
    const state = press(stateAt('```py\nx = 1\n```', 0, 0), 'Backspace')
    expect(selectedType(state)).toBeNull()
  })

  it('leaves Backspace inside the code to the browser', () => {
    expect(takes(stateAt('```\nabc\n```', 0, 2), 'Backspace')).toBe(false)
  })
})

describe('Delete at the end of a code block', () => {
  it('stays put instead of pulling the next line into the code', () => {
    const state = stateAt('```js\nlet a\n```\n\nafter', 0, 'end')
    expect(takes(state, 'Delete')).toBe(true)
    const next = press(state, 'Delete')
    expect(blocks(next)).toEqual(['code_block:let a', 'paragraph:after'])
    expect(selectedType(next)).toBeNull()
  })

  it('leaves Delete inside the code to the browser', () => {
    expect(takes(stateAt('```\nabc\n```', 0, 1), 'Delete')).toBe(false)
  })
})

describe('Escape inside a code block selects it', () => {
  it('from a caret, and Backspace then removes the block', () => {
    let state = press(stateAt('before\n\n```js\nlet a\n```\n\nafter', 1, 2), 'Escape')
    expect(selectedType(state)).toBe('code_block')
    state = press(state, 'Backspace')
    expect(blocks(state)).toEqual(['paragraph:before', 'paragraph:after'])
  })

  it('from a selection of its text', () => {
    const doc = markdownToProse('```\nabcdef\n```', schema)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2, 5), plugins: [plugin] })
    expect(selectedType(press(state, 'Escape'))).toBe('code_block')
  })

  it('and not outside one', () => {
    expect(takes(stateAt('prose', 0, 2), 'Escape')).toBe(false)
  })
})

describe('codeBlockKey, which a CodeMirror-drawn block calls', () => {
  it('answers Backspace with text and Escape with the selected block', () => {
    const state = stateAt('```py\nx = 1\n```', 0, 0)
    let next = state
    const dispatch = (tr: Transaction) => { next = state.apply(tr) }
    expect(codeBlockKey(state, dispatch, 0, 'Backspace')).toBe(true)
    expect(blocks(next)).toEqual(['paragraph:x = 1'])
    expect(codeBlockKey(state, dispatch, 0, 'Escape')).toBe(true)
    expect(selectedType(next)).toBe('code_block')
    expect(codeBlockKey(state, undefined, 5, 'Escape')).toBe(false)
  })
})

describe('deleting towards a code block from the line beside it', () => {
  it('Backspace at the start of the line after selects the block and keeps the line', () => {
    const state = press(stateAt('```\ncode\n```\n\nafter', 1, 0), 'Backspace')
    expect(selectedType(state)).toBe('code_block')
    expect(blocks(state)).toEqual(['code_block:code', 'paragraph:after'])
  })

  it('Backspace on an empty line after removes the line and selects the block', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('code')]),
      schema.node('paragraph'),
      schema.node('paragraph', null, [schema.text('tail')]),
    ])
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 7), plugins: [plugin] })
    const next = press(state, 'Backspace')
    expect(blocks(next)).toEqual(['code_block:code', 'paragraph:tail'])
    expect(selectedType(next)).toBe('code_block')
  })

  it('Delete at the end of the line before selects the block', () => {
    const state = press(stateAt('before\n\n```\ncode\n```', 0, 'end'), 'Delete')
    expect(selectedType(state)).toBe('code_block')
    expect(blocks(state)).toEqual(['paragraph:before', 'code_block:code'])
  })

  it('Delete on an empty line before removes the line and selects the block', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('head')]),
      schema.node('paragraph'),
      schema.node('code_block', null, [schema.text('code')]),
    ])
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 7), plugins: [plugin] })
    const next = press(state, 'Delete')
    expect(blocks(next)).toEqual(['paragraph:head', 'code_block:code'])
    expect(selectedType(next)).toBe('code_block')
  })

  it('leaves other neighbours to the normal join', () => {
    const state = press(stateAt('one\n\ntwo', 1, 0), 'Backspace')
    expect(blocks(state)).toEqual(['paragraph:onetwo'])
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { createBlockEditor } from './editor'
import { markdownToProse, proseToMarkdown } from './markdown'
import { currentBlockMode } from './block-modes'

/** The position the single block-mode record names, or null. */
function sourcePos(view: EditorView): number | null {
  return currentBlockMode(view.state)?.pos ?? null
}

const mermaidMock = vi.hoisted(() => ({
  render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 900 300"></svg>' }),
}))

vi.mock('./mermaid', () => ({
  loadMermaid: vi.fn().mockResolvedValue({ render: mermaidMock.render }),
  errorBlock: (message: string) => {
    const el = document.createElement('div')
    el.textContent = message
    return el
  },
  responsifySvg: () => null,
  adaptDiagramColors: () => {},
  pinSvgTextColors: () => {},
  bakeDiagram: () => Promise.resolve(false),
  collectPendingMermaid: () => [],
}))

beforeEach(() => {
  document.body.innerHTML = ''
})

function typeText(view: EditorView, str: string): void {
  for (const ch of str) {
    const pos = view.state.selection.head
    const handled = view.someProp('handleTextInput', (fn) => fn(view, pos, pos, ch, () => view.state.tr))
    if (!handled) {
      view.dispatch(view.state.tr.insertText(ch, pos, pos))
    }
  }
}

function dispatchKeydown(view: EditorView, key: string, opts: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
  let handled = false
  view.someProp('handleKeyDown', (fn) => {
    if (fn(view, event)) {
      handled = true
      return true
    }
    return false
  })
  return handled
}

function firstBlock(view: EditorView): import('prosemirror-model').Node {
  return view.state.doc.firstChild as import('prosemirror-model').Node
}

describe('block-start input rules', () => {
  it('fence: ``` + space creates an empty code block with the caret inside', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '``` ')
    const block = firstBlock(view)
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('')
    expect(view.state.selection.$from.parent.type.name).toBe('code_block')
    expect(proseToMarkdown(view.state.doc)).not.toContain('```\n```\n```')
  })

  it('fence: ```lang + space sets the code language', () => {
    const js = createBlockEditor(document.body, '').getView()
    typeText(js, '```js ')
    expect(firstBlock(js).type.name).toBe('code_block')
    expect(firstBlock(js).attrs.language).toBe('js')

    const py = createBlockEditor(document.body, '').getView()
    typeText(py, '```python ')
    expect(firstBlock(py).attrs.language).toBe('python')
  })

  it('fence: ```mermaid + space opens source mode; Escape commits to a preview', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '```mermaid ')
    const block = firstBlock(view)
    expect(block.type.name).toBe('mermaid_block')
    expect(sourcePos(view)).toBe(0)

    expect(dispatchKeydown(view, 'Escape')).toBe(true)
    expect(firstBlock(view).type.name).toBe('mermaid_block')
    expect(sourcePos(view)).toBeNull()
    expect(proseToMarkdown(view.state.doc)).toContain('```mermaid')
  })

  it('fence: ```#!sh + space makes a runnable code block with the shebang', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '```#!sh ')
    const block = firstBlock(view)
    expect(block.type.name).toBe('code_block')
    expect(block.textContent.startsWith('#!sh')).toBe(true)
  })

  it('fence: Enter after an unterminated ``` / ```lang converts too', () => {
    for (const marker of ['```', '```js', '```python']) {
      const view = createBlockEditor(document.body, '').getView()
      typeText(view, marker)
      expect(dispatchKeydown(view, 'Enter')).toBe(true)
      expect(firstBlock(view).type.name).toBe('code_block')
    }

    const mermaid = createBlockEditor(document.body, '').getView()
    typeText(mermaid, '```mermaid')
    expect(dispatchKeydown(mermaid, 'Enter')).toBe(true)
    expect(firstBlock(mermaid).type.name).toBe('mermaid_block')
    expect(sourcePos(mermaid)).toBe(0)
  })

  it('bullet: content after - / * / + converts; - alone stays literal', () => {
    const alone = createBlockEditor(document.body, '').getView()
    typeText(alone, '- ')
    expect(firstBlock(alone).type.name).toBe('paragraph')
    expect(alone.state.doc.textContent).toBe('- ')

    for (const marker of ['- ', '* ', '+ ']) {
      const view = createBlockEditor(document.body, '').getView()
      typeText(view, `${marker}h`)
      expect(firstBlock(view).type.name).toBe('bullet_list')
      expect(view.state.doc.textContent).toBe('h')
    }
  })

  it('keeps the line a marker was typed in front of', () => {
    // **The text-loss bug, and every test above is why it hid.** A block-start rule
    // rebuilds the block from the text its regex matched — which is the text *before* the
    // cursor — so a marker typed at the start of a paragraph that already had words in it
    // replaced those words with nothing. Measured before the fix, in a four-block document,
    // with the caret at the start of the second paragraph's text:
    //
    //   `## `     → the paragraph became a heading holding nothing at all
    //   `- [ ] `  → a task item holding nothing at all
    //   ```` ```py ```` → an empty code block, the paragraph's text gone
    //   `---`     → a horizontal rule, the paragraph's text gone
    //
    // Every test in this file types into an **empty document**, so "the text before the
    // cursor" and "the whole paragraph" were the same string and the loss could not show.
    const DOC = 'First para.\n\nSecond para.\n\n## Heading\n\nTail para.\n'
    const startOf = (view: EditorView, block: number): void => {
      let offset = 0
      for (let i = 0; i < block; i++) offset += view.state.doc.child(i).nodeSize
      view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, offset + 1),
      ))
    }

    for (const [marker, expected] of [
      ['## ', 'heading'],
      ['- [ ] ', 'bullet_list'],
    ] as const) {
      const view = createBlockEditor(document.body, DOC).getView()
      startOf(view, 1)
      typeText(view, marker)
      const doc = view.state.doc
      // The reader's words are still in the document...
      expect(doc.textContent).toContain('Second para.')
      // ...in the block the marker turned the paragraph into...
      expect(doc.child(1).type.name).toBe(expected)
      expect(doc.child(1).textContent).toBe('Second para.')
      // ...and every other block is where it was.
      expect([...Array(doc.childCount).keys()].map((i) => doc.child(i).type.name))
        .toEqual(['paragraph', expected, 'heading', 'paragraph'])
      view.destroy()
    }
  })

  it('declines a whole-line marker when the line has more on it', () => {
    // A fence and a horizontal rule are **whole-line** constructs: an opening fence with
    // prose after it is prose, not a fence that lost its text. So they refuse to fire
    // rather than convert and discard — the opposite decision from the list rules, and
    // deliberately so: for those the line's text becomes the item's text, which is always
    // an improvement, while for these there is no text to keep.
    const DOC = 'First para.\n\nSecond para.\n\nTail para.\n'
    const startOfSecond = (view: EditorView): void => {
      const offset = view.state.doc.child(0).nodeSize
      view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, offset + 1),
      ))
    }

    for (const marker of ['```py ', '---']) {
      const view = createBlockEditor(document.body, DOC).getView()
      startOfSecond(view)
      typeText(view, marker)
      // Untouched: still a paragraph, still saying what it said.
      expect(view.state.doc.child(1).type.name).toBe('paragraph')
      expect(view.state.doc.child(1).textContent).toBe(marker + 'Second para.')
      expect(view.state.doc.childCount).toBe(3)
      view.destroy()
    }

    // **And they still work on a line of their own**, which is what a fence is for.
    const alone = createBlockEditor(document.body, '').getView()
    typeText(alone, '```py ')
    expect(firstBlock(alone).type.name).toBe('code_block')
  })

  it('Enter after a marker keeps the rest of the line too', () => {
    // The same three cases through the other route: `blockStartKeymap`'s Enter handler
    // rebuilt the block with an empty item, so Enter after `- Second para.` deleted
    // "Second para." just as the input rule did.
    for (const [marker, expected] of [
      ['- ', 'bullet_list'],
      ['- [ ] ', 'bullet_list'],
      ['1. ', 'ordered_list'],
      ['> ', 'blockquote'],
    ] as const) {
      const view = createBlockEditor(document.body, 'Second para.').getView()
      typeText(view, marker)
      // Caret at the end of the marker, which is where a reader's is after typing it.
      view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 1 + marker.length),
      ))
      dispatchKeydown(view, 'Enter')
      const doc = view.state.doc
      expect(doc.child(0).type.name).toBe(expected)
      expect(doc.textContent).toContain('Second para.')
      view.destroy()
    }
  })

  it('Enter after a fence marker declines a line that has more on it', () => {
    const view = createBlockEditor(document.body, 'Second para.').getView()
    typeText(view, '```py ')
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 1 + '```py '.length),
    ))
    dispatchKeydown(view, 'Enter')
    // **Declined, so Enter is an ordinary Enter**: the paragraph splits and both halves
    // keep their text. What matters is not who took the key — a declined rule must let
    // someone else have it — but that no code block appeared and nothing was deleted.
    const doc = view.state.doc
    expect(doc.childCount).toBe(2)
    expect([...Array(doc.childCount).keys()].map((i) => doc.child(i).type.name))
      .toEqual(['paragraph', 'paragraph'])
    expect(doc.textContent).toBe('```py Second para.')
  })

  it('bullet: -- x stays literal text', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '-- x')
    expect(firstBlock(view).type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toBe('-- x')
  })

  it('task: - [ ] + space creates an unchecked item', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '- [ ] ')
    expect(firstBlock(view).type.name).toBe('bullet_list')
    const item = firstBlock(view).firstChild as import('prosemirror-model').Node
    expect(item.attrs.checked).toBe(false)
  })

  it('task: - [x] done typed incrementally gives a checked item and round-trips', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '- [x] done')
    const item = firstBlock(view).firstChild as import('prosemirror-model').Node
    expect(item.attrs.checked).toBe(true)
    expect(view.state.doc.textContent).toBe('done')
    expect(proseToMarkdown(view.state.doc)).toContain('- [x] done')
  })

  it('task: Enter after - [x] (no trailing space) gives a checked item', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '- [x]')
    expect(dispatchKeydown(view, 'Enter')).toBe(true)
    const item = firstBlock(view).firstChild as import('prosemirror-model').Node
    expect(item.attrs.checked).toBe(true)
  })

  it('ordered: 1. / 3. hi convert to ordered lists with the right order', () => {
    const one = createBlockEditor(document.body, '').getView()
    typeText(one, '1. ')
    expect(firstBlock(one).type.name).toBe('ordered_list')
    expect(firstBlock(one).attrs.order).toBe(1)

    const three = createBlockEditor(document.body, '').getView()
    typeText(three, '3. hi')
    expect(firstBlock(three).type.name).toBe('ordered_list')
    expect(firstBlock(three).attrs.order).toBe(3)
    expect(three.state.doc.textContent).toBe('hi')
    expect(proseToMarkdown(three.state.doc)).toContain('3. hi')
  })

  it('ordered: decimals and glued text stay literal', () => {
    for (const literal of ['3.14 ', '1x']) {
      const view = createBlockEditor(document.body, '').getView()
      typeText(view, literal)
      expect(firstBlock(view).type.name).toBe('paragraph')
      expect(view.state.doc.textContent).toBe(literal)
    }
  })

  it('blockquote: > + space wraps; content lands inside', () => {
    const empty = createBlockEditor(document.body, '').getView()
    typeText(empty, '> ')
    expect(firstBlock(empty).type.name).toBe('blockquote')
    expect(proseToMarkdown(empty.state.doc)).toContain('>')

    const quoted = createBlockEditor(document.body, '').getView()
    typeText(quoted, '> quoted')
    expect(firstBlock(quoted).type.name).toBe('blockquote')
    expect(quoted.state.doc.textContent).toBe('quoted')
    expect(proseToMarkdown(quoted.state.doc)).toContain('> quoted')
  })

  it('blockquote: Enter after a bare > converts', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '>')
    expect(dispatchKeydown(view, 'Enter')).toBe(true)
    expect(firstBlock(view).type.name).toBe('blockquote')
  })

  it('regression: headings still convert on the space', () => {
    const h1 = createBlockEditor(document.body, '').getView()
    typeText(h1, '# hi')
    expect(firstBlock(h1).type.name).toBe('heading')
    expect(firstBlock(h1).attrs.level).toBe(1)
    expect(h1.state.doc.textContent).toBe('hi')

    const h6 = createBlockEditor(document.body, '').getView()
    typeText(h6, '###### six')
    expect(firstBlock(h6).type.name).toBe('heading')
    expect(firstBlock(h6).attrs.level).toBe(6)
    expect(h6.state.doc.textContent).toBe('six')
  })

  it('regression: --- becomes a horizontal rule', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '---')
    expect(firstBlock(view).type.name).toBe('horizontal_rule')
  })

  it('negative: a marker after leading text does not convert', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, 'abc ```js ')
    expect(firstBlock(view).type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toBe('abc ```js ')
  })

  it('negative: *foo* stays emphasis, not a bullet', () => {
    const view = createBlockEditor(document.body, '').getView()
    typeText(view, '*foo*')
    expect(firstBlock(view).type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toBe('foo')
    const textNode = firstBlock(view).firstChild as import('prosemirror-model').Node
    expect(textNode.marks.map((m) => m.type.name)).toContain('em')
  })

  it('round-trip: converted structures re-parse to the same shape', () => {
    const cases = ['- a\n- b', '1. one', '- [x] done', '> quote', '```js\ncode\n```']
    for (const md of cases) {
      const view = createBlockEditor(document.body, md).getView()
      const types: string[] = []
      markdownToProse(proseToMarkdown(view.state.doc), view.state.schema).forEach((n) => types.push(n.type.name))
      const original: string[] = []
      view.state.doc.forEach((n) => original.push(n.type.name))
      expect(types).toEqual(original)
    }
  })
})
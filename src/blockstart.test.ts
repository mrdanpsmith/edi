import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { createBlockEditor } from './editor'
import { markdownToProse, proseToMarkdown } from './markdown'
import { getSourceBlockState } from './blockplugin'

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
  attachMermaidToolbar: () => {},
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
    expect(block.attrs._source).toBe(true)
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(0)

    expect(dispatchKeydown(view, 'Escape')).toBe(true)
    expect(firstBlock(view).type.name).toBe('mermaid_block')
    expect(firstBlock(view).attrs._source).toBe(false)
    expect(getSourceBlockState(view.state).sourceBlockPos).toBeNull()
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
    expect(firstBlock(mermaid).attrs._source).toBe(true)
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
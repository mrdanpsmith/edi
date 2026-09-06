import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  applyFormatEdit,
  insertHorizontalRule,
  insertLink,
  runFormat,
  toggleBlockquote,
  toggleBold,
  toggleCode,
  toggleCodeBlock,
  toggleDefinition,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleLinePrefixes,
  toggleOrderedList,
  toggleStrikethrough,
  toggleSubscriptFormat,
  toggleSuperscriptFormat,
  toggleTaskList,
  toggleUnorderedList,
} from './format'

const views: EditorView[] = []

function makeView(doc: string, anchor: number, head: number): EditorView {
  const state = EditorState.create({ doc, selection: { anchor, head } })
  const view = new EditorView({ state, parent: document.body })
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.innerHTML = ''
})

describe('toggleInline', () => {
  it('wraps the selection in the marker', () => {
    expect(toggleBold('abc', 1, 2)).toEqual({
      from: 1,
      to: 2,
      insert: '**b**',
      selectionFrom: 3,
      selectionTo: 4,
    })
  })

  it('inserts an empty marker pair at the cursor', () => {
    expect(toggleItalic('abc', 1, 1)).toEqual({
      from: 1,
      to: 1,
      insert: '**',
      selectionFrom: 2,
      selectionTo: 2,
    })
  })

  it('removes the marker when the selection is already wrapped', () => {
    expect(toggleBold('**b**', 0, 5)).toEqual({
      from: 0,
      to: 5,
      insert: 'b',
      selectionFrom: 0,
      selectionTo: 1,
    })
  })

  it('handles multi-char strikethrough markers', () => {
    expect(toggleStrikethrough('abc', 1, 2)).toEqual({
      from: 1,
      to: 2,
      insert: '~~b~~',
      selectionFrom: 3,
      selectionTo: 4,
    })
  })
})

describe('toggleCode', () => {
  it('inserts an empty code span at the cursor', () => {
    expect(toggleCode('a', 1, 1)).toEqual({
      from: 1,
      to: 1,
      insert: '``',
      selectionFrom: 2,
      selectionTo: 2,
    })
  })

  it('wraps an inline selection in backticks', () => {
    expect(toggleCode('a b', 1, 2)).toEqual({
      from: 1,
      to: 2,
      insert: '` `',
      selectionFrom: 2,
      selectionTo: 3,
    })
  })

  it('unwraps an inline selection already wrapped in backticks', () => {
    expect(toggleCode('`x`', 0, 3)).toEqual({
      from: 0,
      to: 3,
      insert: 'x',
      selectionFrom: 0,
      selectionTo: 1,
    })
  })

  it('wraps a multiline selection in a fenced block', () => {
    expect(toggleCode('a\nb', 0, 3)).toEqual({
      from: 0,
      to: 3,
      insert: '```\na\nb\n```',
      selectionFrom: 4,
      selectionTo: 7,
    })
  })

  it('unwraps a multiline selection already inside a fence', () => {
    expect(toggleCode('```\na\nb\n```', 0, 11)).toEqual({
      from: 0,
      to: 11,
      insert: 'a\nb',
      selectionFrom: 0,
      selectionTo: 3,
    })
  })

  it('unwraps a bare fence-only selection as a code span', () => {
    expect(toggleCode('```', 0, 3).insert).toBe('`')
  })
})

describe('toggleCodeBlock', () => {
  it('inserts a fenced placeholder at an empty line', () => {
    expect(toggleCodeBlock('', 0, 0)).toEqual({
      from: 0,
      to: 0,
      insert: '```\ncode\n```',
      selectionFrom: 4,
      selectionTo: 8,
    })
  })

  it('adds newline padding around an empty selection mid-text', () => {
    expect(toggleCodeBlock('hello world', 5, 5)).toEqual({
      from: 5,
      to: 5,
      insert: '\n```\ncode\n```\n',
      selectionFrom: 10,
      selectionTo: 14,
    })
  })

  it('wraps a non-fenced selection', () => {
    expect(toggleCodeBlock('a\nb', 0, 3)).toEqual({
      from: 0,
      to: 3,
      insert: '```\na\nb\n```',
      selectionFrom: 4,
      selectionTo: 7,
    })
  })

  it('unwraps a selection already inside a fence', () => {
    expect(toggleCodeBlock('```\na\nb\n```', 0, 11).insert).toBe('a\nb')
  })
})

describe('toggleLinePrefixes', () => {
  it('prefixes non-empty lines and skips blank lines', () => {
    expect(toggleLinePrefixes('a\n\nb', 0, 3, () => '- ')).toEqual({
      from: 0,
      to: 2,
      insert: '- a\n',
      selectionFrom: 0,
      selectionTo: 4,
    })
  })

  it('removes existing prefixes', () => {
    expect(toggleLinePrefixes('- a\n\n- b', 0, 7, () => '- ')).toEqual({
      from: 0,
      to: 8,
      insert: 'a\n\nb',
      selectionFrom: 0,
      selectionTo: 4,
    })
  })

  it('inserts a placeholder on an empty line', () => {
    expect(toggleLinePrefixes('', 0, 0, () => '- ', 'item')).toEqual({
      from: 0,
      to: 0,
      insert: '- item',
      selectionFrom: 2,
      selectionTo: 6,
    })
  })
})

describe('block-level toggles', () => {
  it('toggles a heading with a placeholder for low levels', () => {
    expect(toggleHeading('', 0, 0, 1)).toEqual({
      from: 0,
      to: 0,
      insert: '# Heading 1',
      selectionFrom: 2,
      selectionTo: 11,
    })
  })

  it('does nothing on an empty selection for high heading levels', () => {
    expect(toggleHeading('', 0, 0, 6).insert).toBe('')
  })

  it('toggles blockquote on and off', () => {
    expect(toggleBlockquote('a', 0, 1)).toEqual({
      from: 0,
      to: 1,
      insert: '> a',
      selectionFrom: 0,
      selectionTo: 3,
    })
    expect(toggleBlockquote('> a', 0, 3).insert).toBe('a')
  })

  it('toggles unordered list markers', () => {
    expect(toggleUnorderedList('a', 0, 1).insert).toBe('- a')
  })

  it('numbers ordered list lines incrementally', () => {
    expect(toggleOrderedList('a\nb', 0, 3).insert).toBe('1. a\n2. b')
    expect(toggleOrderedList('1. a\n2. b', 0, 9).insert).toBe('a\nb')
  })

  it('toggles task list markers', () => {
    expect(toggleTaskList('a', 0, 1).insert).toBe('- [ ] a')
  })
})

describe('toggleDefinition', () => {
  it('inserts a term/definition skeleton on an empty line', () => {
    expect(toggleDefinition('', 0, 0)).toEqual({
      from: 0,
      to: 0,
      insert: 'term\n: definition',
      selectionFrom: 0,
      selectionTo: 4,
    })
  })

  it('appends a definition after a single term', () => {
    const edit = toggleDefinition('term', 0, 4)
    expect(edit.insert).toBe('term\n: definition')
    expect(edit.selectionFrom).toBe(7)
    expect(edit.selectionTo).toBe(17)
  })

  it('removes existing definition markers', () => {
    expect(toggleDefinition('term\n: a\n: b', 0, 13).insert).toBe('term\na\nb')
  })

  it('adds markers to unprefixed definitions', () => {
    expect(toggleDefinition('term\na\nb', 0, 9).insert).toBe('term\n: a\n: b')
  })
})

describe('other inline toggles', () => {
  it('toggles highlight with == markers', () => {
    expect(toggleHighlight('a', 0, 1).insert).toBe('==a==')
  })

  it('toggles subscript with ~ markers', () => {
    expect(toggleSubscriptFormat('a', 0, 1).insert).toBe('~a~')
  })

  it('toggles superscript with ^ markers', () => {
    expect(toggleSuperscriptFormat('a', 0, 1).insert).toBe('^a^')
  })
})

describe('insertLink', () => {
  it('wraps the selection in a link with the url selected', () => {
    expect(insertLink('text', 0, 4)).toEqual({
      from: 0,
      to: 4,
      insert: '[text](https://)',
      selectionFrom: 7,
      selectionTo: 15,
    })
  })

  it('uses "text" as the label for an empty selection', () => {
    expect(insertLink('', 0, 0).insert).toBe('[text](https://)')
  })
})

describe('insertHorizontalRule', () => {
  it('adds newline padding on both sides', () => {
    expect(insertHorizontalRule('ab', 1, 1)).toEqual({
      from: 1,
      to: 1,
      insert: '\n---\n',
      selectionFrom: 5,
      selectionTo: 5,
    })
  })

  it('omits padding at the document edges', () => {
    expect(insertHorizontalRule('', 0, 0).insert).toBe('---')
  })

  it('omits padding after a trailing newline', () => {
    expect(insertHorizontalRule('a\n', 0, 0).insert).toBe('---\n')
  })
})

describe('applyFormatEdit / runFormat', () => {
  it('applies a format edit through the CodeMirror view', () => {
    const view = makeView('hello world', 0, 5)
    const result = runFormat(view, (_doc, from, to) => ({
      from,
      to,
      insert: 'X',
      selectionFrom: from,
      selectionTo: from,
    }))
    expect(result).toBe(true)
    expect(view.state.doc.toString()).toBe('X world')
    expect(view.state.selection.main.from).toBe(0)
  })

  it('applyFormatEdit dispatches the exact change and selection', () => {
    const view = makeView('abc', 1, 3)
    applyFormatEdit(view, { from: 1, to: 3, insert: 'Y', selectionFrom: 2, selectionTo: 2 })
    expect(view.state.doc.toString()).toBe('aY')
    expect(view.state.selection.main.anchor).toBe(2)
    expect(view.state.selection.main.head).toBe(2)
  })
})
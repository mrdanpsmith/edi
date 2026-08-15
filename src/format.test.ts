import { describe, expect, it } from 'vitest'

import {
  insertHorizontalRule,
  insertLink,
  toggleBlockquote,
  toggleBold,
  toggleCode,
  toggleCodeBlock,
  toggleDefinition,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
  toggleUnorderedList,
  type FormatEdit,
} from './format'

function apply(doc: string, edit: FormatEdit): string {
  return doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to)
}

describe('toggleBold', () => {
  it('wraps the selection in double asterisks', () => {
    const doc = 'hello world'
    const edit = toggleBold(doc, 6, 11)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('hello **world**')
    expect(wrapped.slice(edit.selectionFrom, edit.selectionTo)).toBe('world')
  })

  it('unwraps an already-bold selection', () => {
    const doc = 'hello **world**'
    const edit = toggleBold(doc, 6, 15)
    const unwrapped = apply(doc, edit)
    expect(unwrapped).toBe('hello world')
    expect(unwrapped.slice(edit.selectionFrom, edit.selectionTo)).toBe('world')
  })

  it('inserts an empty bold pair with the cursor inside when nothing is selected', () => {
    const doc = 'hello'
    const edit = toggleBold(doc, 3, 3)
    expect(apply(doc, edit)).toBe('hel****lo')
    expect(edit.selectionFrom).toBe(edit.selectionTo)
    expect(edit.selectionFrom).toBe(3 + 2)
  })
})

describe('toggleItalic / toggleStrikethrough', () => {
  it('wraps and unwraps italics', () => {
    const doc = 'hello world'
    const edit = toggleItalic(doc, 6, 11)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('hello *world*')
    const unwrap = toggleItalic(wrapped, 6, 13)
    expect(apply(wrapped, unwrap)).toBe('hello world')
  })

  it('wraps and unwraps strikethrough', () => {
    const doc = 'hello world'
    const edit = toggleStrikethrough(doc, 6, 11)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('hello ~~world~~')
    const unwrap = toggleStrikethrough(wrapped, 6, 15)
    expect(apply(wrapped, unwrap)).toBe('hello world')
  })
})

describe('toggleCode', () => {
  it('wraps a single-line selection in backticks', () => {
    const doc = 'run foo'
    const edit = toggleCode(doc, 4, 7)
    expect(apply(doc, edit)).toBe('run `foo`')
  })

  it('wraps a multi-line selection in a fenced block', () => {
    const doc = 'a\nb\nc'
    const edit = toggleCode(doc, 0, 5)
    expect(apply(doc, edit)).toBe('```\na\nb\nc\n```')
  })

  it('unwraps a fenced block selection', () => {
    const doc = '```\na\nb\n```'
    const edit = toggleCode(doc, 0, 12)
    expect(apply(doc, edit)).toBe('a\nb')
  })

  it('ignores leading newlines when selecting single-line code', () => {
    const doc = 'a\nrun foo\nb'
    const edit = toggleCode(doc, 1, 9)
    expect(apply(doc, edit)).toBe('a\n`run foo`\nb')
  })

  it('ignores trailing newlines when wrapping a fenced block', () => {
    const doc = 'a\nb\nc\n'
    const edit = toggleCode(doc, 0, 6)
    expect(apply(doc, edit)).toBe('```\na\nb\nc\n```\n')
  })
})

describe('toggleCodeBlock', () => {
  it('wraps a selection in a fenced block', () => {
    const doc = 'a\nb\nc'
    const edit = toggleCodeBlock(doc, 0, 5)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('```\na\nb\nc\n```')
    expect(wrapped.slice(edit.selectionFrom, edit.selectionTo)).toBe('a\nb\nc')
  })

  it('unwraps an already-fenced selection', () => {
    const doc = '```\na\nb\n```'
    const edit = toggleCodeBlock(doc, 0, 12)
    expect(apply(doc, edit)).toBe('a\nb')
  })

  it('unwraps a fenced selection with a language tag', () => {
    const doc = '```python\na\n```'
    const edit = toggleCodeBlock(doc, 0, 15)
    expect(apply(doc, edit)).toBe('a')
  })

  it('inserts a placeholder block with the cursor in the body on empty selection', () => {
    const doc = 'hello'
    const edit = toggleCodeBlock(doc, 5, 5)
    const inserted = apply(doc, edit)
    expect(inserted).toBe('hello\n```\ncode\n```')
    expect(inserted.slice(edit.selectionFrom, edit.selectionTo)).toBe('code')
  })

  it('inserts without stray newlines at the start of the document', () => {
    const doc = 'hello'
    const edit = toggleCodeBlock(doc, 0, 0)
    expect(apply(doc, edit)).toBe('```\ncode\n```\nhello')
  })
})

describe('inline newline trimming', () => {
  it('ignores leading and trailing newlines in a bold toggle', () => {
    const doc = 'a\nhello world\nb'
    const edit = toggleBold(doc, 2, 13)
    expect(apply(doc, edit)).toBe('a\n**hello world**\nb')
  })

  it('unwraps bold across a trailing newline', () => {
    const doc = 'a\n**hello world**\nb'
    const edit = toggleBold(doc, 2, 18)
    expect(apply(doc, edit)).toBe('a\nhello world\nb')
  })

  it('ignores newlines when inserting a link', () => {
    const doc = 'a\nsee the docs\nb'
    const edit = insertLink(doc, 2, 15)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('a\n[see the docs](https://)\nb')
    expect(wrapped.slice(edit.selectionFrom, edit.selectionTo)).toBe('https://')
  })
})

describe('toggleHeading', () => {
  it('prefixes the line with a heading marker', () => {
    const doc = 'hello'
    const edit = toggleHeading(doc, 0, 5, 1)
    expect(apply(doc, edit)).toBe('# hello')
  })

  it('removes the heading marker when already present', () => {
    const doc = '## hello'
    const edit = toggleHeading(doc, 0, 8, 2)
    expect(apply(doc, edit)).toBe('hello')
  })

  it('applies to every selected line', () => {
    const doc = 'one\ntwo'
    const edit = toggleHeading(doc, 0, 7, 1)
    expect(apply(doc, edit)).toBe('# one\n# two')
  })
})

describe('toggleBlockquote', () => {
  it('prefixes and removes the quote marker', () => {
    const doc = 'a\nb'
    const edit = toggleBlockquote(doc, 0, 3)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('> a\n> b')
    const unwrap = toggleBlockquote(wrapped, 0, 7)
    expect(apply(wrapped, unwrap)).toBe('a\nb')
  })
})

describe('lists', () => {
  it('toggles an unordered list', () => {
    const doc = 'a\nb'
    const edit = toggleUnorderedList(doc, 0, 3)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('- a\n- b')
    const unwrap = toggleUnorderedList(wrapped, 0, 6)
    expect(apply(wrapped, unwrap)).toBe('a\nb')
  })

  it('toggles an ordered list with incrementing numbers', () => {
    const doc = 'a\nb'
    const edit = toggleOrderedList(doc, 0, 3)
    expect(apply(doc, edit)).toBe('1. a\n2. b')
  })

  it('toggles a task list', () => {
    const doc = 'a\nb'
    const edit = toggleTaskList(doc, 0, 3)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('- [ ] a\n- [ ] b')
    const unwrap = toggleTaskList(wrapped, 0, 12)
    expect(apply(wrapped, unwrap)).toBe('a\nb')
  })

  it('leaves blank lines untouched', () => {
    const doc = 'a\n\nb'
    const edit = toggleUnorderedList(doc, 0, 4)
    expect(apply(doc, edit)).toBe('- a\n\n- b')
  })

  it('applies to the current line on an empty selection', () => {
    const doc = 'one\ntwo'
    const edit = toggleUnorderedList(doc, 5, 5)
    expect(apply(doc, edit)).toBe('one\n- two')
  })
})

describe('block placeholders on empty lines', () => {
  it('inserts a heading placeholder with the text selected', () => {
    const doc = '\n\n'
    const edit = toggleHeading(doc, 1, 1, 1)
    const inserted = apply(doc, edit)
    expect(inserted).toBe('\n# Heading 1\n')
    expect(inserted.slice(edit.selectionFrom, edit.selectionTo)).toBe('Heading 1')
  })

  it('uses a smaller placeholder for level-two headings', () => {
    const edit = toggleHeading('', 0, 0, 2)
    expect(apply('', edit)).toBe('## Heading 2')
  })

  it('inserts a quote placeholder', () => {
    const edit = toggleBlockquote('\n\n', 1, 1)
    const inserted = apply('\n\n', edit)
    expect(inserted).toBe('\n> quote\n')
    expect(inserted.slice(edit.selectionFrom, edit.selectionTo)).toBe('quote')
  })

  it('inserts list placeholders', () => {
    const doc = ''
    const bullet = toggleUnorderedList(doc, 0, 0)
    const ordered = toggleOrderedList(doc, 0, 0)
    const task = toggleTaskList(doc, 0, 0)
    expect(apply(doc, bullet)).toBe('- item')
    expect(apply(doc, ordered)).toBe('1. item')
    expect(apply(doc, task)).toBe('- [ ] task')
  })

  it('does not insert a placeholder when the line already has text', () => {
    const doc = 'one\ntwo'
    const edit = toggleBlockquote(doc, 5, 5)
    expect(apply(doc, edit)).toBe('one\n> two')
  })
})

describe('toggleHighlight', () => {
  it('wraps and unwraps the selection in double equals', () => {
    const doc = 'hello world'
    const edit = toggleHighlight(doc, 6, 11)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('hello ==world==')
    expect(wrapped.slice(edit.selectionFrom, edit.selectionTo)).toBe('world')
    const unwrap = toggleHighlight(wrapped, 6, 15)
    expect(apply(wrapped, unwrap)).toBe('hello world')
  })

  it('inserts an empty pair with the cursor inside when nothing is selected', () => {
    const doc = 'hello'
    const edit = toggleHighlight(doc, 3, 3)
    expect(apply(doc, edit)).toBe('hel====lo')
    expect(edit.selectionFrom).toBe(edit.selectionTo)
    expect(edit.selectionFrom).toBe(3 + 2)
  })
})

describe('toggleDefinition', () => {
  it('prefixes following lines with the definition marker', () => {
    const doc = 'Term\ndefinition one\ndefinition two'
    const edit = toggleDefinition(doc, 0, 33)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('Term\n: definition one\n: definition two')
    const unwrap = toggleDefinition(wrapped, 0, 37)
    expect(apply(wrapped, unwrap)).toBe('Term\ndefinition one\ndefinition two')
  })

  it('appends a definition placeholder to a term-only line', () => {
    const doc = 'Term'
    const edit = toggleDefinition(doc, 0, 4)
    const inserted = apply(doc, edit)
    expect(inserted).toBe('Term\n: definition')
    expect(inserted.slice(edit.selectionFrom, edit.selectionTo)).toBe('definition')
  })

  it('inserts a term and definition placeholder on an empty line with the term selected', () => {
    const doc = '\n\n'
    const edit = toggleDefinition(doc, 1, 1)
    const inserted = apply(doc, edit)
    expect(inserted).toBe('\nterm\n: definition\n')
    expect(inserted.slice(edit.selectionFrom, edit.selectionTo)).toBe('term')
  })
})

describe('insertLink', () => {
  it('wraps the selection and selects the URL placeholder', () => {
    const doc = 'see the docs'
    const edit = insertLink(doc, 4, 12)
    const wrapped = apply(doc, edit)
    expect(wrapped).toBe('see [the docs](https://)')
    expect(wrapped.slice(edit.selectionFrom, edit.selectionTo)).toBe('https://')
  })

  it('uses a placeholder label when nothing is selected', () => {
    const doc = 'hi'
    const edit = insertLink(doc, 2, 2)
    expect(apply(doc, edit)).toBe('hi[text](https://)')
  })
})

describe('insertHorizontalRule', () => {
  it('inserts a rule at the start of the document', () => {
    const doc = 'hello'
    const edit = insertHorizontalRule(doc, 0, 0)
    expect(apply(doc, edit)).toBe('---\nhello')
  })

  it('inserts a rule between lines without stray blank lines', () => {
    const doc = 'a\nb'
    const edit = insertHorizontalRule(doc, 2, 2)
    expect(apply(doc, edit)).toBe('a\n---\nb')
  })

  it('inserts a rule at the end of the document', () => {
    const doc = 'hello'
    const edit = insertHorizontalRule(doc, 5, 5)
    expect(apply(doc, edit)).toBe('hello\n---')
  })

  it('replaces a selection with the rule', () => {
    const doc = 'a\nhello world\nb'
    const edit = insertHorizontalRule(doc, 2, 13)
    expect(apply(doc, edit)).toBe('a\n---\nb')
  })
})

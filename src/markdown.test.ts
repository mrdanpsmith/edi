import { describe, it, expect } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'

function serialize(markdown: string): string {
  return proseToMarkdown(markdownToProse(markdown, schema))
}

describe('proseToMarkdown save round-trip', () => {
  it('keeps separate paragraphs separated by a blank line', () => {
    const md = 'first paragraph\n\nsecond paragraph'
    expect(serialize(md)).toBe('first paragraph\n\nsecond paragraph\n')
  })

  it('keeps a heading separate from the following paragraph', () => {
    const md = '# Title\n\ntext'
    expect(serialize(md)).toBe('# Title\n\ntext\n')
  })

  it('keeps mixed blocks (para, list, para) separated', () => {
    const md = 'intro\n\n- one\n- two\n\noutro'
    const out = serialize(md)
    expect(out).toBe('intro\n\n- one\n- two\n\noutro\n')
  })

  it('does not mangle a list when the doc has only one list', () => {
    const md = '- one\n- two\n- three'
    expect(serialize(md)).toBe('- one\n- two\n- three\n')
  })

  it('keeps a blockquote with multiple paragraphs intact', () => {
    const md = '> para one\n>\n> para two'
    const out = serialize(md)
    expect(out).toContain('> para one')
    expect(out).toContain('> para two')
    const re = markdownToProse(out, schema)
    const quote = re.content.firstChild
    expect(quote?.type.name).toBe('blockquote')
    expect(quote?.childCount).toBe(2)
    expect(quote?.firstChild?.type.name).toBe('paragraph')
    expect(quote?.lastChild?.type.name).toBe('paragraph')
  })

  it('preserves an external link destination', () => {
    expect(serialize('[foo](https://example.com)')).toBe('[foo](https://example.com)\n')
  })

  it('preserves a relative markdown link destination', () => {
    expect(serialize('[foo](notes/readme.md)')).toBe('[foo](notes/readme.md)\n')
  })

  it('preserves a link title', () => {
    expect(serialize('[foo](https://example.com "The Title")')).toBe(
      '[foo](https://example.com "The Title")\n',
    )
  })

  it('preserves a URL containing parentheses', () => {
    expect(serialize('[foo](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
      '[foo](https://en.wikipedia.org/wiki/Foo_(bar))\n',
    )
  })
})

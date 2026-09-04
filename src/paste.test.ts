import { describe, it, expect } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { DOMParser as ProseMirrorDOMParser } from 'prosemirror-model'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { isRawUrl, containsRawUrl, insertPastedText } from './paste'

function linkifySerialized(pasted: string): string {
  // Paste at a position strictly inside a paragraph ("abc" text spans 1-3),
  // mirroring how a user's cursor sits within text when they paste.
  const doc = markdownToProse('abc', schema)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: new TextSelection(doc.resolve(3)),
    }),
  })
  insertPastedText(view, pasted)
  const out = proseToMarkdown(view.state.doc)
  view.destroy()
  host.remove()
  return out
}

describe('isRawUrl', () => {
  it('recognizes http(s) URLs', () => {
    expect(isRawUrl('https://example.com')).toBe(true)
    expect(isRawUrl('http://example.com/path?q=1')).toBe(true)
  })

  it('recognizes ftp, mailto, and www links', () => {
    expect(isRawUrl('ftp://files.example.com')).toBe(true)
    expect(isRawUrl('mailto:hi@example.com')).toBe(true)
    expect(isRawUrl('www.example.com')).toBe(true)
  })

  it('rejects plain words', () => {
    expect(isRawUrl('example')).toBe(false)
    expect(isRawUrl('hello world')).toBe(false)
  })
})

describe('containsRawUrl', () => {
  it('finds a URL inside mixed text', () => {
    expect(containsRawUrl('see https://example.com now')).toBe(true)
    expect(containsRawUrl('just words')).toBe(false)
  })
})

describe('insertPastedText', () => {
  it('wraps a raw URL in a link', () => {
    expect(linkifySerialized('https://example.com').trim()).toBe(
      'ab[https://example.com](https://example.com)c',
    )
  })

  it('prepends https for a bare www link', () => {
    expect(linkifySerialized('www.example.com').trim()).toBe(
      'ab[www.example.com](https://www.example.com)c',
    )
  })

  it('links only the URL token and keeps surrounding words plain', () => {
    expect(linkifySerialized('see https://example.com now').trim()).toBe(
      'absee [https://example.com](https://example.com) nowc',
    )
  })

  it('splits multi-line pastes into separate paragraphs', () => {
    expect(linkifySerialized('line1\nline2').trim()).toBe('abline1\n\nline2c')
  })

  it('keeps a single-line paste inline in the current paragraph', () => {
    expect(linkifySerialized('XYZ').trim()).toBe('abXYZc')
  })

  it('splits multi-line pastes into paragraphs while linkifying URLs', () => {
    expect(linkifySerialized('first https://example.com\nsecond').trim()).toBe(
      'abfirst [https://example.com](https://example.com)\n\nsecondc',
    )
  })
})

describe('rich-text HTML paste', () => {
  it('converts an <a> element into a link mark via the DOM parser', () => {
    const tmp = document.createElement('div')
    tmp.innerHTML = 'See <a href="https://example.com">link</a> here'
    const pm = ProseMirrorDOMParser.fromSchema(schema).parse(tmp)
    expect(proseToMarkdown(pm)).toBe('See [link](https://example.com) here\n')
  })
})

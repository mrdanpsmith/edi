import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { DOMParser } from 'prosemirror-model'
import { schema } from './schema'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('schema parseDOM', () => {
  it('reads inline image and break nodes from HTML', () => {
    const container = document.createElement('div')
    container.innerHTML = '<img src="s.png" alt="a"><br>'
    const doc = DOMParser.fromSchema(schema).parse(container)
    const para = doc.firstChild!
    expect(para.child(0).type.name).toBe('image')
    expect(para.child(0).attrs).toMatchObject({ src: 's.png', alt: 'a' })
    expect(para.child(1).type.name).toBe('hard_break')
  })

  it('parses a source block and mermaid block', () => {
    const container = document.createElement('div')
    container.innerHTML =
      '<div data-source-block>md text</div>' +
      '<div data-mermaid-block>graph TD\nA</div>'
    const doc = DOMParser.fromSchema(schema).parse(container)
    expect(doc.child(0).type.name).toBe('source_block')
    expect(doc.child(0).attrs.markdown).toBe('md text')
    expect(doc.child(1).type.name).toBe('mermaid_block')
    expect(doc.child(1).attrs.value).toBe('graph TD\nA')
  })

  it('keeps a real link title from HTML', () => {
    const container = document.createElement('div')
    container.innerHTML = '<a href="https://e.com/a" title="documents the API">docs</a>'
    const doc = DOMParser.fromSchema(schema).parse(container)
    const link = doc.firstChild!.firstChild!.marks.find((m) => m.type.name === 'link')!
    expect(link.attrs.href).toBe('https://e.com/a')
    expect(link.attrs.title).toBe('documents the API')
  })

  it('drops a link title that merely duplicates the href (toDOM tooltip leak)', () => {
    // toDOM writes title = href for the hover tooltip; that synthetic value
    // must not survive a copy/paste round trip as a spurious title.
    const container = document.createElement('div')
    container.innerHTML = '<a href="https://e.com/a" title="https://e.com/a">docs</a>'
    const doc = DOMParser.fromSchema(schema).parse(container)
    const link = doc.firstChild!.firstChild!.marks.find((m) => m.type.name === 'link')!
    expect(link.attrs.title).toBeNull()
  })
})

describe('schema toDOM via a plain view', () => {
  it('renders custom-block HTML', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.source_block.create({ markdown: 'src' }),
      schema.nodes.mermaid_block.create({ value: 'graph TD\nA' }),
    ])
    const editor = new EditorView(document.body, {
      state: EditorState.create({ schema, doc }),
    })
    expect(editor.dom.querySelector('[data-source-block]')?.textContent).toBe('src')
    expect(editor.dom.querySelector('[data-mermaid-block]')?.textContent).toContain('graph TD')
    editor.destroy()
  })
})
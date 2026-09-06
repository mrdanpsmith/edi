import { describe, expect, it } from 'vitest'
import { Node as ProseNode } from 'prosemirror-model'
import { buildExportHtml, serializeDocToHtml } from './export'
import { markdownToProse } from './markdown'
import { schema } from './schema'

function docFrom(md: string): ProseNode {
  return markdownToProse(md, schema)
}

describe('buildExportHtml', () => {
  it('builds a standalone document with escaped title', () => {
    const html = buildExportHtml('Notes & Stuff', '<div class="md-preview"><h1>Hi</h1></div>')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>Notes &amp; Stuff</title>')
    expect(html).toContain('<meta charset="UTF-8" />')
  })

  it('embeds a self-contained stylesheet', () => {
    const html = buildExportHtml('T', '<div class="md-preview"></div>')
    expect(html).toContain('<style>')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('.md-preview')
    expect(html).toContain('overflow-wrap: break-word')
  })

  it('includes the rendered body verbatim', () => {
    const body = '<div class="md-preview"><table><td>42</td></table></div>'
    const html = buildExportHtml('T', body)
    expect(html).toContain(body)
    expect(html).toMatch(/<body>\n<div/)
  })

  it('loads mermaid from CDN for client-side rendering', () => {
    const html = buildExportHtml('T', '')
    expect(html).toContain('cdn.jsdelivr.net/npm/mermaid@11')
    expect(html).toContain('mermaid.initialize')
    expect(html).toContain('startOnLoad:false')
    expect(html).toContain('mermaid.run')
  })

  it('does not set loose security level', () => {
    const html = buildExportHtml('T', '')
    expect(html).not.toContain('securityLevel')
  })
})

describe('serializeDocToHtml', () => {
  it('wraps content in a md-preview div', () => {
    const html = serializeDocToHtml(docFrom('hello'))
    expect(html).toMatch(/^<div class="md-preview">/)
    expect(html).toContain('hello')
  })

  it('renders headings', () => {
    const html = serializeDocToHtml(docFrom('# Hello\n## World'))
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<h2>World</h2>')
  })

  it('renders bold text', () => {
    const html = serializeDocToHtml(docFrom('**bold**'))
    expect(html).toContain('<strong>bold</strong>')
  })

  it('renders code blocks with language class', () => {
    const html = serializeDocToHtml(docFrom('```js\nconst x = 1\n```'))
    expect(html).toContain('<pre>')
    expect(html).toContain('language-js')
    expect(html).toContain('const x = 1')
  })

  it('renders inline code', () => {
    const html = serializeDocToHtml(docFrom('use `console.log`'))
    expect(html).toContain('<code>console.log</code>')
  })

  it('renders blockquotes', () => {
    const html = serializeDocToHtml(docFrom('> quoted text'))
    expect(html).toContain('<blockquote>')
    expect(html).toContain('quoted text')
  })

  it('renders horizontal rules', () => {
    const html = serializeDocToHtml(docFrom('---'))
    expect(html).toContain('<hr>')
  })

  it('renders bullet lists', () => {
    const html = serializeDocToHtml(docFrom('- one\n- two'))
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    expect(html).toContain('one')
    expect(html).toContain('two')
  })

  it('renders ordered lists', () => {
    const html = serializeDocToHtml(docFrom('1. first\n2. second'))
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>')
    expect(html).toContain('first')
  })

  it('renders task list items with data-checked attribute', () => {
    const html = serializeDocToHtml(docFrom('- [x] done\n- [ ] todo'))
    expect(html).toContain('data-checked="true"')
    expect(html).toContain('data-checked="false"')
    expect(html).toContain('done')
    expect(html).toContain('todo')
  })

  it('renders tables', () => {
    const html = serializeDocToHtml(docFrom('| A | B |\n| --- | --- |\n| 1 | 2 |'))
    expect(html).toContain('<table>')
    expect(html).toContain('<td>')
  })

  it('renders mermaid blocks as div.mermaid, not pre/code', () => {
    const html = serializeDocToHtml(docFrom('```mermaid\ngraph TD\n  A-->B\n```'))
    expect(html).toContain('<div class="mermaid">')
    expect(html).toContain('graph TD')
    expect(html).not.toMatch(/<pre/)
  })

  it('renders code blocks as pre/code', () => {
    const html = serializeDocToHtml(docFrom('```python\nprint("hi")\n```'))
    expect(html).toContain('<pre>')
    expect(html).toContain('<code')
    expect(html).toContain('print')
  })

  it('renders a runnable code block with its shebang on the first content line', () => {
    const doc = schema.node('doc', {}, [
      schema.node('code_block', {}, [schema.text('#!/bin/bash\necho hello')]),
    ])
    const html = serializeDocToHtml(doc)
    expect(html).toContain('#!/bin/bash')
    expect(html).toContain('echo hello')
    const occurrences = (html.match(/#!\/bin\/bash/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('renders a runnable code block as a single pre/code', () => {
    const doc = schema.node('doc', {}, [
      schema.node('code_block', {}, [schema.text('#!/bin/bash\necho hello')]),
    ])
    const html = serializeDocToHtml(doc)
    expect(html).toMatch(/<pre[^>]*><code/)
    expect(html).toContain('#!/bin/bash\necho hello')
  })

  it('computes spreadsheet formulas instead of showing raw text', () => {
    const headerRow = schema.node('table_row', {}, [
      schema.node('table_header', {}, [schema.node('paragraph', {}, [schema.text('A')])]),
      schema.node('table_header', {}, [schema.node('paragraph', {}, [schema.text('B')])]),
    ])
    const dataRow = schema.node('table_row', {}, [
      schema.node('table_cell', {}, [schema.node('paragraph', {}, [schema.text('10')])]),
      schema.node('table_cell', {}, [schema.node('paragraph', {}, [schema.text('20')])]),
    ])
    const formulaRow = schema.node('table_row', {}, [
      schema.node('table_cell', {}, [schema.node('paragraph', {}, [schema.text('=SUM(A2:B2)')])]),
      schema.node('table_cell', {}, [schema.node('paragraph', {}, [schema.text('=B2-A2')])]),
    ])
    const doc = schema.node('doc', {}, [
      schema.node('table', {}, [headerRow, dataRow, formulaRow]),
    ])
    const html = serializeDocToHtml(doc)
    expect(html).toContain('30')
    expect(html).toContain('10')
    expect(html).not.toContain('>SUM(A2:B2)<')
    expect(html).not.toContain('>B2-A2<')
  })
})

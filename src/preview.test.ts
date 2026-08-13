import { describe, expect, it } from 'vitest'

import { collectPendingMermaid, renderMarkdown, renderPreview } from './preview'

describe('renderMarkdown', () => {
  it('renders headings', () => {
    expect(renderMarkdown('# Hello')).toContain('<h1>Hello</h1>')
  })

  it('renders a table', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })

  it('renders task lists', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
  })

  it('renders strikethrough', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<s>gone</s>')
  })

  it('escapes raw HTML', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('does not escape code block content of other languages', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    expect(html).toContain('<code class="language-js">')
  })

  it('renders executable code fences', () => {
    const html = renderMarkdown('```#!sh\necho hi\n```')
    expect(html).toContain('class="exec-block"')
    expect(html).toContain('data-shebang="#!sh"')
    expect(html).toContain('echo hi')
  })

  it('wraps output in a preview article', () => {
    expect(renderPreview('# T').startsWith('<article class="md-preview">')).toBe(true)
    expect(renderPreview('# T').endsWith('</article>')).toBe(true)
  })
})

describe('mermaid fences', () => {
  it('emits a pending mermaid placeholder for mermaid fences', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    expect(html).toContain('class="mermaid"')
    expect(html).toContain('data-state="pending"')
    expect(html).toContain('graph TD')
  })

  it('escapes entity characters inside the mermaid source', () => {
    const html = renderMarkdown('```mermaid\nA --> B["<foo>&bar"]\n```')
    expect(html).toContain('&lt;foo&gt;')
    expect(html).toContain('&amp;bar')
  })

  it('collectPendingMermaid finds only pending blocks', () => {
    document.body.innerHTML = `
      <div class="mermaid" data-state="pending">one</div>
      <div class="mermaid" data-state="done">two</div>
    `
    const pending = collectPendingMermaid(document.body)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.textContent).toBe('one')
  })
})

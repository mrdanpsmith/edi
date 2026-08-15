import { describe, expect, it } from 'vitest'

import {
  collectPendingMermaid,
  renderMarkdown,
  renderPreview,
  resolveImageSrc,
  resolveLinkHref,
} from './preview'

describe('renderMarkdown', () => {
  it('renders headings with ids', () => {
    expect(renderMarkdown('# Hello')).toContain('<h1 id="hello">Hello</h1>')
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

  it('renders footnotes', () => {
    const html = renderMarkdown('Text with a note[^1].\n\n[^1]: The note itself.')
    expect(html).toContain('<sup class="footnote-ref">')
    expect(html).toContain('id="fn1"')
    expect(html).toContain('The note itself.')
  })

  it('renders definition lists', () => {
    const html = renderMarkdown('Apple\n: A fruit.\n: A tech company.')
    expect(html).toContain('<dl>')
    expect(html).toContain('<dt>Apple</dt>')
    expect(html).toContain('<dd>A fruit.</dd>')
  })

  it('renders highlighted, superscript, and subscript text', () => {
    const html = renderMarkdown('==marked==, 2^nd^, and H~2~O')
    expect(html).toContain('<mark>marked</mark>')
    expect(html).toContain('<sup>nd</sup>')
    expect(html).toContain('<sub>2</sub>')
  })

  it('adds heading ids', () => {
    const html = renderMarkdown('# Hello World\n\n## Hello World')
    expect(html).toContain('<h1 id="hello-world">')
    expect(html).toContain('<h2 id="hello-world-2">')
  })

  it('honors explicit heading ids', () => {
    const html = renderMarkdown('# Custom {#my-id}')
    expect(html).toContain('<h1 id="my-id">')
    expect(html).toContain('<h1 id="my-id">Custom</h1>')
    expect(html).not.toContain('{#my-id}')
  })

  it('dedupes heading ids independently per render', () => {
    const first = renderMarkdown('# Same\n\n# Same')
    const second = renderMarkdown('# Same')
    expect(first).toContain('<h1 id="same">')
    expect(first).toContain('<h1 id="same-2">')
    expect(second).toContain('<h1 id="same">')
    expect(second).not.toContain('same-2')
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

describe('resolveImageSrc', () => {
  it('leaves the src unchanged without a doc dir', () => {
    expect(resolveImageSrc('img/pic.png', undefined)).toBe('img/pic.png')
  })

  it('joins relative srcs against the doc dir', () => {
    expect(resolveImageSrc('img/pic.png', '/home/user/docs')).toBe('/home/user/docs/img/pic.png')
    expect(resolveImageSrc('./pic.png', '/docs')).toBe('/docs/./pic.png')
    expect(resolveImageSrc('../pic.png', '/docs/sub')).toBe('/docs/sub/../pic.png')
  })

  it('leaves absolute, scheme, and anchor srcs untouched', () => {
    expect(resolveImageSrc('/home/user/pic.png', '/docs')).toBe('/home/user/pic.png')
    expect(resolveImageSrc('data:image/png;base64,AAAA', '/docs')).toBe('data:image/png;base64,AAAA')
    expect(resolveImageSrc('https://e.com/a.png', '/docs')).toBe('https://e.com/a.png')
    expect(resolveImageSrc('#anchor', '/docs')).toBe('#anchor')
  })

  it('renders relative image srcs resolved against the doc dir', () => {
    const html = renderMarkdown('![pic](img/pic.png)', { docDir: '/home/user/docs' })
    expect(html).toContain('src="/home/user/docs/img/pic.png"')
  })

  it('keeps absolute image srcs in rendered output', () => {
    const html = renderMarkdown('![pic](/home/user/pic.png)', { docDir: '/home/user/docs' })
    expect(html).toContain('src="/home/user/pic.png"')
  })
})

describe('resolveLinkHref', () => {
  it('classifies fragment links', () => {
    expect(resolveLinkHref('#section', '/docs')).toEqual({ kind: 'fragment', id: 'section' })
  })

  it('classifies scheme links as external', () => {
    expect(resolveLinkHref('https://example.com', '/docs')).toEqual({
      kind: 'external',
      url: 'https://example.com',
    })
    expect(resolveLinkHref('mailto:a@b.c', undefined)).toEqual({ kind: 'external', url: 'mailto:a@b.c' })
  })

  it('resolves relative links against the doc dir', () => {
    expect(resolveLinkHref('notes.md', '/home/user/docs')).toEqual({
      kind: 'local',
      path: '/home/user/docs/notes.md',
    })
  })

  it('keeps absolute local paths untouched', () => {
    expect(resolveLinkHref('/home/user/other.md', '/docs')).toEqual({
      kind: 'local',
      path: '/home/user/other.md',
    })
    expect(resolveLinkHref('/home/user/other.md', undefined)).toEqual({
      kind: 'local',
      path: '/home/user/other.md',
    })
  })

  it('strips fragments from local link paths', () => {
    expect(resolveLinkHref('notes.md#sec', '/docs')).toEqual({
      kind: 'local',
      path: '/docs/notes.md',
    })
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

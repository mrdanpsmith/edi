import { describe, expect, it } from 'vitest'

import {
  collectPendingMermaid,
  renderMarkdown,
  renderPreview,
  resolveImageSrc,
  resolveLinkHref,
} from './preview'

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
    expect(resolveLinkHref('#section', '/docs')).toEqual({ kind: 'fragment' })
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

import { describe, expect, it } from 'vitest'

import { buildExportHtml } from './export'

describe('buildExportHtml', () => {
  it('builds a standalone document with escaped title', () => {
    const html = buildExportHtml('Notes & Stuff', '<article class="md-preview"><h1>Hi</h1></article>')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>Notes &amp; Stuff</title>')
    expect(html).toContain('<meta charset="UTF-8" />')
  })

  it('embeds a self-contained stylesheet', () => {
    const html = buildExportHtml('T', '<article class="md-preview"></article>')
    expect(html).toContain('<style>')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('.md-preview')
    expect(html).toContain('overflow-wrap: break-word')
  })

  it('includes the rendered body verbatim', () => {
    const body = '<article class="md-preview"><table><td>42</td></table></article>'
    const html = buildExportHtml('T', body)
    expect(html).toContain(body)
    expect(html).toMatch(/<body>\n<article/)
  })
})

import { describe, expect, it } from 'vitest'
import { escapeHtml } from './utils'

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersands', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('plain text')).toBe('plain text')
  })

  it('handles the empty string', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('escapes only HTML-sensitive characters', () => {
    expect(escapeHtml("it's <\"quoted\"> & more")).toBe("it's &lt;\"quoted\"&gt; &amp; more")
  })
})
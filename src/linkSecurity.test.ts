import { describe, it, expect } from 'vitest'
import { isMisleadingLink } from './linkSecurity'

describe('isMisleadingLink', () => {
  it('flags a URL-shaped link text pointing to a different host', () => {
    expect(isMisleadingLink('https://attacker.address', 'https://www.google.com')).toBe(true)
    expect(isMisleadingLink('https://attacker.address', 'www.google.com')).toBe(true)
  })

  it('does not flag a URL-shaped link text matching its href host', () => {
    expect(isMisleadingLink('https://www.google.com/search?q=x', 'https://www.google.com')).toBe(false)
    expect(isMisleadingLink('https://example.com/path#frag', 'https://EXAMPLE.com')).toBe(false)
  })

  it('flags a filename-style link whose path segment differs from href', () => {
    expect(isMisleadingLink('ATTACKER.md', 'README.md')).toBe(true)
    expect(isMisleadingLink('docs/ATTACKER.md', 'docs/README.md')).toBe(true)
  })

  it('does not flag matching filename-style links', () => {
    expect(isMisleadingLink('README.md', 'README.md')).toBe(false)
    expect(isMisleadingLink('docs/notes.md', 'docs/NOTES.md')).toBe(false)
  })

  it('does not flag descriptive prose link text', () => {
    expect(isMisleadingLink('https://example.com', 'read the docs')).toBe(false)
    expect(isMisleadingLink('other.md', 'notes')).toBe(false)
    expect(isMisleadingLink('https://example.com', 'example')).toBe(false)
  })

  it('does not flag empty text or href', () => {
    expect(isMisleadingLink('https://example.com', '')).toBe(false)
    expect(isMisleadingLink('', 'https://example.com')).toBe(false)
  })

  it('does not flag different-host links with non-URL prose text', () => {
    expect(isMisleadingLink('https://attacker.address', 'click here')).toBe(false)
  })
})

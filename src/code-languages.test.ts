import { describe, expect, it } from 'vitest'
import { codeLanguageFor, shebangLanguage } from './codeLanguages'

describe('codeLanguageFor', () => {
  it('resolves a language tag alias to its grammar', () => {
    expect(codeLanguageFor('python', '')?.label).toBe('python')
    expect(codeLanguageFor('js', '')?.label).toBe('js')
    expect(codeLanguageFor('c++', '')?.label).toBe('c++')
    expect(codeLanguageFor('bash', '')?.label).toBe('bash')
  })

  it('resolves the grammar from a runnable shebang when there is no tag', () => {
    const info = codeLanguageFor(null, '#!/usr/bin/env python3\nprint(1)\n')
    expect(info?.label).toBe('python3')
    expect(info).not.toBeNull()
  })

  it('prefers the language tag over the shebang', () => {
    const info = codeLanguageFor('javascript', '#!/bin/sh\necho hi')
    expect(info?.label).toBe('javascript')
  })

  it('returns null for an unknown tag or bare text block', () => {
    expect(codeLanguageFor('foo', '')).toBeNull()
    expect(codeLanguageFor('', 'plain prose, no fence, no shebang')).toBeNull()
    expect(codeLanguageFor(null, 'not a block')).toBeNull()
  })

  it('flags edi-formula blocks', () => {
    const info = codeLanguageFor('edi-formula', 'F(x) = x')
    expect(info?.label).toBe('edi-formula')
    expect(info?.formula).toBe(true)
  })

  it('does not flag ordinary blocks as formula', () => {
    expect(codeLanguageFor('python', '')?.formula).toBe(false)
  })
})

describe('shebangLanguage', () => {
  it('parses plain interpreter and env forms', () => {
    expect(shebangLanguage('#!/bin/sh\necho hi')).toBe('sh')
    expect(shebangLanguage('#!/bin/bash -e\necho hi')).toBe('bash')
    expect(shebangLanguage('#!/usr/bin/env python3\nprint(1)')).toBe('python3')
  })

  it('parses an absolute env path with flags', () => {
    expect(shebangLanguage('#!/usr/bin/env -S python3 -u\nprint(1)')).toBe('python3')
    expect(shebangLanguage('#!/usr/bin/env -S bash -eu\nset -e')).toBe('bash')
  })

  it('returns null for a non-shebang line', () => {
    expect(shebangLanguage('plain text')).toBeNull()
    expect(shebangLanguage('')).toBeNull()
  })
})
import { describe, expect, it } from 'vitest'
import type { Node as ProseNode } from 'prosemirror-model'
import { schema } from '../schema'
import { markdownToProse, proseToMarkdown } from '../markdown'
import {
  detectMasked,
  maskedFieldToMarkdown,
  renderMasked,
  validateMaskedLabel,
} from './masked'

function collectMasked(doc: ProseNode): Array<{ content: string; label: string }> {
  const found: Array<{ content: string; label: string }> = []
  doc.descendants((node) => {
    if (node.type.name === 'masked_field') {
      found.push({ content: String(node.attrs.content), label: String(node.attrs.label) })
    }
    return true
  })
  return found
}

describe('detectMasked', () => {
  it('detects a token without a label', () => {
    expect(detectMasked('!masked[ABC123]')).toEqual({ content: 'ABC123', label: '' })
  })

  it('detects a token with a label', () => {
    expect(detectMasked('!masked[ABC123]{label="API Key"}')).toEqual({
      content: 'ABC123',
      label: 'API Key',
    })
  })

  it('does not match text surrounding a token', () => {
    expect(detectMasked('prefix !masked[ABC123]')).toBeNull()
    expect(detectMasked('!masked[ABC123] suffix')).toBeNull()
  })

  it('does not match image or link syntax', () => {
    expect(detectMasked('![alt](url)')).toBeNull()
    expect(detectMasked('[text](url)')).toBeNull()
  })

  it('does not match an unterminated token', () => {
    expect(detectMasked('!masked[ABC')).toBeNull()
  })
})

describe('validateMaskedLabel / renderMasked', () => {
  it('rejects labels containing ] } or backslash', () => {
    expect(validateMaskedLabel('a]b')).toBeTruthy()
    expect(validateMaskedLabel('a}b')).toBeTruthy()
    expect(validateMaskedLabel('a\\b')).toBeTruthy()
    expect(validateMaskedLabel('ok')).toBeNull()
  })

  it('rejects labels with line breaks', () => {
    expect(validateMaskedLabel('a\nb')).toBeTruthy()
    expect(validateMaskedLabel('a\rb')).toBeTruthy()
  })

  it('omits the label suffix when empty', () => {
    expect(renderMasked('ct', '')).toBe('!masked[ct]')
  })

  it('escapes double quotes in labels', () => {
    expect(renderMasked('ct', 'a"b')).toBe('!masked[ct]{label="a\\"b"}')
    expect(detectMasked(renderMasked('ct', 'a"b'))).toEqual({ content: 'ct', label: 'a"b' })
  })

  it('throws on rejected label characters', () => {
    expect(() => renderMasked('ct', 'a]b')).toThrow()
    expect(() => renderMasked('ct', 'a}b')).toThrow()
  })

  it('serialization strips rejected label characters instead of throwing', () => {
    expect(maskedFieldToMarkdown('ct', 'a]b}c"')).toBe('!masked[ct]{label="abc\\""}')
  })
})

describe('markdown round-trip via remark', () => {
  it('parses an unlabeled masked field and serializes it back', () => {
    const doc = markdownToProse('token: !masked[9YhPG7an9wXmQpfHgh8Gj9kSz52icUAiPwq5xXY=]', schema)
    expect(collectMasked(doc)).toEqual([{ content: '9YhPG7an9wXmQpfHgh8Gj9kSz52icUAiPwq5xXY=', label: '' }])
    expect(proseToMarkdown(doc)).toBe('token: !masked[9YhPG7an9wXmQpfHgh8Gj9kSz52icUAiPwq5xXY=]\n')
  })

  it('parses and serializes a labeled masked field', () => {
    const md = '!masked[3fLk9AqW0sBvNcR4dEt5=]{label="DB Password"}'
    const doc = markdownToProse(md, schema)
    expect(collectMasked(doc)).toEqual([{ content: '3fLk9AqW0sBvNcR4dEt5=', label: 'DB Password' }])
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })

  it('round-trips a label containing an escaped quote', () => {
    const md = '!masked[ct]{label="a\\"b"}'
    const doc = markdownToProse(md, schema)
    expect(collectMasked(doc)).toEqual([{ content: 'ct', label: 'a"b' }])
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })

  it('round-trips emphasis-ambiguous characters inside a label', () => {
    const md = '!masked[ct]{label="a*b*c"}'
    const doc = markdownToProse(md, schema)
    expect(collectMasked(doc)).toEqual([{ content: 'ct', label: 'a*b*c' }])
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })

  it('round-trips base64 characters (+, /, =) inside the ciphertext', () => {
    const md = '!masked[Ax/==1+2]'
    const doc = markdownToProse(md, schema)
    expect(collectMasked(doc)).toEqual([{ content: 'Ax/==1+2', label: '' }])
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })

  it('treats an incomplete token as literal text', () => {
    const doc = markdownToProse('!masked[x', schema)
    expect(collectMasked(doc)).toEqual([])
    expect(doc.firstChild?.textContent).toContain('!masked[x')
  })

  it('parses a complete token embedded mid-sentence', () => {
    const doc = markdownToProse('ready !masked[abc] go', schema)
    expect(collectMasked(doc)).toEqual([{ content: 'abc', label: '' }])
  })

  it('leaves ordinary image and link syntax untouched', () => {
    const md = '![alt](image.png) and [a link](https://example.com)'
    const doc = markdownToProse(md, schema)
    expect(collectMasked(doc)).toEqual([])
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })

  it('parses a masked field inside a list item', () => {
    const md = '- !masked[ct]{label="Key"}'
    const doc = markdownToProse(md, schema)
    expect(collectMasked(doc)).toEqual([{ content: 'ct', label: 'Key' }])
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })
})
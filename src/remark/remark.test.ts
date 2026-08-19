import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { highlight } from './highlight'
import { subscript } from './sub'
import { superscript } from './sup'

function roundTrip(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(highlight.rawRemarkPlugin)
    .use(subscript.rawRemarkPlugin)
    .use(superscript.rawRemarkPlugin)
    .use(remarkStringify)

  const tree = processor.parse(md)
  const result = processor.stringify(tree)
  return result
}

describe('custom remark plugins', () => {
  it('highlight ==text== round-trips', () => {
    expect(roundTrip('hello ==world==')).toBe('hello ==world==\n')
  })

  it('subscript ~text~ round-trips', () => {
    expect(roundTrip('hello ~world~')).toBe('hello ~world~\n')
  })

  it('superscript ^text^ round-trips', () => {
    expect(roundTrip('hello ^world^')).toBe('hello ^world^\n')
  })

  it('double tilde is not consumed as subscript', () => {
    expect(roundTrip('hello ~a~ and ~b~')).toBe('hello ~a~ and ~b~\n')
  })

  it('nested marks round-trip', () => {
    expect(roundTrip('text ==bold **and** highlight== end')).toBe('text ==bold **and** highlight== end\n')
  })

  it('multiple marks on same line', () => {
    expect(roundTrip('x ~a~ and ^b^ and ==c== y')).toBe('x ~a~ and ^b^ and ==c== y\n')
  })
})

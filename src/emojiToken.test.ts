import { describe, expect, it } from 'vitest'
import { emojiTokenAt } from './emojiToken'

describe('emojiTokenAt', () => {
  it('finds a token at the start of the line', () => {
    expect(emojiTokenAt(':sm', 3)).toEqual({ query: 'sm', from: 0, to: 3 })
  })

  it('finds the empty token right after the colon', () => {
    expect(emojiTokenAt(':', 1)).toEqual({ query: '', from: 0, to: 1 })
  })

  it('defaults the caret to the end of the text handed in', () => {
    expect(emojiTokenAt(':thumbs')?.query).toBe('thumbs')
  })

  it('opens after whitespace or an opening bracket or quote', () => {
    expect(emojiTokenAt('hi :sm', 6)?.query).toBe('sm')
    expect(emojiTokenAt('see (:sm', 8)?.query).toBe('sm')
    expect(emojiTokenAt('":sm', 4)?.query).toBe('sm')
    expect(emojiTokenAt('[:sm', 4)?.query).toBe('sm')
  })

  it('opens right after an emoji, so emoji can be typed back to back', () => {
    expect(emojiTokenAt('😀:sm')?.query).toBe('sm')
    expect(emojiTokenAt('hi 😀:')?.query).toBe('')
    expect(emojiTokenAt('❤️:sm')?.query).toBe('sm')
    expect(emojiTokenAt('👍🏽:sm')?.query).toBe('sm')
    expect(emojiTokenAt('👩‍💻:sm')?.query).toBe('sm')
    expect(emojiTokenAt('🇬🇧:sm')?.query).toBe('sm')
    expect(emojiTokenAt('1️⃣:sm')?.query).toBe('sm')
    expect(emojiTokenAt('😀:sm')?.from).toBe(2)
  })

  it('does not open after a word character', () => {
    expect(emojiTokenAt('12:30', 5)).toBeNull()
    expect(emojiTokenAt('~/path:file', 11)).toBeNull()
  })

  it('only reads up to the caret', () => {
    // `:sm` typed, but the caret moved back before the `m`.
    expect(emojiTokenAt(':sm', 3)?.query).toBe('sm')
    expect(emojiTokenAt(':sm', 2)?.query).toBe('s')
  })

  it('never opens inside a formula draft', () => {
    expect(emojiTokenAt('=:sm', 4)).toBeNull()
    expect(emojiTokenAt('=SUM(A1:', 9)).toBeNull()
  })

  it('never opens while typing a cell range reference', () => {
    expect(emojiTokenAt('A1:', 3)).toBeNull()
    expect(emojiTokenAt('  B12:', 6)).toBeNull()
  })
})

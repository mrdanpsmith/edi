import { describe, expect, it } from 'vitest'
import { EMOJI_ENTRIES, matchEmoji, type EmojiEntry } from './emoji'

const entries: EmojiEntry[] = [
  { name: 'grinning face', emoji: '😀', keywords: ['smile'] },
  { name: 'smiling face', emoji: '😊', keywords: [] },
  { name: 'rocket', emoji: '🚀', keywords: ['ship'] },
  { name: 'thumbs up', emoji: '👍', keywords: ['+1', 'approve'] },
]

describe('matchEmoji', () => {
  it('ranks a name prefix above a keyword prefix', () => {
    const result = matchEmoji(entries, 'sm')
    // "smiling face" starts with "sm" (0); "grinning face"'s keyword "smile"
    // starts with it (1).
    expect(result.map((entry) => entry.emoji)).toEqual(['😊', '😀'])
  })

  it('matches keywords, including short forms', () => {
    expect(matchEmoji(entries, '+1').map((entry) => entry.emoji)).toContain('👍')
    expect(matchEmoji(entries, 'ship').map((entry) => entry.emoji)).toContain('🚀')
  })

  it('matches a substring of the name, after prefixes', () => {
    expect(matchEmoji(entries, 'face').map((entry) => entry.emoji)).toEqual(['😀', '😊'])
  })

  it('is case-insensitive', () => {
    expect(matchEmoji(entries, 'ROCKET')[0]!.emoji).toBe('🚀')
  })

  it('caps the result at the limit and keeps canonical order for ties', () => {
    expect(matchEmoji(entries, 'a')).toHaveLength(3)
    expect(matchEmoji(entries, 'face', 1)).toHaveLength(1)
  })

  it('returns the head of the list for an empty query', () => {
    expect(matchEmoji(entries, '').map((entry) => entry.emoji)).toEqual(['😀', '😊', '🚀', '👍'])
  })

  it('returns nothing for an unknown query', () => {
    expect(matchEmoji(entries, 'zzzzzz')).toEqual([])
  })

  it('works against the real, package-backed data', () => {
    expect(EMOJI_ENTRIES.length).toBeGreaterThan(1000)
    expect(matchEmoji(EMOJI_ENTRIES, 'grinning')[0]!.emoji).toBe('😀')
    expect(matchEmoji(EMOJI_ENTRIES, 'thumbsup')[0]!.emoji).toBe('👍')
    expect(matchEmoji(EMOJI_ENTRIES, 'rocket')[0]!.emoji).toBe('🚀')
  })
})

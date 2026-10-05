/**
 * The one rule for "is the caret inside a `:emoji` token?", shared by the body
 * text, the table cells and the block source editor so the three surfaces can
 * never disagree about when to offer emoji.
 */
export interface EmojiToken {
  /** The text between `:` and the caret (may be empty). */
  query: string
  /** Index of the `:` in the text that was handed in. */
  from: number
  /** The caret index (`from` + 1 + query.length). */
  to: number
}

/** `:` plus the characters an emoji name/alias may use, ending at the caret. */
const TOKEN = /:([A-Za-z0-9_+-]*)$/
/** A `:` only opens a token at the start or after one of these. */
const BOUNDARY = /[\s([{'"]/
/** `A1:` is the start of `A1:B2`, not an emoji token. */
const RANGE_REF = /\b[A-Za-z]{1,3}[0-9]+:$/

/**
 * The emoji token ending at `caret`, or null. `textBeforeCaret` is the text of
 * the caret's line/textblock up to the caret.
 *
 * The boundary guard keeps `12:30` and `~/path:file` from triggering. Two
 * extra guards make a table cell safe: a draft that starts with `=` is a
 * formula (never an emoji), and a run that already looks like a cell reference
 * (`A1:`) is a range, not a token.
 */
export function emojiTokenAt(
  textBeforeCaret: string,
  caret: number = textBeforeCaret.length,
): EmojiToken | null {
  if (caret < 1) return null
  const before = textBeforeCaret.slice(0, caret)
  // A formula's leading `=` is part of the text before the caret.
  if (before.trimStart().startsWith('=')) return null
  const match = TOKEN.exec(before)
  if (!match) return null
  const query = match[1]!
  const from = caret - query.length - 1
  const preceding = from > 0 ? before[from - 1]! : ''
  if (preceding && !BOUNDARY.test(preceding)) return null
  if (RANGE_REF.test(before.slice(0, from + 1))) return null
  return { query, from, to: caret }
}

/**
 * How guessable a new password is, for the hint under the password field.
 *
 * zxcvbn-ts with only the common-password list and keyboard layouts: it catches
 * `P@ssw0rd`, `Password2024!` and `qwerty123` without carrying whole-language word
 * lists. The checker's dictionaries are built on first use — the first dialog that
 * asks, not startup.
 *
 * A hint, never a rule: a weak password is still accepted.
 */
import { ZxcvbnFactory } from '@zxcvbn-ts/core'
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common'

export interface PasswordStrength {
  /** 0 (trivially guessed) to 4 (very hard to guess). */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  /** Why it is weak, when the checker can say. */
  warning: string | null
}

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const

const WARNINGS: Record<string, string> = {
  straightRow: 'Straight rows of keys are easy to guess.',
  keyPattern: 'Short keyboard patterns are easy to guess.',
  simpleRepeat: 'Repeated characters like "aaa" are easy to guess.',
  extendedRepeat: 'Repeated patterns like "abcabc" are easy to guess.',
  sequences: 'Sequences like "abc" or "123" are easy to guess.',
  recentYears: 'Recent years are easy to guess.',
  dates: 'Dates are easy to guess.',
  topTen: 'This is one of the most used passwords.',
  topHundred: 'This is a very commonly used password.',
  common: 'This is a commonly used password.',
  similarToCommon: 'This is similar to a commonly used password.',
  wordByItself: 'Single words are easy to guess.',
  namesByThemselves: 'Single names are easy to guess.',
  commonNames: 'Common names are easy to guess.',
}

let checker: ZxcvbnFactory | null = null

export function passwordStrength(password: string): PasswordStrength | null {
  if (password === '') return null
  checker ??= new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs })
  const result = checker.check(password)
  const key = result.feedback.warning
  return {
    score: result.score,
    label: LABELS[result.score],
    warning: key ? (WARNINGS[key] ?? null) : null,
  }
}

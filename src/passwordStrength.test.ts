import { describe, expect, it } from 'vitest'
import { passwordStrength } from './passwordStrength'

describe('passwordStrength', () => {
  it('says nothing about an empty password', () => {
    expect(passwordStrength('')).toBeNull()
  })

  it('sees through substitutions, capitals and padding on common passwords', () => {
    for (const weak of ['P@ssw0rd', 'qwerty123', 'Password1']) {
      const strength = passwordStrength(weak)!
      expect(strength.score, weak).toBeLessThanOrEqual(1)
      expect(strength.warning, weak).not.toBeNull()
    }
  })

  it('rates a long random password as strong', () => {
    expect(passwordStrength('xK9#mQ2$vL7!wR4@')!.score).toBe(4)
  })

  it('names every score in words', () => {
    expect(passwordStrength('P@ssw0rd')!.label).toBe('Very weak')
    expect(passwordStrength('xK9#mQ2$vL7!wR4@')!.label).toBe('Very strong')
  })
})

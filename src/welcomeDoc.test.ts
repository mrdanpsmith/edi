import { describe, expect, it } from 'vitest'

import { BUILTIN_FORMULAS } from './formulas'
import { buildWelcomeMarkdown } from './welcomeDoc'

describe('buildWelcomeMarkdown', () => {
  const welcome = buildWelcomeMarkdown()

  // Same shape of regression as `formulaReference.test.ts`: `{{BUILTIN_FUNCTIONS}}`
  // is a marker in `src/docs/welcome.md`, so losing it is silent.
  it('fills every placeholder, so no template marker reaches the reader', () => {
    expect(welcome).not.toContain('{{')
  })

  it('names every builtin, so the welcome page cannot drift from the evaluator', () => {
    for (const fn of BUILTIN_FORMULAS) {
      expect(welcome).toContain(`\`${fn.name}\``)
    }
  })

  it('keeps the hand-written prose from the template', () => {
    expect(welcome).toContain('# Welcome to Edi')
    expect(welcome).toContain('## Spreadsheet tables')
    expect(welcome).toContain('## Executable code blocks')
  })
})

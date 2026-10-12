import { describe, expect, it } from 'vitest'

import { BUILTIN_FORMULAS, num, type FormulaFunction } from './formulas'
import { buildFunctionReferenceMarkdown } from './formulaReference'

/** A document-defined function, as `documentFunctionsFor` would hand one over. */
const DOUBLE: FormulaFunction = {
  name: 'DOUBLE',
  category: 'custom',
  signature: 'DOUBLE(number)',
  summary: 'Twice the number.',
  example: '=DOUBLE(21)',
  minArgs: 1,
  maxArgs: 1,
  call: (args) => num(2 * Number(args[0])),
}

describe('buildFunctionReferenceMarkdown', () => {
  const reference = buildFunctionReferenceMarkdown()

  it('fills every placeholder, so no template marker reaches the reader', () => {
    expect(reference).not.toContain('{{')
  })

  // The regression this file exists for: `{{BUILTINS}}` is a *marker*, so
  // deleting it from `src/docs/formula-reference.md` is invisible — the
  // reference would just quietly lose its function list, with nothing failing.
  // Naming every signature closes that.
  it('lists every builtin, so the docs cannot drift from the evaluator', () => {
    for (const fn of BUILTIN_FORMULAS) {
      expect(reference).toContain(`- **\`${fn.signature}\`** — ${fn.summary}`)
    }
  })

  it('keeps the hand-written prose from the template', () => {
    for (const section of [
      '# Formula & Function Reference',
      '## Operators and references',
      '## Built-in functions',
      '## Errors',
      '## Defining your own functions',
    ]) {
      expect(reference).toContain(section)
    }
  })

  it('groups builtins under a heading per category', () => {
    for (const heading of [
      '### Aggregate',
      '### Math',
      '### Logical',
      '### Text',
      '### Lookup',
      '### Date',
      '### Utility',
    ]) {
      expect(reference).toContain(heading)
    }
  })

  it('leaves the document-functions section out when the document defines none', () => {
    expect(reference).not.toContain('## Functions in this document')
  })

  it('lists document-defined functions in their own section when present', () => {
    const withDefs = buildFunctionReferenceMarkdown([DOUBLE])
    expect(withDefs).toContain('## Functions in this document')
    expect(withDefs).toContain('- **`DOUBLE(number)`** — Twice the number.')
    expect(withDefs).toContain('Example: `=DOUBLE(21)`')
    // A document function belongs in its own section, not under a builtin one.
    expect(withDefs).not.toContain('### Custom')
  })
})

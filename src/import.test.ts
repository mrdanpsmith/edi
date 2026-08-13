import { describe, expect, it } from 'vitest'

import { toMarkdownTable } from './import'

describe('toMarkdownTable', () => {
  it('returns empty string for no rows', () => {
    expect(toMarkdownTable([])).toBe('')
  })

  it('builds a header and separator row', () => {
    expect(toMarkdownTable([['a', 'b']])).toBe('| a | b |\n| --- | --- |')
  })

  it('appends data rows', () => {
    const table = toMarkdownTable([
      ['name', 'value'],
      ['apple', '3'],
      ['pear', '7'],
    ])
    expect(table).toBe('| name | value |\n| --- | --- |\n| apple | 3 |\n| pear | 7 |')
  })

  it('escapes pipes and backslashes in cells', () => {
    const table = toMarkdownTable([['a|b', 'c\\d']])
    expect(table).toContain('| a\\|b | c\\\\d |')
  })

  it('turns newlines into <br>', () => {
    const table = toMarkdownTable([['line1\nline2']])
    expect(table).toContain('| line1<br>line2 |')
  })

  it('handles ragged rows', () => {
    const table = toMarkdownTable([['a', 'b'], ['only']])
    expect(table).toBe('| a | b |\n| --- | --- |\n| only |')
  })
})

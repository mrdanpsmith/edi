import { describe, expect, it } from 'vitest'

import { mermaidFenceTokens } from './mermaid'

describe('mermaidFenceTokens', () => {
  it('extracts mermaid blocks from markdown source', () => {
    const source = [
      '# Heading',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      'text',
    ].join('\n')

    expect(mermaidFenceTokens(source)).toEqual(['graph TD\n  A-->B'])
  })

  it('extracts multiple blocks', () => {
    const source = [
      '```mermaid',
      'graph LR',
      '```',
      '',
      '```mermaid',
      'pie title P',
      '  "A": 1',
      '```',
    ].join('\n')

    expect(mermaidFenceTokens(source)).toEqual(['graph LR', 'pie title P\n  "A": 1'])
  })

  it('ignores code fences in other languages', () => {
    const source = ['```python', 'print("hi")', '```', '', '```mermaid', 'graph TD', '```'].join('\n')
    expect(mermaidFenceTokens(source)).toEqual(['graph TD'])
  })

  it('returns empty array when there are no mermaid blocks', () => {
    expect(mermaidFenceTokens('# just text')).toEqual([])
  })
})

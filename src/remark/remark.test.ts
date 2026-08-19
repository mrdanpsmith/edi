import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkDeflist from 'remark-deflist'
import { highlight } from './highlight'
import { subscript } from './sub'
import { superscript } from './sup'
import { rawMermaidRemarkPlugin } from '../node/mermaid'
import { rawExecRemarkPlugin } from '../node/execblock'

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

function roundTripMermaid(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(rawMermaidRemarkPlugin)
    .use(remarkStringify)

  const tree = processor.parse(md)
  const result = processor.stringify(tree)
  return result
}

function roundTripExec(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(rawExecRemarkPlugin)
    .use(remarkStringify)

  const tree = processor.parse(md)
  const result = processor.stringify(tree)
  return result
}

function roundTripDeflist(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkDeflist as never)
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

describe('mermaid remark plugin', () => {
  it('mermaid code block round-trips', () => {
    const md = '```mermaid\ngraph TD\n    A-->B\n```\n'
    expect(roundTripMermaid(md)).toBe(md)
  })

  it('non-mermaid code blocks are not transformed', () => {
    const md = '```js\nconsole.log("hi")\n```\n'
    const result = roundTripMermaid(md)
    expect(result).toContain('```js')
  })

  it('parses mermaid block into mermaid_block AST node', () => {
    const processor = unified().use(remarkParse).use(rawMermaidRemarkPlugin)
    const tree = processor.parse('```mermaid\ngraph TD\n    A-->B\n```')
    expect(tree.children[0]).toMatchObject({
      type: 'mermaid_block',
      value: 'graph TD\n    A-->B',
    })
  })

  it('preserves mermaid content through round-trip', () => {
    const md = '```mermaid\nflowchart LR\n    A --> B --> C\n```\n'
    expect(roundTripMermaid(md)).toBe(md)
  })
})

describe('exec block remark plugin', () => {
  it('exec block with info shebang round-trips', () => {
    const md = '```#!python3\nprint("hello")\n```\n'
    expect(roundTripExec(md)).toBe(md)
  })

  it('exec block with inline shebang round-trips', () => {
    const md = '```\n#!/usr/bin/env python3\nprint("hello")\n```\n'
    expect(roundTripExec(md)).toBe(md)
  })

  it('non-exec code blocks are not transformed', () => {
    const md = '```js\nconsole.log("hi")\n```\n'
    const result = roundTripExec(md)
    expect(result).toContain('```js')
  })

  it('parses info-shebang block into exec_block AST node', () => {
    const processor = unified().use(remarkParse).use(rawExecRemarkPlugin)
    const tree = processor.parse('```#!python3\nprint("hello")\n```')
    expect(tree.children[0]).toMatchObject({
      type: 'exec_block',
      shebang: '#!python3',
      value: 'print("hello")',
    })
  })

  it('parses inline-shebang block into exec_block AST node', () => {
    const processor = unified().use(remarkParse).use(rawExecRemarkPlugin)
    const tree = processor.parse('```\n#!/usr/bin/env python3\nprint("hello")\n```')
    expect(tree.children[0]).toMatchObject({
      type: 'exec_block',
      shebang: '#!/usr/bin/env python3',
      value: '#!/usr/bin/env python3\nprint("hello")',
    })
  })

  it('preserves exec block content through round-trip', () => {
    const md = '```#!bash\necho "hello"\n```\n'
    expect(roundTripExec(md)).toBe(md)
  })
})

describe('definition list remark plugin', () => {
  it('definition list round-trips', () => {
    const md = 'Term\n:   Definition\n'
    expect(roundTripDeflist(md)).toBe(md)
  })

  it('preserves definition list content through round-trip', () => {
    const md = 'Apple\n:   A fruit\n\nBanana\n:   Another fruit\n'
    expect(roundTripDeflist(md)).toBe(md)
  })
})

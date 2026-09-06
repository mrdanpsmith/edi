import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { highlight } from './highlight'
import { subscript } from './sub'
import { superscript } from './sup'
import { remarkPlugin as rawMermaidRemarkPlugin } from '../node/mermaid'
import { markdownToProse, proseToMarkdown } from '../markdown'
import { schema } from '../schema'

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

describe('runnable code block (shebang) handling', () => {
  it('info-shebang block normalizes the shebang into the content first line', () => {
    const doc = markdownToProse('```#!python3\nprint("hello")\n```', schema)
    const block = doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('')
    expect(block.textContent).toBe('#!python3\nprint("hello")')
  })

  it('inline-shebang block keeps content as-is', () => {
    const doc = markdownToProse('```\n#!/usr/bin/env python3\nprint("hello")\n```', schema)
    const block = doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.textContent).toBe('#!/usr/bin/env python3\nprint("hello")')
  })

  it('plain code block keeps its language', () => {
    const doc = markdownToProse('```js\nconsole.log(1)\n```', schema)
    const block = doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('js')
    expect(block.textContent).toBe('console.log(1)')
  })

  it('round-trips a runnable block as a bare fence', () => {
    const md = '```\n#!/usr/bin/env python3\nprint("hello")\n```'
    const doc = markdownToProse(md, schema)
    expect(proseToMarkdown(doc)).toBe(md + '\n')
  })

  it('round-trips an info-shebang block as a bare fence', () => {
    const doc = markdownToProse('```#!python3\nprint("hello")\n```', schema)
    expect(proseToMarkdown(doc)).toBe('```\n#!python3\nprint("hello")\n```\n')
  })

  it('treats the whole info string line as the shebang', () => {
    const doc = markdownToProse('```#!/usr/bin/env python3 -m http.server\nprint("hi")\n```', schema)
    const block = doc.firstChild!
    expect(block.textContent).toBe(
      '#!/usr/bin/env python3 -m http.server\nprint("hi")',
    )
  })
})

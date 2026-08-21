import { describe, expect, it } from 'vitest'
import { Node as ProseNode, DOMParser as ProseDOMParser, DOMSerializer } from 'prosemirror-model'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'

function docFrom(md: string): ProseNode {
  return markdownToProse(md, schema)
}

function roundTrip(doc: ProseNode): ProseNode {
  const serializer = DOMSerializer.fromSchema(schema)
  const fragment = serializer.serializeFragment(doc.content)
  const container = document.createElement('div')
  container.appendChild(fragment)
  const parser = ProseDOMParser.fromSchema(schema)
  return parser.parse(container)!
}

const EXAMPLE = `# Welcome to Edi

Edi is a fast markdown editor.

## Mermaid diagrams

\`\`\`mermaid
graph TD
    A[Start] --> B[End]
\`\`\`

## Executable code blocks

\`\`\`
#!/usr/bin/env python3
print("Hello from Python!")
\`\`\`

## Tasks

- [x] Fast editing
- [ ] More features

## Ordered list

1. First
2. Second

## Blockquote

> A wise quote

## Table

| Name | Value |
| --- | --- |
| A | 1 |

## Code block

\`\`\`js
const x = 1
\`\`\`

---

A paragraph with **bold** and *italic*.
`

describe('clipboard round-trip', () => {
  const doc = docFrom(EXAMPLE)
  const rt = roundTrip(doc)
  const original = proseToMarkdown(doc)
  const restored = proseToMarkdown(rt)

  it('preserves heading level', () => {
    expect(restored).toContain('# Welcome to Edi')
    expect(restored).toContain('## Mermaid diagrams')
  })

  it('preserves mermaid block source', () => {
    expect(restored).toContain('graph TD')
    expect(restored).toContain('A[Start] --> B[End]')
  })

  it('preserves exec block source and shebang', () => {
    expect(restored).toContain('#!/usr/bin/env python3')
    expect(restored).toContain('print("Hello from Python!")')
  })

  it('preserves task list checked state', () => {
    expect(restored).toContain('- [x] Fast editing')
    expect(restored).toContain('- [ ] More features')
  })

  it('preserves ordered list', () => {
    expect(restored).toContain('1. First')
    expect(restored).toContain('2. Second')
  })

  it('preserves blockquote', () => {
    expect(restored).toContain('> A wise quote')
  })

  it('preserves table content', () => {
    expect(restored).toContain('| Name | Value |')
    expect(restored).toContain('| A | 1 |')
  })

  it('preserves code block with language', () => {
    expect(restored).toContain('```js')
    expect(restored).toContain('const x = 1')
  })

  it('preserves horizontal rule', () => {
    expect(restored).toContain('---')
  })

  it('preserves inline marks', () => {
    expect(restored).toContain('**bold**')
    expect(restored).toContain('italic')
  })

  it('round-trips cleanly', () => {
    const rt2 = roundTrip(rt)
    const restored2 = proseToMarkdown(rt2)
    expect(restored2).toBe(restored)
  })

  it('full snapshot', () => {
    const lines = restored.split('\n')
    const origLines = original.split('\n')
    const origSet = new Set(origLines.map(l => l.trim()).filter(Boolean))
    const rtSet = new Set(lines.map(l => l.trim()).filter(Boolean))
    const missing = [...origSet].filter(l => !rtSet.has(l))
    const extra = [...rtSet].filter(l => !origSet.has(l))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })
})

import { describe, it, expect, beforeAll } from 'vitest'
import mermaid from 'mermaid'
import { addKanbanCard, buildKanbanSource, parseKanban } from './mermaid-edit'

/**
 * The kanban label escaping is only correct if the real mermaid grammar agrees
 * with it, and every other test in this repo mocks `mermaid.render` — so the
 * writer's assumptions about what the parser accepts were never actually run
 * against it. This file renders for real. A `getBBox` that is the one thing
 * jsdom does not implement and mermaid cannot lay out without.
 */
beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
  const proto = SVGElement.prototype as unknown as Record<string, unknown>
  const textWidth = (el: unknown): number =>
    ((el as { textContent?: string }).textContent?.length ?? 0) * 7
  const box = (el: unknown) => {
    const w = textWidth(el)
    return { x: 0, y: 0, width: w, height: 14, top: 0, left: 0, right: w, bottom: 14 }
  }
  proto.getBBox = function (this: unknown) {
    return box(this)
  }
  proto.getComputedTextLength = function (this: unknown) {
    return textWidth(this)
  }
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  proto.getScreenCTM = () => matrix
  proto.getCTM = () => matrix
})

let uid = 0

/** Everything the board draws as text, in document order. */
async function drawText(source: string): Promise<string[]> {
  const { svg } = await mermaid.render(`esc${(uid += 1)}`, source)
  const doc = new DOMParser().parseFromString(svg as unknown as string, 'image/svg+xml')
  return Array.from(doc.querySelectorAll('.kanban-label, .nodeLabel, .kanban-card'))
    .map((node) => (node.textContent ?? '').trim())
    .filter((text) => text.length > 0)
}

const board = (card: string): string =>
  `kanban\n  col1[Todo]\n  col2[Doing]\n    [${card}]`

describe('a kanban label is escaped the way the real grammar accepts it', () => {
  it('renders a title holding a double quote', async () => {
    const title = 'He said "hi"'
    const next = addKanbanCard(board('Nothing'), 1, 0, title)
    expect(next).not.toBeNull()
    // The title is on the board as the user typed it, entity and all.
    expect(await drawText(next!)).toContain(title)
  })

  it('renders a quote beside the characters that force quoting too', async () => {
    // The case a raw quote breaks: the `(` makes the label quoted, and a raw
    // `"` inside it closes the run the quote opened, which is a parse error.
    const title = 'He said "hi" (loud) to @sam'
    const next = addKanbanCard(board('Nothing'), 1, 0, title)
    expect(next).toContain('&quot;hi&quot;')
    expect(await drawText(next!)).toContain(title)
  })

  it('renders a title that is nothing but a quote', async () => {
    const title = '"'
    const next = addKanbanCard(board('Nothing'), 1, 0, title)
    expect(await drawText(next!)).toContain(title)
  })

  it('renders the literal text &quot; as that text, not as a quote', async () => {
    const title = 'the tag &quot;x&quot;'
    const next = addKanbanCard(board('Nothing'), 1, 0, title)
    expect(next).toContain('&amp;quot;')
    expect(await drawText(next!)).toContain(title)
  })

  it('renders a column name holding a quote', async () => {
    const source = buildKanbanSource(['Todo', 'Q3 "final"'])
    expect(source).toContain('&quot;final&quot;')
    expect(await drawText(source)).toContain('Q3 "final"')
  })

  it('keeps every title the model reads back drawable', async () => {
    // The end-to-end claim: what we write, what the model reads, and what
    // mermaid draws are the same text, for the awkward titles in one pass.
    const titles = ['a"b', 'He said "hi" (loud)', '"', 'the tag &quot;x&quot;', 'x & y', '"edge" [case]']
    let source = 'kanban\n  col1[Todo]'
    for (const title of titles) {
      const next = addKanbanCard(source, 0, titles.indexOf(title), title)
      expect(next, `refused ${JSON.stringify(title)}`).not.toBeNull()
      source = next!
    }
    const drawn = await drawText(source)
    for (const title of titles) {
      expect(parseKanban(source).cards.map((card) => card.label)).toContain(title)
      expect(drawn).toContain(title)
    }
  })
})

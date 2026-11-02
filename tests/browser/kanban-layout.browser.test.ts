// Kanban card geometry, measured by a real layout engine.
//
// Ported from `test_unbreakable_kanban_titles_stay_inside_their_cards` in
// `tests/window/test_window.py`. jsdom computes no boxes, so this could only
// run against QtWebEngine before.
//
// A card is a fixed width (`kanban.sectionWidth`), so its title has to wrap
// inside it. Mermaid measures a label with `white-space: break-spaces`, which
// breaks only at whitespace, so a run with no whitespace is measured as one
// line several times the card's width. The rule that lets it break has to be
// in the stylesheet mermaid measures with (`themeCSS`): applied after the
// render, it puts the text inside the card but leaves the card the height of
// the unwrapped text.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { bootApp, waitFor, type BootedApp } from './app'

const UNBREAKABLE = 'VERY LONG TEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEXT'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

async function renderDiagram(code: string): Promise<SVGSVGElement> {
  await app.setDocument('```mermaid\n' + code + '\n```')
  await waitFor(() => document.querySelector('.mermaid .mermaid-preview svg') !== null, {
    timeout: 20_000,
    message: 'the diagram never rendered',
  })
  return document.querySelector<SVGSVGElement>('.mermaid .mermaid-preview svg')!
}

/** A label is a `foreignObject` with text in it; mermaid also draws empty ones. */
function labelOf(scope: Element): Element | undefined {
  return [...scope.querySelectorAll('foreignObject')].find(
    (fo) => (fo.textContent ?? '').trim().length > 0,
  )
}

function within(inner: DOMRect, outer: DOMRect) {
  return {
    width: inner.left >= outer.left - 1 && inner.right <= outer.right + 1,
    height: inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1,
  }
}

it('keeps unbreakable titles inside their cards and columns', async () => {
  const svg = await renderDiagram(
    `kanban\n  ${UNBREAKABLE}\n    id1[${UNBREAKABLE}]\n    id2[Second]\n  Doing\n    id3[Short]`,
  )

  const cards = [...svg.querySelectorAll('.items > g.node')].flatMap((card) => {
    const label = labelOf(card)
    if (!label) return []
    const frame = card.querySelector('rect')!.getBoundingClientRect()
    const box = label.getBoundingClientRect()
    return [{ text: label.textContent!.trim().slice(0, 10), inside: within(box, frame) }]
  })
  expect(cards.length).toBeGreaterThan(1)

  const [longCard, shortCard] = cards
  expect(longCard).toEqual({ text: 'VERY LONG ', inside: { width: true, height: true } })
  expect(shortCard.inside).toEqual({ width: true, height: true })

  // The column's name is a label too, in a band just as fixed in width.
  const band = svg.querySelector('.sections > g')!
  const bandFrame = band.querySelector('rect')!.getBoundingClientRect()
  const bandLabel = labelOf(band)!
  expect(bandLabel.textContent!.trim().slice(0, 10)).toBe('VERY LONG ')
  expect(within(bandLabel.getBoundingClientRect(), bandFrame).width).toBe(true)

  // Nothing hangs below the board it is in.
  const lowest = Math.max(
    ...[...svg.querySelectorAll('.items > g.node')].map((c) => c.getBoundingClientRect().bottom),
  )
  expect(lowest).toBeLessThanOrEqual(bandFrame.bottom + 1)
})

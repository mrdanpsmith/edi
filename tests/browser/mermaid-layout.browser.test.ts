// Mermaid layout corrections against real rendering (docs/mermaid.md).
//
// `clearSelfMessageSteps` measures mermaid's drawn labels, so these render
// real diagrams: the overlap only exists in mermaid's actual layout.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadMermaid } from '../../src/mermaid'
import { bootApp, settle, waitFor, type BootedApp } from './app'

const HEADER = 'sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n'
const MESSAGES = '  A->>B: Hello\n  B-->>A: Hi\n  A->>A: Think\n'
const AUTONUMBER = HEADER.replace('\n', '\n  autonumber\n') + MESSAGES

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const svg = (): SVGSVGElement | null => document.querySelector('.mermaid .mermaid-preview svg')

async function renderDiagram(source: string): Promise<SVGSVGElement> {
  await app.setDocument('```mermaid\n' + source + '```\n')
  await waitFor(() => svg() !== null, { timeout: 20_000, message: 'the diagram never rendered' })
  await settle()
  return svg()!
}

/** Each message label's `y`, as mermaid itself draws it, with no correction. */
async function rawLabelYs(source: string): Promise<string[]> {
  const mermaid = await loadMermaid()
  const { svg: markup } = await mermaid.render(`raw-${Date.now()}`, source)
  const holder = document.createElement('div')
  holder.innerHTML = markup
  return [...holder.querySelectorAll('text.messageText')].map((t) => t.getAttribute('y') ?? '')
}

const labelYs = (drawn: SVGSVGElement): string[] =>
  [...drawn.querySelectorAll('text.messageText')].map((t) => t.getAttribute('y') ?? '')

/** The labels of the self-message `A->>A`, whose label lines mention "Think". */
const selfLabel = (drawn: SVGSVGElement): SVGTextElement[] =>
  [...drawn.querySelectorAll<SVGTextElement>('text.messageText')].filter((t) =>
    /Think|hard/.test(t.textContent ?? ''),
  )

/**
 * The third step's circle top, from mermaid's anchor line and marker radius.
 * The marker scales with the anchor's stroke width, which mermaid's stylesheet
 * sets (2px) over the line's own `stroke-width="0"`: the drawn radius is 12.
 */
function thirdCircleTop(drawn: SVGSVGElement): number {
  const anchor = drawn.querySelectorAll('text.sequenceNumber')[2]!.previousElementSibling!
  const r = parseFloat(drawn.querySelector('marker[id$="-sequencenumber"] circle')!.getAttribute('r')!)
  const scale = parseFloat(getComputedStyle(anchor).strokeWidth)
  expect(scale).toBeGreaterThan(0)
  return parseFloat(anchor.getAttribute('y1')!) - r * scale
}

const bottomOf = (lines: SVGTextElement[]): number =>
  Math.max(...lines.map((l) => l.getBBox().y + l.getBBox().height))

describe('self-message labels with autonumber', () => {
  it('lifts the label clear of its step circle', async () => {
    const drawn = await renderDiagram(AUTONUMBER)
    expect(bottomOf(selfLabel(drawn))).toBeLessThanOrEqual(thirdCircleTop(drawn))
  })

  it('moves every line of a multi-line label together', async () => {
    const source = AUTONUMBER.replace('Think', 'Think<br/>hard')
    const raw = await rawLabelYs(source)
    const drawn = await renderDiagram(source)
    const lines = selfLabel(drawn)
    expect(lines).toHaveLength(2)
    expect(bottomOf(lines)).toBeLessThanOrEqual(thirdCircleTop(drawn))
    const all = [...drawn.querySelectorAll('text.messageText')]
    const shifts = lines.map(
      (l) => parseFloat(raw[all.indexOf(l)]!) - parseFloat(l.getAttribute('y')!),
    )
    expect(shifts[0]).toBeGreaterThan(0)
    expect(shifts[1]).toBeCloseTo(shifts[0]!)
  })

  it('leaves the other messages where mermaid drew them', async () => {
    const raw = await rawLabelYs(AUTONUMBER)
    const drawn = await renderDiagram(AUTONUMBER)
    expect(labelYs(drawn).slice(0, 2)).toEqual(raw.slice(0, 2))
  })

  it('leaves a diagram without autonumber as mermaid drew it', async () => {
    const source = HEADER + MESSAGES
    const raw = await rawLabelYs(source)
    const drawn = await renderDiagram(source)
    expect(labelYs(drawn)).toEqual(raw)
  })
})

// Mermaid colour adaptation against real rendering (docs/mermaid.md).
//
// `adaptDiagramColors` judges each native label against what is painted behind
// it, which depends on how mermaid actually lays the diagram out, so these
// render real diagrams rather than hand-built SVG.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyColorScheme } from '../../src/theme'
import { bootApp, settle, waitFor, type BootedApp } from './app'

const AUTONUMBER =
  'sequenceDiagram\n  autonumber\n  participant A as Alice\n  participant B as Bob\n' +
  '  A->>B: Hello\n  B-->>A: Hi\n  A->>A: Think'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => {
  applyColorScheme(false)
  app.dispose()
})

const svg = (): SVGSVGElement | null => document.querySelector('.mermaid .mermaid-preview svg')

async function renderDiagram(source: string): Promise<SVGSVGElement> {
  await app.setDocument('```mermaid\n' + source + '\n```\n')
  await waitFor(() => svg() !== null, { timeout: 20_000, message: 'the diagram never rendered' })
  await settle()
  return svg()!
}

describe('sequence diagram autonumber', () => {
  for (const dark of [false, true]) {
    it(`draws each step number in a different colour from its circle (${dark ? 'dark' : 'light'})`, async () => {
      applyColorScheme(dark)
      const drawn = await renderDiagram(AUTONUMBER)
      const numbers = [...drawn.querySelectorAll<SVGTextElement>('text.sequenceNumber')]
      expect(numbers.map((n) => n.textContent)).toEqual(['1', '2', '3'])
      const circle = drawn.querySelector('marker[id$="-sequencenumber"] circle')!
      const circleFill = getComputedStyle(circle).fill
      for (const number of numbers) {
        expect(getComputedStyle(number).fill).not.toBe(circleFill)
      }
    })
  }
})

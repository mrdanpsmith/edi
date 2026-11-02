// Mermaid visual edit mode and label commit, with real input (docs/mermaid.md).
//
// Ported from `test_visual_edit_mode_and_label_commit`,
// `test_leaving_edit_mode_resolves_the_label_being_edited`,
// `test_every_offered_label_rename_resolves` and
// `test_sequence_participant_wrapped_in_a_tspan_is_editable` in
// `tests/window/test_window.py`. Those synthesise mouse events in JavaScript and
// set the field's `value` directly; here Playwright moves and presses the real
// mouse over the drawn label (so the hit test, the cancelled `mousedown` that
// keeps the focus in the field, and the hover that reveals the cluster are
// all the browser's) and types into the field with real keys.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import { MOD, press, type } from './edit-helpers'

const FLOW = 'graph TD\n  A[Alpha]\n  B[Beta]\n  A -->|Yes| B'
const SEQUENCE =
  'sequenceDiagram\n  participant Alice\n  participant Bob\n' +
  '  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice'

const LABEL_TEXT =
  'text, .nodeLabel, .edgeLabel, .labelText, .loopText, .titleText, .sectionTitle, .taskText'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const svg = (): SVGSVGElement | null => document.querySelector('.mermaid .mermaid-preview svg')
const field = (): HTMLInputElement | HTMLTextAreaElement | null =>
  document.querySelector('.mermaid-edit-input')
const offered = (): Element[] => [...document.querySelectorAll('.mermaid-editables')]
const editing = (): boolean => document.querySelector('.mermaid-editing') !== null
const notice = (): boolean => document.querySelector('.mermaid-edit-notice') !== null
const drawnTexts = (): string[] =>
  [...(svg()?.querySelectorAll(LABEL_TEXT) ?? [])].map((e) => (e.textContent ?? '').trim())

/** The mermaid block's fenced source, as the document holds it now. */
function source(): string {
  let value = ''
  app.doc().descendants((node) => {
    if (node.type.name === 'mermaid_block') value = String(node.attrs.value)
  })
  return value
}

async function renderDiagram(markdown: string): Promise<void> {
  await app.setDocument(markdown)
  await waitFor(() => svg() !== null, { timeout: 20_000, message: 'the diagram never rendered' })
  await settle()
}

/**
 * Hover the block, so its cluster is revealed the way a reader reveals it,
 * then press its Edit/Done button with the real mouse.
 */
async function pressModeButton(): Promise<void> {
  const block = document.querySelector('.mermaid')!
  await pointer.move(center(block))
  const button = document.querySelector<HTMLElement>('.mermaid .block-control-interaction')!
  await waitFor(() => getComputedStyle(button.closest('.block-control-pill')!).opacity === '1', {
    message: 'the cluster never showed',
  })
  await pointer.press(center(button))
  await settle()
}

async function enterEditMode(): Promise<void> {
  await pressModeButton()
  await waitFor(() => offered().length > 0, { timeout: 15_000, message: 'no labels offered' })
}

/** Press the offered label whose text starts with `text`, and wait for its field. */
async function pressLabel(text: string): Promise<string> {
  const label = offered().find((e) => (e.textContent ?? '').trim().startsWith(text))
  if (!label) throw new Error(`no offered label ${JSON.stringify(text)}: ${offered().map((e) => e.textContent)}`)
  await pointer.press(center(label))
  await waitFor(() => field() !== null, { message: 'the label field never opened' })
  return field()!.value
}

/** Replace the open field's text with real keys, without committing it. */
async function retype(value: string): Promise<void> {
  await press('a', MOD)
  await type(value)
}

describe('edit mode', () => {
  it('the preview offers nothing until Edit is pressed, then marks every label', async () => {
    await renderDiagram('```mermaid\n' + FLOW + '\n```')
    expect(offered()).toHaveLength(0)
    await enterEditMode()
    expect(editing()).toBe(true)
    // Alpha, Beta and the "Yes" edge label.
    expect(offered().map((e) => (e.textContent ?? '').trim()).sort()).toEqual(['Alpha', 'Beta', 'Yes'])
    const button = document.querySelector('.mermaid .block-control-interaction')!
    expect(button.getAttribute('aria-label')).toBe('Done')
  })

  it('a pressed label opens a focused field seeded with its text; Enter commits and redraws', async () => {
    await renderDiagram('```mermaid\n' + FLOW + '\n```')
    await enterEditMode()
    expect(await pressLabel('Alpha')).toBe('Alpha')
    expect(document.activeElement).toBe(field())
    await retype('Renamed')
    await press('Enter')
    await waitFor(() => field() === null, { message: 'the field never closed' })
    // The bug this pins: the source was patched but the drawing kept the old
    // glyphs, because the node view skipped the re-render.
    await waitFor(() => drawnTexts().includes('Renamed'), { timeout: 15_000, message: 'redraw' })
    expect(drawnTexts()).not.toContain('Alpha')
    expect(source()).toContain('A[Renamed]')
    expect(notice()).toBe(false)
    // Still in edit mode: one rename is not the end of editing.
    expect(editing()).toBe(true)
  })

  it('Escape in the field puts the label back and leaves the source alone', async () => {
    await renderDiagram('```mermaid\n' + FLOW + '\n```')
    await enterEditMode()
    await pressLabel('Beta')
    await retype('Gamma')
    await press('Escape')
    await waitFor(() => field() === null, { message: 'the field never closed' })
    expect(source()).toBe(FLOW)
    expect(drawnTexts()).toContain('Beta')
  })

  it('one edit is one undo step, and undo redraws the old label', async () => {
    await renderDiagram('```mermaid\n' + FLOW + '\n```\n\nAfter')
    await enterEditMode()
    await pressLabel('Alpha')
    await retype('Once')
    await press('Enter')
    await waitFor(() => source().includes('A[Once]'), { message: 'commit' })
    app.menu('undo')
    await waitFor(() => source() === FLOW, { message: 'undo never restored the source' })
    await waitFor(() => drawnTexts().includes('Alpha'), { timeout: 15_000, message: 'redraw' })
  })
})

describe('leaving edit mode with a label open', () => {
  it('Done, pressed mid-edit, commits what was typed', async () => {
    // Real browser only: Done's own press keeps the field focused (its
    // `mousedown` is cancelled), so no blur will resolve it — the toggle has to.
    await renderDiagram('```mermaid\n' + FLOW + '\n```\n\nAfter the diagram')
    await enterEditMode()
    await pressLabel('Alpha')
    await retype('Beta2')
    await pressModeButton()
    await waitFor(() => !editing() && field() === null, { timeout: 15_000, message: 'Done' })
    expect(offered()).toHaveLength(0)
    expect(source()).toContain('A[Beta2]')
    await waitFor(() => drawnTexts().includes('Beta2'), { timeout: 15_000, message: 'redraw' })
  })

  it('an Alt+click in the field stays in edit mode; one outside the diagram finishes it', async () => {
    await renderDiagram('```mermaid\n' + FLOW + '\n```\n\nAfter the diagram')
    await enterEditMode()
    await pressLabel('Beta')
    await retype('Delta')

    // A click in a text field is that field's own, not a request about the
    // diagram behind it.
    await pointer.press(center(field()!), { modifiers: ['Alt'] })
    await settle()
    expect(editing()).toBe(true)
    expect(field()).not.toBeNull()

    const after = [...app.editor.querySelectorAll('p')].find((p) => p.textContent === 'After the diagram')!
    await pointer.press(center(after), { modifiers: ['Alt'] })
    await waitFor(() => !editing(), { timeout: 15_000, message: 'edit mode never ended' })
    expect(field()).toBeNull()
    expect(source()).toContain('B[Delta]')
  })
})

describe('renaming each kind of label', () => {
  it('a sequence participant, drawn inside a tspan, is renamed at both its heads', async () => {
    await renderDiagram('```mermaid\n' + SEQUENCE + '\n```')
    const actor = svg()!.querySelector('text.actor')
    expect(actor?.querySelector('tspan')).not.toBeNull() // the shape this test is about
    await enterEditMode()
    expect(document.querySelector('.mermaid img.mermaid-img')).toBeNull()
    expect(await pressLabel('Alice')).toBe('Alice')
    await retype('Zoe')
    await press('Enter')
    // Mermaid draws each participant twice (lifeline head and foot).
    await waitFor(() => drawnTexts().filter((t) => t === 'Zoe').length === 2, {
      timeout: 15_000,
      message: 'both heads redrawn',
    })
    expect(drawnTexts()).not.toContain('Alice')
  })

  it.each([
    ['class', 'classDiagram\n  class Shape {\n    +area()\n  }', 'Shape'],
    ['state', 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy', 'Idle'],
    [
      'entity-relationship',
      'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    string id PK\n    date placed\n  }',
      'CUSTOMER',
    ],
  ])('a %s diagram label is renamed and redrawn', async (_kind, code, needle) => {
    await renderDiagram('```mermaid\n' + code + '\n```')
    await enterEditMode()
    const seeded = await pressLabel(needle)
    expect(seeded).toBe(needle)
    // Append rather than replace, the way a reader fixes a typo.
    await userEvent.keyboard('{End}X')
    await press('Enter')
    const value = `${needle}X`
    await waitFor(() => drawnTexts().some((t) => t.includes(value)), {
      timeout: 15_000,
      message: `${value} never drawn`,
    })
    expect(source()).toContain(value)
    expect(document.querySelector('.mermaid-error')).toBeNull()
  })

  it('a rename mermaid refuses is kept in the source, and the notice says so', async () => {
    // `main` is mermaid's implicit first branch: renaming it points the
    // `checkout` at a branch that was never declared.
    const git =
      'gitGraph\n    commit id: "Initial commit"\n    branch develop\n    checkout develop\n' +
      '    commit id: "Feature work"\n    checkout main\n    merge develop\n    commit id: "Release v1.0"'
    await renderDiagram('```mermaid\n' + git + '\n```')
    await enterEditMode()
    await pressLabel('main')
    await userEvent.keyboard('{End}X')
    await press('Enter')
    await waitFor(() => notice(), { timeout: 15_000, message: 'no notice' })
    expect(source()).toContain('mainX')
    expect(drawnTexts().some((t) => t.includes('mainX'))).toBe(false)
  })
})

// Shared helpers for the kanban browser tests.
//
// The browser counterpart of the kanban half of `tests/mermaid_render.py`: the
// same boards, the same readings of mermaid's drawing, but the gestures are
// trusted Playwright input at real coordinates (`pointer` in `./app`) instead of
// JavaScript-synthesised PointerEvents.

import { expect } from 'vitest'
import { userEvent } from 'vitest/browser'
import { center, pointer, settle, waitFor, type BootedApp, type Point } from './app'

// --- Boards -------------------------------------------------------------------

export const KANBAN = 'kanban\n  Todo\n    id1[One]\n    id2[Two]\n  Doing\n    id3[Three]'
/** An empty middle column: mermaid draws its band sized to the header alone. */
export const KANBAN_EMPTY = 'kanban\n  Todo\n    id1[One]\n  Doing\n  Done\n    id2[Two]'
/** A board of exactly one column, which cannot be deleted. */
export const KANBAN_ONE = 'kanban\n  col1[Review]\n    id1[Ship it]'
/** A document that is only a board, leaving the scroller's white space under it. */
export const KANBAN_LONE =
  'kanban\n  col1[Todo]\n  col2[In Progress]\n  col3[Done]\n    [hi]\n    [how]\n    [are]\n    [you?]'
/** Four empty columns. */
export const KANBAN_BARE = 'kanban\n  col1[Todo]\n  col2[In progress]\n  col3[Review]\n  col4[Done]'
/** Titles holding the delimiters a bare `[…]` cannot carry, plus one bare card. */
export const KANBAN_QUOTED =
  'kanban\n  col1[Todo]\n    ["Fix (the bug)"]\n  col2["Doing (now)"]\n    id2[Plain]\n  col3[Done]'
/** A last column with nothing in it, the board the paint-order bugs were seen on. */
export const KANBAN_TRAILING_EMPTY =
  'kanban\n  col1[Todo]\n  col2[Specified]\n    [STDIN support for code blocks]\n' +
  '  col3[Doing]\n    [Kanban editor]\n  col4[Done]'

export const KANBAN_CARD_SLOT = '+ Add a card'
export const KANBAN_COLUMN_SLOT = '+ Add a column'

// --- The drawing ----------------------------------------------------------------

export function boardSvg(): SVGSVGElement {
  return document.querySelector<SVGSVGElement>('.mermaid .mermaid-preview svg')!
}

/** Every drawn card, slots included, in mermaid's order. */
export function cards(): SVGGElement[] {
  return [...document.querySelectorAll<SVGGElement>('.mermaid .items > g.node')]
}

export function cardSlots(): SVGGElement[] {
  return [...document.querySelectorAll<SVGGElement>('.mermaid .items > g.node.mermaid-kanban-slot')]
}

/** The card whose text is `text` (never a slot). */
export function cardNamed(text: string): SVGGElement {
  const card = cards().find((c) => (c.textContent ?? '').trim() === text)
  if (!card) throw new Error(`no card ${JSON.stringify(text)}`)
  return card
}

/** Every column band, the drawn column at the end included. */
export function bands(): SVGGElement[] {
  return [...document.querySelectorAll<SVGGElement>('.mermaid .sections > g')]
}

export function columnSlot(): SVGGElement | null {
  return document.querySelector<SVGGElement>('.mermaid .sections > g.mermaid-kanban-column-slot')
}

export function frameOf(band: Element): DOMRect {
  return (band.querySelector('rect') ?? band).getBoundingClientRect()
}

export function bandText(band: Element): string {
  return (band.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The column's name label (what a click renames). */
export function nameOf(band: Element): Element | null {
  return band.querySelector('.cluster-label, .cluster-title')
}

export function inside(inner: DOMRect, outer: DOMRect, slack = 1): boolean {
  return (
    inner.left >= outer.left - slack &&
    inner.right <= outer.right + slack &&
    inner.top >= outer.top - slack &&
    inner.bottom <= outer.bottom + slack
  )
}

/**
 * The board as drawn, read left to right: each real band's card titles in
 * order, slots left out. A card belongs to the band its centre is in.
 */
export function drawnBoard(): string[][] {
  const slot = columnSlot()
  const real = bands().filter((b) => b !== slot)
  const all = cards().filter((c) => !c.classList.contains('mermaid-kanban-slot'))
  return real.map((band) => {
    const frame = frameOf(band)
    return all
      .filter((c) => {
        const at = center(c)
        return at.x >= frame.left && at.x <= frame.right
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((c) => (c.textContent ?? '').trim())
  })
}

/** The fenced source of the document's (first) diagram, as ProseMirror holds it. */
export function boardSource(app: BootedApp): string {
  let found: string | null = null
  app.doc().descendants((node) => {
    if (found === null && node.type.name === 'mermaid_block') found = String(node.attrs.value)
    return found === null
  })
  if (found === null) throw new Error('the document holds no diagram')
  return found
}

export async function waitForSource(
  app: BootedApp,
  holds: (source: string) => boolean,
  message = 'the board source never changed',
): Promise<string> {
  await waitFor(() => holds(boardSource(app)), { timeout: 10_000, message })
  return boardSource(app)
}

// --- Modes ----------------------------------------------------------------------

/** Load `code` as the whole document and wait for mermaid to draw it. */
export async function renderBoard(app: BootedApp, code: string, after = ''): Promise<SVGSVGElement> {
  await app.setDocument('```mermaid\n' + code + '\n```\n' + after)
  await waitFor(() => document.querySelector('.mermaid .mermaid-preview svg') !== null, {
    timeout: 20_000,
    message: 'the diagram never rendered',
  })
  return boardSvg()
}

export function isEditing(): boolean {
  return document.querySelector('.mermaid-editing') !== null
}

/** Whether the board is drawn with its edit-mode slots and its layer is built. */
function editLayerReady(): boolean {
  return (
    isEditing() &&
    document.querySelectorAll('.mermaid-editables').length > 0 &&
    columnSlot() !== null &&
    document.querySelector('.mermaid .mermaid-kanban-chrome') !== null
  )
}

/**
 * Press the block's own Edit control, as a hand does: hover the block so its
 * control pill is revealed, then click the button.
 */
export async function enterEditMode(): Promise<void> {
  await pointer.move(center(boardSvg()))
  await settle()
  const button = document.querySelector<HTMLElement>('.mermaid .block-control-interaction')!
  expect(button.getAttribute('aria-label')).toBe('Edit')
  await pointer.press(center(button))
  await waitFor(editLayerReady, { timeout: 20_000, message: 'the board never entered edit mode' })
  await settle()
}

/** Render `code` and take it into edit mode. */
export async function openBoard(app: BootedApp, code: string, after = ''): Promise<void> {
  await renderBoard(app, code, after)
  await enterEditMode()
}

// --- Fields ---------------------------------------------------------------------

export function field(): HTMLInputElement | HTMLTextAreaElement | null {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>('.mermaid-edit-input')
}

export function fieldBox(): DOMRect {
  return document.querySelector('.mermaid-edit-field')!.getBoundingClientRect()
}

/** Wait for the one field to open and to have settled where it is placed. */
export async function waitForField(): Promise<HTMLInputElement | HTMLTextAreaElement> {
  await waitFor(() => field() !== null, { message: 'no field opened' })
  await settle()
  await waitFor(() => document.activeElement === field(), { message: 'the field never took focus' })
  return field()!
}

export async function waitForFieldClosed(): Promise<void> {
  await waitFor(() => field() === null, { message: 'the field never closed' })
}

/** Type `text` into the focused field as keystrokes. */
export async function typeInField(text: string): Promise<void> {
  await userEvent.keyboard(text.replace(/[{[]/g, (c) => c + c))
}

/** Type `text` into the open field and press Enter, then wait for it to close. */
export async function commitField(text: string): Promise<void> {
  const input = await waitForField()
  await userEvent.clear(input)
  await typeInField(text)
  await userEvent.keyboard('{Enter}')
  await waitForFieldClosed()
}

// --- Gestures -------------------------------------------------------------------

/** A real click on the visible text of a label, which opens its editor. */
export async function clickLabel(text: string): Promise<void> {
  const label = [...document.querySelectorAll('.mermaid-editables')].find(
    (el) => (el.textContent ?? '').trim() === text,
  )
  if (!label) throw new Error(`no editable label ${JSON.stringify(text)}`)
  await pointer.press(center(label))
}

/** A real click in the middle of the `index`-th drawn card slot. */
export async function clickCardSlot(index: number): Promise<SVGGElement> {
  const slot = cardSlots()[index]
  if (!slot) throw new Error(`no card slot ${index}`)
  const at = center(slot)
  const hit = document.elementFromPoint(at.x, at.y)
  expect(hit !== null && slot.contains(hit), 'the slot is the thing under its own centre').toBe(true)
  await pointer.press(at)
  return slot
}

/** A real click near the top of the drawn column at the end of the board. */
export async function clickColumnSlot(): Promise<SVGGElement> {
  const band = columnSlot()!
  const frame = frameOf(band)
  await pointer.press({ x: frame.left + frame.width / 2, y: frame.top + 12 })
  return band
}

/** The `index`-th column's `⋯`. */
export function menuButton(index: number): HTMLButtonElement {
  return document.querySelectorAll<HTMLButtonElement>('.mermaid .mermaid-kanban-menu')[index]!
}

export function menuList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.mermaid .mermaid-kanban-menu-list')
}

export function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.mermaid .mermaid-kanban-menu-item')]
}

export async function openMenu(index: number): Promise<HTMLElement> {
  await pointer.press(center(menuButton(index)))
  await waitFor(() => menuList() !== null, { message: 'the menu never opened' })
  await settle()
  return menuList()!
}

/** The delete prompt (`promptForKanbanDelete`), if one is up. */
export function deletePrompt(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.edi-dialog')
}

export async function answerDeletePrompt(answer: 'Cancel' | 'Delete'): Promise<void> {
  await waitFor(() => deletePrompt() !== null, { message: 'no delete prompt' })
  const button = [...deletePrompt()!.querySelectorAll<HTMLElement>('.edi-dialog-actions button')].find(
    (b) => (b.textContent ?? '').trim() === answer,
  )!
  await pointer.press(center(button))
  await waitFor(() => deletePrompt() === null, { message: 'the prompt never went away' })
}

/**
 * A grab point on a column's own frame: neither one of its cards nor its name.
 * Mermaid's cards are ~15px narrower than the band, so the strip down its left
 * edge belongs to the column alone.
 */
export function columnGrabPoint(band: Element): Point {
  const frame = frameOf(band)
  const label = nameOf(band)?.getBoundingClientRect() ?? null
  const covered = (x: number, y: number) =>
    cards().some((c) => {
      const r = c.getBoundingClientRect()
      return x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1
    }) ||
    (label !== null && x >= label.left - 1 && x <= label.right + 1 && y >= label.top - 1 && y <= label.bottom + 1)
  for (const dy of [0, -12, 12, -24, 24]) {
    for (let dx = 3; dx <= 14; dx += 2) {
      const x = frame.left + dx
      const y = (frame.top + frame.bottom) / 2 + dy
      if (y < frame.top + 2 || y > frame.bottom - 2) continue
      if (!covered(x, y)) return { x, y }
    }
  }
  throw new Error(`no free point on the ${bandText(band)} frame`)
}

/** The drop line, if a drag has drawn one. */
export function dropLine(): SVGLineElement | null {
  return document.querySelector<SVGLineElement>('.mermaid .kanban-drop-line')
}

export function lineShown(line: SVGLineElement | null): boolean {
  return line !== null && line.style.display !== 'none'
}

/** What answers at `at` with `elements` made hit-testable for the sample. */
export function hitWith(elements: Element[], at: Point): Element | null {
  const styled = elements as Array<Element & ElementCSSInlineStyle>
  for (const el of styled) el.style.pointerEvents = 'auto'
  const hit = document.elementFromPoint(at.x, at.y)
  for (const el of styled) el.style.pointerEvents = ''
  return hit
}

// Shared helpers for the table and spreadsheet browser tests.
//
// Everything here is read from the live page (real layout, real selection) and
// every gesture is trusted input through `pointer` / `userEvent`.

import { userEvent } from 'vitest/browser'
import { center, pointer, settle, waitFor, type BootedApp, type Point } from './app'

/**
 * The platform's command modifier. ProseMirror's `Mod-` keymaps read Meta on a
 * Mac and Control elsewhere; the app's own window shortcuts accept either.
 */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control'

/** Press `Mod` + `key` (e.g. `'c'`, `'a'`) with real keys. */
export async function modKey(key: string): Promise<void> {
  await userEvent.keyboard(`{${MOD}>}${key}{/${MOD}}`)
  await settle()
}

/** The Visual (plain) tables in the editor, in document order. */
export function plainTables(app: BootedApp): HTMLElement[] {
  return [...app.editor.querySelectorAll<HTMLElement>('.ss-plain')]
}

/** The live sheet, or null. */
export function liveSheet(app: BootedApp): HTMLElement | null {
  return app.editor.querySelector<HTMLElement>('.spreadsheet')
}

/** The live sheet's grid element. */
export function sheetGrid(app: BootedApp): HTMLElement {
  return liveSheet(app)!.querySelector<HTMLElement>('.ss-grid')!
}

/** The body cells of a Visual table whose text is exactly `text`. */
export function plainCell(table: Element, text: string): HTMLElement {
  const cell = [...table.querySelectorAll<HTMLElement>('th, td')].find(
    (c) => c.textContent === text,
  )
  if (!cell) throw new Error(`no cell ${JSON.stringify(text)}`)
  return cell
}

/** A sheet cell (`td.ss-cell`) by data row (0 is the GFM header) and column. */
export function sheetCell(app: BootedApp, row: number, col: number): HTMLElement {
  const rows = [...sheetGrid(app).querySelectorAll('tr')].filter((tr) =>
    tr.querySelector('td.ss-cell'),
  )
  const cell = rows[row]?.querySelectorAll<HTMLElement>('td.ss-cell')[col]
  if (!cell) throw new Error(`no sheet cell ${row},${col}`)
  return cell
}

/** The sheet cells currently in the grid's range (`.ss-range`). */
export function sheetRange(app: BootedApp): HTMLElement[] {
  return [...sheetGrid(app).querySelectorAll<HTMLElement>('td.ss-range')]
}

/** The viewport box of characters `[from, to)` of the first text node holding `needle`. */
export function textBox(root: Element, needle: string, from = 0, to = needle.length): DOMRect {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? '').indexOf(needle)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at + from)
    range.setEnd(node, at + to)
    return range.getBoundingClientRect()
  }
  throw new Error(`no text ${JSON.stringify(needle)}`)
}

/** The left edge of character `index` of `needle`, vertically centred. */
export function charLeft(root: Element, needle: string, index: number): Point {
  const box = textBox(root, needle, index, index + 1)
  return { x: box.left + 1, y: box.top + box.height / 2 }
}

/** The right edge of character `index` of `needle`, vertically centred. */
export function charRight(root: Element, needle: string, index: number): Point {
  const box = textBox(root, needle, index, index + 1)
  return { x: box.right - 1, y: box.top + box.height / 2 }
}

/** The paragraph (outside any table) whose text includes `needle`. */
export function paragraph(app: BootedApp, needle: string): HTMLElement {
  const p = [...app.editor.querySelectorAll<HTMLElement>('p')].find(
    (el) => !el.closest('.ss-plain, .spreadsheet') && (el.textContent ?? '').includes(needle),
  )
  if (!p) throw new Error(`no paragraph with ${JSON.stringify(needle)}`)
  return p
}

/** Cells of every Visual table carrying the app's selection fill. */
export function filledCells(app: BootedApp): HTMLElement[] {
  return [...app.editor.querySelectorAll<HTMLElement>('.ss-cell-in-selection')]
}

/** The fragment-highlight boxes drawn over Visual table text. */
export function highlightBoxes(app: BootedApp): HTMLElement[] {
  return [...app.editor.querySelectorAll<HTMLElement>('.ss-plain-selection-rect')]
}

/** Every text written to the clipboard through the bridge's `copyText`. */
export function copiedTexts(app: BootedApp): string[] {
  return app.bridge.callsTo('copyText').map((call) => String(call.payload.text))
}

/** The `copyContent` payloads (rich copies) written through the bridge. */
export function copiedContent(app: BootedApp): Array<{ html: string; text: string; markdown?: string }> {
  return app.bridge.callsTo('copyContent').map(
    (call) => call.payload as { html: string; text: string; markdown?: string },
  )
}

/**
 * Open the Visual table holding `cell` as a live sheet, with the real gesture:
 * `Alt`+click on the cell.
 */
export async function openSheetAt(app: BootedApp, cell: Element): Promise<void> {
  await pointer.press(center(cell), { modifiers: ['Alt'] })
  await waitFor(() => liveSheet(app) !== null, { message: 'the sheet never opened' })
  await settle()
}

/** Click a sheet cell and wait for it to be the grid's active cell. */
export async function clickSheetCell(app: BootedApp, row: number, col: number): Promise<void> {
  const cell = sheetCell(app, row, col)
  await pointer.press(center(cell))
  await waitFor(() => sheetCell(app, row, col).classList.contains('ss-active'), {
    message: `cell ${row},${col} never became active`,
  })
}

/** The grid's TSV-shaped text of the most recent `copyText`, or null. */
export function lastCopiedText(app: BootedApp): string | null {
  const texts = copiedTexts(app)
  return texts.length > 0 ? texts[texts.length - 1]! : null
}

// Shared helpers for the block-mode, block-control, hover-band and code-block
// browser tests. Generic geometry and input live in `./app`; these are the
// questions those tests keep asking about one block.

import { expect } from 'vitest'
import { center, nextFrames, pointer, settle, waitFor, type BootedApp, type Point } from './app'

/** The editor's top-level blocks, without the gap cursor's widget. */
export function topBlocks(app: BootedApp): HTMLElement[] {
  return [...app.editor.children].filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && !el.classList.contains('ProseMirror-gapcursor'),
  )
}

/** The block's own control strip (`.block-controls`), or null. */
export function strip(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>(':scope > .block-controls')
}

/** The visible row inside the strip. */
export function pill(block: Element): HTMLElement {
  const found = block.querySelector<HTMLElement>(':scope > .block-controls > .block-control-pill')
  if (!found) throw new Error(`no control pill on ${block.className}`)
  return found
}

/** The `aria-label`s of the block's cluster buttons, left to right. */
export function controlLabels(block: Element): string[] {
  return [...pill(block).querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '')
}

/** One of the block's cluster buttons, by its `aria-label`. */
export function control(block: Element, label: string): HTMLButtonElement {
  const button = [...pill(block).querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (!button) throw new Error(`no ${label} control; have ${JSON.stringify(controlLabels(block))}`)
  return button
}

/** Move the real mouse to `at` and wait until `element` is `:hover`. */
export async function hoverAt(at: Point, element: Element): Promise<void> {
  await pointer.move(at)
  await waitFor(() => element.matches(':hover'), { message: `hover ${element.className}` })
}

/**
 * Hover `block` and wait for its row to be shown (the reveal has a 150ms
 * opacity transition), then return the pill.
 */
export async function revealControls(block: HTMLElement, at: Point = center(block)): Promise<HTMLElement> {
  await hoverAt(at, block)
  const row = pill(block)
  await waitFor(() => getComputedStyle(row).opacity === '1', { message: 'pill revealed' })
  return row
}

/** Hover the block and press one of its cluster buttons with the real mouse. */
export async function pressControl(block: HTMLElement, label: string): Promise<void> {
  await revealControls(block)
  await pointer.press(center(control(block, label)))
  await settle()
}

/** Classify what is under viewport point `(x, y)` relative to `block`. */
export function hitKind(x: number, y: number, block: Element): string {
  const el = document.elementFromPoint(x, y)
  if (!el) return 'none'
  if (el.closest('button')) return 'button'
  if (el.closest('.block-controls')) return 'strip'
  if (block.contains(el)) return 'block'
  return el.closest('.ProseMirror') ? 'editor' : 'page'
}

export interface BandBox {
  content: string
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * The block's hover band (`::before`) as it is computed right now, in
 * viewport coordinates. With `content: none` there is no box.
 */
export function bandOf(block: HTMLElement): BandBox {
  const cs = getComputedStyle(block, '::before')
  const own = getComputedStyle(block)
  // The offsets resolve against the block's padding box.
  const r = block.getBoundingClientRect()
  const pad = {
    top: r.top + parseFloat(own.borderTopWidth),
    bottom: r.bottom - parseFloat(own.borderBottomWidth),
    left: r.left + parseFloat(own.borderLeftWidth),
    right: r.right - parseFloat(own.borderRightWidth),
  }
  return {
    content: cs.content,
    top: pad.top + parseFloat(cs.top),
    bottom: pad.bottom - parseFloat(cs.bottom),
    left: pad.left + parseFloat(cs.left),
    right: pad.right - parseFloat(cs.right),
  }
}

/** Is a band generated on `block` right now? */
export function hasBand(block: HTMLElement): boolean {
  const content = getComputedStyle(block, '::before').content
  return content !== 'none' && content !== 'normal'
}

/** The top-level block holding the DOM selection's anchor, or null. */
export function caretBlock(app: BootedApp): HTMLElement | null {
  const node = document.getSelection()?.anchorNode ?? null
  const el = node instanceof Element ? node : node?.parentElement ?? null
  if (!el) return null
  return topBlocks(app).find((block) => block.contains(el)) ?? null
}

/** The text of the paragraph holding the DOM selection's anchor. */
export function caretParagraphText(): string | null {
  const node = document.getSelection()?.anchorNode ?? null
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return el?.closest('p')?.textContent ?? null
}

/** The viewport box of character `offset` of the first occurrence of `text` under `root`. */
export function charBox(root: Element, text: string, offset = 0): DOMRect {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? '').indexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at + offset)
    range.setEnd(node, at + offset + 1)
    return range.getBoundingClientRect()
  }
  throw new Error(`no text ${JSON.stringify(text)}`)
}

/** A point inside the character box: its middle. */
export function middleOf(box: DOMRect): Point {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

/** Alt+click at `at` with the real mouse, then let the page settle. */
export async function altClick(at: Point): Promise<void> {
  await pointer.press(at, { modifiers: ['Alt'] })
  await settle()
}

/** Wait for `selector` to exist (or, with `present: false`, to be gone) in the editor. */
export async function waitForSelector(app: BootedApp, selector: string, present = true): Promise<void> {
  await waitFor(() => (app.editor.querySelector(selector) !== null) === present, {
    message: `${selector} ${present ? 'appears' : 'goes away'}`,
  })
  await nextFrames(1)
}

/**
 * Wait until every diagram in the editor is drawn and has stopped changing:
 * the same `<svg>` element with the same box for several frames. A first
 * render can be replaced by a second one (fonts, a re-measure), and a press
 * aimed at the first one then lands on nothing.
 */
export async function waitForDiagrams(app: BootedApp, count = 1): Promise<void> {
  const snapshot = (): string => {
    const svgs = [...app.editor.querySelectorAll('.mermaid svg')]
    return svgs
      .map((svg) => {
        const r = svg.getBoundingClientRect()
        return `${svg.id}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
      })
      .join('|')
  }
  await waitFor(() => app.editor.querySelectorAll('.mermaid svg').length >= count, {
    timeout: 15000,
    message: 'diagram drawn',
  })
  let last = ''
  let stable = 0
  await waitFor(
    () => {
      const now = snapshot()
      const svgs = [...app.editor.querySelectorAll('.mermaid svg')]
      const sized = svgs.every((svg) => svg.getBoundingClientRect().width > 0)
      stable = now === last && sized ? stable + 1 : 0
      last = now
      return stable >= 5
    },
    { timeout: 15000, message: 'diagram stable' },
  )
  await settle()
}

/** `setDirty(true)` calls the page has made since the bridge was last cleared. */
export function dirtyCalls(app: BootedApp): number {
  return app.bridge.callsTo('setDirty').filter((call) => call.payload.dirty === true).length
}

/** Assert the document is still `markdown`, normalising trailing whitespace. */
export function expectMarkdown(app: BootedApp, markdown: string): void {
  expect(app.markdown().trim()).toBe(markdown.trim())
}

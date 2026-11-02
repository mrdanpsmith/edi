// Helpers for the editing, find, dialog, tab, zoom and Mermaid browser tests.
//
// Everything here drives or reads the page the way `tests/browser/app.ts` does:
// trusted input from Playwright, and the live ProseMirror document read back
// through `app.doc()`. Nothing calls a command or a handler directly.

import { expect } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { pointer, settle, waitFor, type BootedApp } from './app'

/**
 * ProseMirror's `Mod`: Cmd on macOS, Ctrl elsewhere. Playwright's Chromium
 * reports the host platform, so the editor's keymaps bind to this key.
 */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control'

/** `key` pressed with `modifiers` held, in `userEvent.keyboard` syntax. */
export function chord(key: string, ...modifiers: string[]): string {
  const down = modifiers.map((m) => `{${m}>}`).join('')
  const up = [...modifiers].reverse().map((m) => `{/${m}}`).join('')
  const press = key.length === 1 ? key : `{${key}}`
  return `${down}${press}${up}`
}

/** Press `key` with `modifiers` held. */
export async function press(key: string, ...modifiers: string[]): Promise<void> {
  await userEvent.keyboard(chord(key, ...modifiers))
  await settle()
}

/** The viewport box of the character at `offset` in the first `text` inside `scope`. */
export function charBox(scope: Element, text: string, offset = 0): DOMRect {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
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

/** Press just after the last character of `text`, so the caret lands after it. */
export async function caretAfter(app: BootedApp, text: string): Promise<void> {
  const box = charBox(app.editor, text, text.length - 1)
  await pointer.press({ x: box.right - 1, y: box.top + box.height / 2 })
  await settle()
}

/**
 * Load an empty document and put the caret in its one paragraph with a real
 * press, ready to be typed into.
 */
export async function emptyDocument(app: BootedApp): Promise<void> {
  await app.setDocument('')
  const block = app.editor.firstElementChild as HTMLElement
  const r = block.getBoundingClientRect()
  await pointer.press({ x: r.left + 4, y: r.top + r.height / 2 })
  await settle()
  await waitFor(() => document.activeElement === app.editor, { message: 'editor focus' })
}

/** Type `text` with real key presses and let the page settle. */
export async function type(text: string): Promise<void> {
  await userEvent.keyboard(text)
  await settle()
}

export interface Run {
  text: string
  marks: string[]
}

/** U+00A0, the space Blink types where a plain one would collapse. */
export const NBSP = String.fromCharCode(0xa0)

/**
 * U+00A0 read as a plain space.
 *
 * The editor is `white-space: normal` (`src/styles/editor.css`), so Chromium
 * types a space that would collapse (at the end of a line, or next to an
 * inline element's edge) as U+00A0, and ProseMirror keeps the character it
 * read. That is pinned on its own in `edit-whitespace.browser.test.ts`; the
 * tests about marks and blocks compare words, not which space Blink chose.
 */
export function spaces(text: string): string {
  return text.split(NBSP).join(' ')
}

/** The text runs of the live document, each with its mark names (see `spaces`). */
export function runs(app: BootedApp): Run[] {
  const out: Run[] = []
  app.doc().descendants((node) => {
    if (node.isText) {
      out.push({ text: spaces(node.text ?? ''), marks: node.marks.map((m) => m.type.name) })
    }
  })
  return out
}

/** The top-level node type names of the live document. */
export function blockTypes(app: BootedApp): string[] {
  const out: string[] = []
  app.doc().forEach((node) => out.push(node.type.name))
  return out
}

/** The editor's top-level block element whose text contains `text`. */
export function blockWith(app: BootedApp, text: string): HTMLElement {
  const block = [...app.editor.children].find((el) => (el.textContent ?? '').includes(text))
  if (!block) throw new Error(`no block with ${JSON.stringify(text)}`)
  return block as HTMLElement
}

/** Right-click `element` with the real mouse and choose `item` from the context menu. */
export async function contextMenuItem(element: Element, item: string): Promise<void> {
  const r = element.getBoundingClientRect()
  await pointer.press({ x: r.left + 20, y: r.top + r.height / 2 }, { button: 'right' })
  await waitFor(() => document.querySelector('.edi-context-menu') !== null, { message: 'context menu' })
  await page.getByRole('menuitem', { name: item, exact: true }).click()
  await settle()
}

export const BLOCK_PASSWORD = 'correct horse battery'

/**
 * Encrypt the block holding `text` through its context menu and the Encrypt
 * dialog, typing the password into both fields, and wait for the block to
 * come back unlocked (the state a fresh encryption leaves it in).
 */
export async function encryptBlock(app: BootedApp, text: string, password = BLOCK_PASSWORD): Promise<void> {
  await contextMenuItem(blockWith(app, text), 'Encrypt…')
  await expect.element(page.getByText('Encrypt block', { exact: true })).toBeVisible()
  await page.getByLabelText('Password', { exact: true }).fill(password)
  await page.getByLabelText('Confirm password', { exact: true }).fill(password)
  await page.getByRole('dialog').getByRole('button', { name: 'Encrypt', exact: true }).click()
  await waitFor(() => app.editor.querySelector('.encrypted-block-reveal') !== null, {
    timeout: 20_000,
    message: 'the block never came back unlocked',
  })
  await settle()
}

/** The open reveal's paragraphs' text, or `[]` when the block is locked. */
export function revealedText(app: BootedApp): string[] {
  return [...app.editor.querySelectorAll('.encrypted-block-reveal p')].map((p) => spaces(p.textContent ?? ''))
}

/** The trimmed markdown of the live document (see `spaces`). */
export function md(app: BootedApp): string {
  return spaces(app.markdown()).trim()
}

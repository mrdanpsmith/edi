// Spaces typed with real keys.
//
// The editor is `white-space: normal` on purpose (`src/styles/editor.css`: a
// soft line break must not render as a hard one). In that mode a typed space
// that would collapse — at the end of a line, or at the edge of an inline
// element — is inserted by Blink as U+00A0, and ProseMirror keeps the
// character it reads from the DOM. Only real typing in a real engine shows
// this; a unit test inserts whatever text it is given.
//
// KNOWN BUGS (both `it.fails`, reported, not fixed here): the fix is a decision
// about how the editor renders whitespace (or a typed-space normalisation in
// the input path that does not break caret placement at a collapsed trailing
// space), not a one-line change.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { bootApp, type BootedApp } from './app'
import { MOD, NBSP, emptyDocument, press, type } from './edit-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

it('plain words typed with spaces are plain spaces once the next word starts', async () => {
  // The working case: Blink rewrites its U+00A0 to a space as soon as the space
  // is no longer at the end of the line.
  await emptyDocument(app)
  await type('three plain words')
  expect(app.markdown().trim()).toBe('three plain words')
})

it.fails('a space typed after an inline span is saved as a plain space', async () => {
  // Blink keeps the U+00A0 after `</code>`, and the save writes it out.
  await emptyDocument(app)
  await type('run `ls` now')
  expect(app.markdown()).not.toContain(NBSP)
})

it.fails('bold toggled after a space does not take the space into the bold', async () => {
  // "a", space, Mod+B, "bold": Blink turns the trailing U+00A0 into a space as
  // it inserts "b", so the DOM change ProseMirror reads is " b" replacing the
  // U+00A0, and the stored bold is applied to all of it. The markdown is then
  // `a** bold**`, which is not strong emphasis in CommonMark: reopening the
  // file shows literal asterisks.
  await emptyDocument(app)
  await type('a ')
  await press('b', MOD)
  await type('bold')
  expect(app.markdown().trim()).toBe('a **bold**')
})

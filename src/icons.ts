/**
 * **The icon set, and the one way an icon gets into a button.**
 *
 * A block's controls are icons rather than words: they live in the page gutter
 * beside the block (see `.block-controls` in `src/styles.css`), where the room is
 * a fixed 24px square, and a word there would either wrap or push the row out of
 * the gutter. The words did not go away — they moved into `aria-label` and
 * `title`, which is where a control's name belongs once the face is a picture.
 *
 * Every icon is a stroked 24×24 drawing in `currentColor`, so one set survives the
 * light and dark schemes without a second palette, and `paintIcon` is the single
 * place a button's face and its accessible name are written together. Writing
 * them apart is how an icon button ends up describing the action it *was* when it
 * was built: the block-mode buttons repaint from the record on every mode change,
 * so a face and a name set in two places drift by exactly one mode flip.
 */

/** Wrap 24×24 path markup in the `<svg>` every icon in the app is drawn in. */
export function icon(markup: string, viewBox = '0 0 16 16'): string {
  return (
    `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" ` +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${markup}</svg>`
  )
}

/** `</>` — show this block as the markdown it is. */
export const SOURCE_ICON = icon(
  '<path d="M9 18l-6-6 6-6"/><path d="M15 6l6 6-6 6"/>',
  '0 0 24 24',
)

/** An eye — back to the rendered block. */
export const VISUAL_ICON = icon(
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  '0 0 24 24',
)

/** A pencil — the interaction axis at rest. */
export const EDIT_ICON = icon(
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  '0 0 24 24',
)

/** A tick — the interaction axis engaged, and a Copy that has copied. */
export const CHECK_ICON = icon('<path d="M20 6L9 17l-5-5"/>', '0 0 24 24')

/** Two sheets — copy to the clipboard. */
export const COPY_ICON = icon(
  '<rect x="9" y="9" width="12" height="12" rx="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  '0 0 24 24',
)

/** A play triangle — run this block. */
export const RUN_ICON = icon('<path d="M7 4l13 8-13 8z"/>', '0 0 24 24')

/** A filled square — stop the run. */
export const STOP_ICON = icon(
  '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  '0 0 24 24',
)

/** A grid with a header row and a row number column — this table as a sheet. */
export const SHEET_ICON = icon(
  '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
    '<path d="M3 9h18"/><path d="M9 9v12"/>',
  '0 0 24 24',
)

/** A table with a header and rows — this table as its markdown rendering. */
export const TABLE_ICON = icon(
  '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
    '<path d="M3 10h18"/><path d="M3 14.5h18"/>',
  '0 0 24 24',
)

/** A closed padlock — the encrypted block is locked. */
export const LOCK_ICON = icon(
  '<rect x="4" y="10" width="16" height="11" rx="2"/>' +
    '<path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  '0 0 24 24',
)

/** An open padlock — the encrypted block can be shown. */
export const UNLOCK_ICON = icon(
  '<rect x="4" y="10" width="16" height="11" rx="2"/>' +
    '<path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  '0 0 24 24',
)

/** A page of writing — this encrypted block as an ordinary block. */
export const PLAIN_PAGE_ICON = icon(
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  '0 0 24 24',
)

/**
 * Give a control button its face **and** its name, together.
 *
 * `label` is the accessible name — the word the button would have had if it were
 * spelled out — and it is set as both `aria-label` (what a screen reader reads)
 * and, unless the caller overrides it, `title` (what the pointer shows). A caller
 * with more to say than the label sets `title` itself afterwards; the label stays
 * the short word so the two cannot contradict each other about *what* the button
 * is, only about how much it explains.
 */
export function paintIcon(
  button: HTMLButtonElement,
  markup: string,
  label: string,
): void {
  // Our own constant strings: no document text and no user text reaches here.
  button.innerHTML = markup
  button.setAttribute('aria-label', label)
  button.title = label
}

/**
 * Document zoom — a browser-style ladder of discrete levels applied to the
 * editor surface only, and remembered globally.
 *
 * The whole app is the chrome (tab bar, toolbar, status bar, menus, dialogs);
 * only `#editor-container` is the document. `applyZoom` writes a single CSS
 * variable that the editor content scales by, so the chrome is untouched.
 *
 * The level itself is not this module's business: `src/preferences.ts` owns
 * where it is kept, and `main.ts` owns the one write. This module owns the
 * ladder and what counts as a rung on it — which is also the clamp a stored
 * value goes through on the way back in, since `Edi.conf` is a file a person
 * can edit.
 */

export const DEFAULT_ZOOM = 1

/** Chromium's own zoom ladder, so `Ctrl +/-` feel like the rest of the app. */
export const ZOOM_LEVELS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
]

/** The nearest ladder rung to `factor`, falling back to 100% for garbage. */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_ZOOM
  let best = ZOOM_LEVELS[0]!
  for (const level of ZOOM_LEVELS) {
    if (Math.abs(level - factor) < Math.abs(best - factor)) best = level
  }
  return best
}

function levelIndex(factor: number): number {
  return ZOOM_LEVELS.indexOf(clampZoom(factor))
}

/** The next rung up, clamped at the top. */
export function zoomIn(factor: number): number {
  return ZOOM_LEVELS[Math.min(levelIndex(factor) + 1, ZOOM_LEVELS.length - 1)]!
}

/** The next rung down, clamped at the bottom. */
export function zoomOut(factor: number): number {
  return ZOOM_LEVELS[Math.max(levelIndex(factor) - 1, 0)]!
}

export function canZoomIn(factor: number): boolean {
  return levelIndex(factor) < ZOOM_LEVELS.length - 1
}

export function canZoomOut(factor: number): boolean {
  return levelIndex(factor) > 0
}

export function isDefaultZoom(factor: number): boolean {
  return clampZoom(factor) === DEFAULT_ZOOM
}

/** `"125%"` for the status indicator and the View menu. */
export function formatZoom(factor: number): string {
  return `${Math.round(clampZoom(factor) * 100)}%`
}

/** Announced on `documentElement` by `applyZoom`, with the clamped level. */
export const DOC_ZOOM_EVENT = 'edi-doc-zoom'

/**
 * Point the editor content at `factor`. The chrome lives outside
 * `#editor-container`, so it never scales; every node view's own overlay (block
 * handles, table toolbars, diagram overlays) does, because it is part of the
 * document.
 *
 * The level is also announced as an event, which is what lets a derived
 * rendering ask to be redone at the new size — a baked diagram rasterizes at
 * `2 ×` this factor (`bakeDensity` in `mermaid.ts`) and would otherwise stay a
 * bitmap made for the old one.
 */
export function applyZoom(factor: number, root: HTMLElement = document.documentElement): void {
  const level = clampZoom(factor)
  root.style.setProperty('--doc-zoom', String(level))
  root.dispatchEvent(new CustomEvent(DOC_ZOOM_EVENT, { detail: { factor: level } }))
}

/**
 * How much `el` is actually scaled by, from the CSS `zoom`s on it and its
 * ancestors.
 *
 * Anything positioned *inside* the zoomed document has two coordinate spaces to
 * keep apart: `getBoundingClientRect()` answers in viewport pixels (already
 * multiplied by the zoom), while an absolutely positioned child's `left`/`top`
 * are document pixels (the browser multiplies them on the way out). An overlay
 * that copies one into the other is wrong by the zoom factor at every level but
 * 100%, which is exactly the bug that appears only when somebody magnifies.
 *
 * `getComputedStyle(el).zoom` is the element's *own* zoom and is not inherited —
 * an element inside a zoomed ancestor reports `1` — so the product up the tree is
 * what says how many viewport pixels one document pixel is worth. A browser that
 * does not know `zoom` at all reports nothing parseable, which is `1`.
 */
export function effectiveZoom(el: Element | null): number {
  let factor = 1
  for (let node = el; node !== null; node = node.parentElement) {
    const own = Number.parseFloat(getComputedStyle(node).getPropertyValue('zoom'))
    if (Number.isFinite(own) && own > 0) factor *= own
  }
  return factor
}

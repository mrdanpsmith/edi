/**
 * The hover band — the faint band behind the block under the pointer, which is
 * how the page says *which block would Alt+click alter?* — as a persisted
 * View-menu option, on by default.
 *
 * The band is a stylesheet affordance and nothing else: one `::before` rule in
 * `src/styles.css`, keyed off the control cluster's own block list. So this
 * module owns the two halves of the option no stylesheet can hold — where the
 * user's answer is kept, and the one class that reports it — and nothing else.
 * Turning the band off puts `edi-hover-band-off` on `documentElement`, and that
 * class resolves the band's `content` to `none`: the pseudo-element is *not
 * generated* rather than generated and hidden, so an off band leaves no box in
 * the block's paint tree and nothing to reason about at the far end of it.
 *
 * The answer is persisted in the shell's settings store, on by default; see
 * `src/preferences.ts` for why it is not `localStorage`.
 */
import { currentPreferences, savePreference } from './preferences'

const OFF_CLASS = 'edi-hover-band-off'

/** On unless the user has turned it off: it is the answer to an Alt+click. */
export const DEFAULT_HOVER_BAND = true

export function isHoverBandEnabled(): boolean {
  return currentPreferences().hoverBand
}

/** Apply an answer to the page. Safe to call before the editor exists. */
export function applyHoverBand(value: boolean): void {
  document.documentElement.classList.toggle(OFF_CLASS, !value)
}

export function setHoverBand(value: boolean): void {
  applyHoverBand(value)
  savePreference('hoverBand', value)
}

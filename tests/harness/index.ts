// Typed test harness for the real WebEngine page.
//
// This module is built as a second Vite entry (dist/harness.js) and its
// contents are inlined into runJavaScript by the Python test helpers. It must
// stay a single self-contained bundle (no runtime import()).

export interface HarnessDump {
  [key: string]: unknown
}

declare global {
  interface Window {
    __ediHarness?: EdiHarness
  }
}

export interface EdiHarness {
  version: string
  dump(script: string): string
  pressAt(x: number, y: number, type?: string): void
  ediWaitHint: string
}

function dump(script: string): string {
  // Evaluate a page expression and serialise it so Python can json.loads it.
  const value = eval(script)
  return JSON.stringify(value ?? null)
}

function pressAt(x: number, y: number, type: string = 'click'): void {
  const el = document.elementFromPoint(x, y)
  if (!el) return
  const init: MouseEventInit = { bubbles: true, button: 0, clientX: x, clientY: y }
  el.dispatchEvent(new MouseEvent(type, init))
}

const harness: EdiHarness = {
  version: '1',
  dump,
  pressAt,
  ediWaitHint: 'harness loaded',
}

window.__ediHarness = harness

// Also expose a couple of convenience globals the Python helpers look for.
;(window as unknown as { ediDump?: (s: string) => string }).ediDump = dump
;(window as unknown as { ediPressAt?: (x: number, y: number, t?: string) => void }).ediPressAt = pressAt

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyZoom,
  canZoomIn,
  canZoomOut,
  clampZoom,
  DEFAULT_ZOOM,
  DOC_ZOOM_EVENT,
  effectiveZoom,
  formatZoom,
  isDefaultZoom,
  zoomIn,
  zoomOut,
} from './zoom'

beforeEach(() => {
  document.documentElement.style.removeProperty('--doc-zoom')
})

describe('zoom ladder', () => {
  it('steps up and down the browser ladder', () => {
    expect(zoomIn(1)).toBe(1.1)
    expect(zoomOut(1)).toBe(0.9)
    expect(zoomIn(0.9)).toBe(1)
  })

  it('clamps at the ends', () => {
    expect(zoomIn(3)).toBe(3)
    expect(zoomOut(0.5)).toBe(0.5)
    expect(canZoomIn(3)).toBe(false)
    expect(canZoomOut(0.5)).toBe(false)
    expect(canZoomIn(1)).toBe(true)
    expect(canZoomOut(1)).toBe(true)
  })

  it('snaps a non-ladder factor to the nearest rung', () => {
    expect(clampZoom(1.23)).toBe(1.25)
    expect(clampZoom(0)).toBe(0.5)
    expect(clampZoom(99)).toBe(3)
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM)
  })

  it('formats a percentage and recognises 100%', () => {
    expect(formatZoom(1.25)).toBe('125%')
    expect(formatZoom(1)).toBe('100%')
    expect(isDefaultZoom(1)).toBe(true)
    expect(isDefaultZoom(1.05)).toBe(true) // snaps to 1
    expect(isDefaultZoom(1.25)).toBe(false)
  })
})

describe('zoom persistence', () => {
  // The level is stored by the shell, not by the page (`src/preferences.ts`),
  // so there is nothing to round-trip here: what is left for this module to
  // answer is what counts as a stored level, which is the clamp. A saved
  // 1.23 comes back as the rung nearest it, and nonsense as 100%.
  it('clamps a stored level onto the ladder', () => {
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(Number('nonsense'))).toBe(1)
    expect(clampZoom(1.23)).toBe(1.25)
  })
})

describe('applyZoom', () => {
  it('writes the factor to the document CSS variable, clamped', () => {
    applyZoom(1.5)
    expect(document.documentElement.style.getPropertyValue('--doc-zoom')).toBe('1.5')
    applyZoom(99)
    expect(document.documentElement.style.getPropertyValue('--doc-zoom')).toBe('3')
  })

  it('announces the level, so a derived rendering can redraw at the new size', () => {
    const seen: number[] = []
    const listener = (event: Event): void => {
      seen.push(Number((event as CustomEvent<{ factor: number }>).detail.factor))
    }
    document.documentElement.addEventListener(DOC_ZOOM_EVENT, listener)
    try {
      applyZoom(1.5)
      applyZoom(1.23)
    } finally {
      document.documentElement.removeEventListener(DOC_ZOOM_EVENT, listener)
    }
    // The announced level is the *clamped* one — the same number written to the
    // CSS variable, so a listener cannot redraw at a size that was never used.
    expect(seen).toEqual([1.5, 1.25])
  })
})

describe('effectiveZoom', () => {
  /** A document whose elements report `own` zoom for themselves, as Chrome does. */
  function withZoom(own: Map<Element, string>) {
    const original = globalThis.getComputedStyle
    vi.stubGlobal('getComputedStyle', (el: Element) => ({
      getPropertyValue: (property: string): string =>
        property === 'zoom' ? (own.get(el) ?? '1') : original(el).getPropertyValue(property),
    }))
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('multiplies the zoom of every ancestor, since zoom is not inherited', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    outer.appendChild(inner)
    document.body.appendChild(outer)
    // Chrome reports a descendant's *own* zoom and not its ancestor's — a label
    // inside a magnified editor answers `1` — so the product is what says how
    // many viewport pixels one document pixel is worth.
    withZoom(
      new Map([
        [outer, '1.5'],
        [document.body, '2'],
      ]),
    )
    try {
      expect(effectiveZoom(inner)).toBe(3)
    } finally {
      outer.remove()
      vi.unstubAllGlobals()
    }
  })

  it('is 1 where nothing is magnified, and where a browser reports no zoom', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    withZoom(
      new Map([
        [el, ''],
        [document.body, 'nonsense'],
      ]),
    )
    try {
      expect(effectiveZoom(el)).toBe(1)
      expect(effectiveZoom(null)).toBe(1)
    } finally {
      el.remove()
      vi.unstubAllGlobals()
    }
  })
})

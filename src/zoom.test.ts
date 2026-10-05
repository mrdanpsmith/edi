import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyZoom,
  canZoomIn,
  canZoomOut,
  clampZoom,
  DEFAULT_ZOOM,
  formatZoom,
  isDefaultZoom,
  loadZoom,
  saveZoom,
  zoomIn,
  zoomOut,
} from './zoom'

beforeEach(() => {
  localStorage.clear()
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
  it('round-trips through localStorage', () => {
    saveZoom(1.5)
    expect(localStorage.getItem('edi.zoom')).toBe('1.5')
    expect(loadZoom()).toBe(1.5)
  })

  it('falls back to 100% when unset or unusable', () => {
    expect(loadZoom()).toBe(1)
    localStorage.setItem('edi.zoom', 'nonsense')
    expect(loadZoom()).toBe(1)
    localStorage.setItem('edi.zoom', '1.23')
    expect(loadZoom()).toBe(1.25)
  })
})

describe('applyZoom', () => {
  it('writes the factor to the document CSS variable, clamped', () => {
    applyZoom(1.5)
    expect(document.documentElement.style.getPropertyValue('--doc-zoom')).toBe('1.5')
    applyZoom(99)
    expect(document.documentElement.style.getPropertyValue('--doc-zoom')).toBe('3')
  })
})

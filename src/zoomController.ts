import { savePreference } from './preferences'
import {
  applyZoom,
  clampZoom,
  formatZoom,
  isDefaultZoom,
  zoomIn,
  zoomOut,
} from './zoom'
import type { AppContext } from './appContext'

export interface ZoomController {
  set(factor: number): void
  setFromLevel(level?: string): void
  onWheel(event: WheelEvent): void
  updateIndicator(): void
}

export function createZoomController(ctx: AppContext): ZoomController {
  let lastWheel = 0

  function updateIndicator(): void {
    ctx.roots.statusZoom.textContent = formatZoom(ctx.documentZoom)
    ctx.roots.statusZoom.hidden = isDefaultZoom(ctx.documentZoom)
  }

  function set(factor: number): void {
    ctx.documentZoom = clampZoom(factor)
    applyZoom(ctx.documentZoom)
    savePreference('zoomFactor', ctx.documentZoom)
    updateIndicator()
    ctx.syncMenuState()
  }

  function setFromLevel(level?: string): void {
    const factor = Number(level)
    if (Number.isFinite(factor)) set(factor)
  }

  /**
   * Ctrl+wheel / trackpad pinch zooms the document. It is throttled so a single
   * gesture is a step, not a burst, and `preventDefault` keeps Chromium's
   * whole-page zoom (which would scale the tab bar too) from firing.
   */
  function onWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const now = Date.now()
    if (now - lastWheel < 100) return
    lastWheel = now
    if (event.deltaY < 0) set(zoomIn(ctx.documentZoom))
    else if (event.deltaY > 0) set(zoomOut(ctx.documentZoom))
  }

  return { set, setFromLevel, onWheel, updateIndicator }
}

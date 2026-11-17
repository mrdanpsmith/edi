// Layout corrections for mermaid's rendered SVG, applied after each render
// alongside the colour adaptation. Re-exported from `mermaid.ts`.

import { selfMessageSteps } from './mermaid-dom'

/** Space left between a lifted label and the step circle under it. */
const STEP_CLEARANCE = 2

function numberAttr(el: Element, name: string, fallback: number): number {
  const value = parseFloat(el.getAttribute(name) ?? '')
  return Number.isFinite(value) ? value : fallback
}

/**
 * The top edge of a step circle, in the diagram's user space.
 *
 * The circle is the anchor line's `marker-start`: the marker's `refX`/`refY`
 * point sits on the line's start, and the marker scales with the line's stroke
 * width unless its `markerUnits` say otherwise.
 */
function stepCircleTop(step: { anchor: SVGLineElement; circle: SVGCircleElement }): number {
  const marker = step.circle.closest('marker')
  const refY = marker ? numberAttr(marker, 'refY', 0) : 0
  const userSpace = marker?.getAttribute('markerUnits') === 'userSpaceOnUse'
  const stroke = parseFloat(getComputedStyle(step.anchor).strokeWidth)
  const scale = userSpace || !Number.isFinite(stroke) || stroke <= 0 ? 1 : stroke
  const cy = numberAttr(step.circle, 'cy', 0)
  const r = numberAttr(step.circle, 'r', 0)
  return numberAttr(step.anchor, 'y1', 0) + (cy - r - refY) * scale
}

/**
 * Lift each numbered self-message's label clear of its step circle.
 *
 * Mermaid centres a self-message's label on the lifeline, and `autonumber` puts
 * the step circle on the same lifeline just below it, so the label's last line
 * sits on the circle. The label moves up, every line together, by exactly the
 * overlap; there is room above it, because mermaid spaces messages for the
 * label's full height. Labels that already clear their circle, and every other
 * message, are left alone, so a second pass changes nothing.
 *
 * Needs real layout (`getBBox`); in an environment without it this is a no-op.
 */
export function clearSelfMessageSteps(svg: SVGSVGElement): void {
  for (const step of selfMessageSteps(svg)) {
    let bottom = -Infinity
    try {
      for (const line of step.label) {
        const box = line.getBBox()
        if (box.width > 0 || box.height > 0) bottom = Math.max(bottom, box.y + box.height)
      }
    } catch {
      return
    }
    if (!Number.isFinite(bottom)) continue
    const lift = bottom + STEP_CLEARANCE - stepCircleTop(step)
    if (lift <= 0) continue
    for (const line of step.label) {
      line.setAttribute('y', String(numberAttr(line, 'y', 0) - lift))
    }
  }
}

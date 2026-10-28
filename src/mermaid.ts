import { hasBridge, invoke } from './bridge'
import { pickImageSavePath, writeBinaryFile } from './files'
import { MERMAID_LABEL_WRAP_CSS } from './mermaid-dom'
import {
  MERMAID_THEME_LIGHT,
  MERMAID_THEME_DARK,
  pinSvgTextColors,
  adaptDiagramColors,
} from './mermaid-colors'
import {
  responsifySvg,
  bakeDiagram,
  MERMAID_IMG_CLASS,
  rasterizeSvgToBase64Png,
} from './mermaid-bake'
export * from './mermaid-bake'

const MERMAID_DARK_BACKGROUND = '#0d1117'
export * from './mermaid-colors'

export const MERMAID_LANG = 'mermaid'
export const MERMAID_CLASS = 'mermaid'

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}

export function mermaidThemeVariables(dark: boolean): Record<string, string> {
  return dark ? { ...MERMAID_THEME_DARK, background: MERMAID_DARK_BACKGROUND } : MERMAID_THEME_LIGHT
}

function baseMermaidConfig(
  themeVariables: Record<string, string>,
  dark: boolean,
): Record<string, unknown> {
  return {
    startOnLoad: false,
    // Theme choice matters: 'base' (+ a handful of overrides) is a *light* theme
    // and its unoverridden defaults stay light, so dark mode must use mermaid's
    // complete built-in 'dark' palette (backgrounds, actor fills, pie swatches,
    // grid/axis colors, …) or every diagram that reads a variable we don't set
    // falls back to a light value — e.g. white-on-white wardley/xychart labels.
    theme: dark ? 'dark' : 'base',
    themeVariables: {
      fontFamily: 'var(--font-sans)',
      ...themeVariables,
    },
    themeCSS: MERMAID_LABEL_WRAP_CSS,
  }
}

const mermaidPromise = { value: null as Promise<typeof import('mermaid')['default']> | null }

export async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidPromise.value) {
    mermaidPromise.value = import('mermaid').then((mod) => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      mod.default.initialize(baseMermaidConfig(mermaidThemeVariables(dark), dark))
      return mod.default
    })
  }
  return mermaidPromise.value
}

export async function reinitializeMermaidTheme(dark: boolean): Promise<void> {
  const mermaid = await loadMermaid()
  mermaid.initialize(baseMermaidConfig(mermaidThemeVariables(dark), dark))
}

export function errorBlock(message: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `${MERMAID_CLASS}-error`
  const title = document.createElement('strong')
  title.textContent = 'Mermaid render error'
  const pre = document.createElement('pre')
  pre.textContent = message
  el.append(title, pre)
  return el
}

/**
 * Resolve the effective fill of an SVG text element: computed style first (covers
 * CSS-rule colors), then an explicit inline/attribute walk up the ancestor chain
 * (covers cascade inheritance where the computed style is unavailable). Stops at
 * the SVG root — native SVG text that resolves to nothing is left untouched.
 */


export async function renderPendingMermaid(container: HTMLElement): Promise<void> {
  const pending = collectPendingMermaid(container)
  if (pending.length === 0) {
    return
  }

  const mermaid = await loadMermaid()
  let seed = 0
  const now = Date.now()

  for (const el of pending) {
    const code = el.textContent ?? ''
    const id = `mermaid-${now}-${seed++}`

    try {
      const { svg } = await mermaid.render(id, code)
      const holder = document.createElement('div')
      holder.className = MERMAID_CLASS
      holder.dataset.state = 'done'
      holder.innerHTML = svg
      const svgEl = holder.querySelector<SVGSVGElement>('svg')
      if (svgEl) {
        const natural = responsifySvg(svgEl)
        adaptDiagramColors(svgEl)
        pinSvgTextColors(svgEl)
        void bakeDiagram(holder, svgEl, natural)
      }
      el.replaceWith(holder)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      el.replaceWith(errorBlock(message))
    }
  }
}

export function mermaidFenceTokens(source: string): string[] {
  const blocks: string[] = []
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const match = /^\s*```\s*(mermaid)\s*$/.exec(lines[index])
    if (match) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push(body.join('\n'))
    } else {
      index += 1
    }
  }
  return blocks
}


export interface CopyMermaidResult {
  ok: boolean
  error?: string
  /** Set when a file was actually written (Save image), so callers can report it. */
  path?: string
}

/**
 * Rasterize the on-screen diagram (live SVG vector or, after a bake, the shown
 * image) to a base64 PNG at 2x the *displayed* pixel footprint, so the result
 * matches what the user sees — including the theme's background. Shared by the
 * copy and save-as-image flows.
 */
async function rasterizeMermaidSource(
  source: SVGSVGElement | HTMLImageElement,
): Promise<{ data: string | null; error: string | null }> {
  const preview = source.closest?.('.mermaid-preview') as HTMLElement | null
  const shown = preview?.querySelector<HTMLImageElement>(`.${MERMAID_IMG_CLASS}`) ?? null
  const display = shown ?? source
  const svg =
    shown !== null
      ? (preview?.querySelector<SVGSVGElement>('svg') ?? null)
      : (source as SVGSVGElement)
  if (!svg) return { data: null, error: 'Could not find the diagram' }
  const rect = display.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return { data: null, error: 'Could not rasterize the diagram' }
  }
  // 2x for a crisp result; diagrams pasted into Confluence/Word etc.
  const data = await rasterizeSvgToBase64Png(
    svg,
    Math.round(rect.width * 2),
    Math.round(rect.height * 2),
  )
  if (!data) return { data: null, error: 'Could not rasterize the diagram' }
  return { data, error: null }
}

/**
 * Copy the on-screen mermaid diagram (as PNG) to the system clipboard so it can
 * be pasted into apps with no real mermaid support, e.g. Confluence. The PNG
 * bytes are shipped to the native shell which owns the clipboard. Never throws;
 * the error message is returned so the caller can show it to the user.
 */
export async function copyMermaidAsImage(
  source: SVGSVGElement | HTMLImageElement,
): Promise<CopyMermaidResult> {
  try {
    if (!hasBridge()) {
      return {
        ok: false,
        error: 'Copying mermaid images requires the native app (no developer browser support).',
      }
    }
    const { data, error } = await rasterizeMermaidSource(source)
    if (!data) return { ok: false, error: error ?? 'Could not rasterize the diagram' }
    await invoke('copyImage', { data })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Save the on-screen mermaid diagram as a PNG file. The native shell shows a
 * save dialog first (default name from the open document); on cancel this
 * resolves immediately with ``ok: true`` (nothing to report). On confirm the
 * diagram is rasterized and written to the chosen path; ``path`` is set on
 * success so the caller can flash it in the status bar.
 */
export async function saveMermaidAsImage(
  source: SVGSVGElement | HTMLImageElement,
  defaultName: string,
): Promise<CopyMermaidResult> {
  try {
    if (!hasBridge()) {
      return {
        ok: false,
        error: 'Saving mermaid images requires the native app (no developer browser support).',
      }
    }
    const path = await pickImageSavePath(defaultName)
    if (!path) return { ok: true }
    const { data, error } = await rasterizeMermaidSource(source)
    if (!data) return { ok: false, error: error ?? 'Could not rasterize the diagram' }
    await writeBinaryFile(path, data)
    return { ok: true, path }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

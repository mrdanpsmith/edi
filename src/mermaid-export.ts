import type { Node as ProseNode } from 'prosemirror-model'
import { adaptDiagramColors, loadMermaid, pinSvgTextColors, responsifySvg } from './mermaid'
import { rasterizeSvgToBase64Png } from './mermaid-bake'

export interface MermaidPng {
  data: string
  width: number
  height: number
}

export type MermaidPngMap = ReadonlyMap<string, MermaidPng>

const RASTER_SCALE = 2
let renderSeed = 0

export async function mermaidPngSnapshots(doc: ProseNode): Promise<MermaidPngMap> {
  const snapshots = new Map<string, MermaidPng>()
  if (typeof doc.descendants !== 'function') return snapshots

  const sources = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name === 'mermaid_block') {
      sources.add(String(node.attrs.value ?? ''))
    }
    return true
  })

  for (const source of sources) {
    const png = await renderMermaidPng(source)
    if (png) snapshots.set(source, png)
  }
  return snapshots
}

export async function snapshotMermaidHtml(root: ParentNode): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-block]'))
  for (const block of blocks) {
    const source = block.getAttribute('data-mermaid-source') ?? block.textContent ?? ''
    const png = await renderMermaidPng(source)
    if (png) block.replaceWith(mermaidFigure(source, png))
  }
}

export function mermaidFigure(source: string, png: MermaidPng): HTMLElement {
  // A `div`, not a `<figure>`: Confluence flattens an expand nested in a figure.
  const figure = document.createElement('div')
  figure.className = 'mermaid-figure'
  figure.setAttribute('data-mermaid-block', '')
  figure.setAttribute('data-mermaid-source', source)

  const img = document.createElement('img')
  img.className = 'mermaid-snapshot'
  img.src = `data:image/png;base64,${png.data}`
  img.alt = 'Mermaid diagram'
  img.width = png.width
  img.height = png.height

  // Confluence turns `div[data-node-type="expand"]` into a real Expand titled by
  // `data-title`, but drops its image and flattens a `<details>`, pasting the
  // `<summary>` as a stray line. With no `<summary>`, other targets still fold
  // the source under the browser's own "Details" label.
  const expand = document.createElement('div')
  expand.setAttribute('data-node-type', 'expand')
  expand.setAttribute('data-title', 'Mermaid source')
  const details = document.createElement('details')
  details.className = 'mermaid-source'
  const pre = document.createElement('pre')
  pre.setAttribute('data-language', 'mermaid')
  const code = document.createElement('code')
  code.className = 'language-mermaid'
  code.textContent = source
  pre.append(code)
  details.append(pre)
  expand.append(details)
  figure.append(img, expand)
  return figure
}

export async function renderMermaidPng(source: string): Promise<MermaidPng | null> {
  let holder: HTMLElement | null = null
  try {
    if ('fonts' in document && document.fonts?.ready) {
      await document.fonts.ready.catch(() => undefined)
    }
    const mermaid = await loadMermaid()
    const { svg } = await mermaid.render(`mermaid-export-${renderSeed++}`, source)
    holder = document.createElement('div')
    holder.className = 'mermaid'
    holder.style.position = 'fixed'
    holder.style.left = '-100000px'
    holder.style.top = '0'
    holder.style.visibility = 'hidden'
    holder.innerHTML = svg
    document.body.appendChild(holder)

    const svgEl = holder.querySelector<SVGSVGElement>('svg')
    if (!svgEl) return null
    const size = viewBoxSize(svgEl)
    if (!size) return null
    responsifySvg(svgEl)
    adaptDiagramColors(svgEl)
    pinSvgTextColors(svgEl)

    const data = await rasterizeSvgToBase64Png(
      svgEl,
      Math.max(1, Math.round(size.width * RASTER_SCALE)),
      Math.max(1, Math.round(size.height * RASTER_SCALE)),
    )
    if (!data) return null
    return {
      data,
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    }
  } catch {
    return null
  } finally {
    holder?.remove()
  }
}

function viewBoxSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number)
  if (
    parts.length === 4 &&
    Number.isFinite(parts[2]) &&
    Number.isFinite(parts[3]) &&
    parts[2] > 0 &&
    parts[3] > 0
  ) {
    return { width: parts[2], height: parts[3] }
  }
  const width = Number.parseFloat(svg.getAttribute('width') ?? '')
  const height = Number.parseFloat(svg.getAttribute('height') ?? '')
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height }
  }
  return null
}

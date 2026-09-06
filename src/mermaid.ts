export const MERMAID_LANG = 'mermaid'
export const MERMAID_CLASS = 'mermaid'

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}

let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null

export async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      mod.default.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          fontFamily: 'var(--font-sans)',
          primaryColor: dark ? '#1d3a5f' : '#d6e4ff',
          primaryTextColor: dark ? '#e6edf3' : '#1f2328',
          primaryBorderColor: dark ? '#4d7bb5' : '#79b8ff',
          lineColor: dark ? '#8b949e' : '#57606a',
          secondaryColor: dark ? '#2f3a45' : '#f6f8fa',
          tertiaryColor: dark ? '#232a31' : '#eaeef2',
        },
      })
      return mod.default
    })
  }
  return mermaidPromise
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

export function responsifySvg(svg: SVGSVGElement): number | null {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number)
  const natural = parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : null

  svg.style.height = 'auto'
  svg.style.maxWidth = 'none'
  svg.style.minWidth = ''
  svg.style.width = natural !== null ? `${natural}px` : '100%'
  return natural
}

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function createToolbarButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'mermaid-toolbar-btn'
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  return button
}

export function attachMermaidToolbar(host: HTMLElement, svg: SVGSVGElement, natural: number | null): void {
  const zoomOut = createToolbarButton('−', 'Zoom out')
  const zoomIn = createToolbarButton('+', 'Zoom in')
  const reset = createToolbarButton('100%', 'Reset zoom')

  const bar = document.createElement('div')
  bar.className = 'mermaid-toolbar'
  bar.append(zoomOut, zoomIn, reset)
  host.appendChild(bar)

  if (natural === null) {
    zoomOut.disabled = true
    zoomIn.disabled = true
    reset.disabled = true
    return
  }

  let factor = 1

  const applyZoom = (): void => {
    svg.style.width = `${natural * factor}px`
    svg.style.minWidth = '0'
    svg.style.maxWidth = 'none'
    svg.style.height = 'auto'
  }

  const resetZoom = (): void => {
    factor = 1
    responsifySvg(svg)
  }

  bar.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  zoomIn.addEventListener('click', () => {
    factor = clamp(factor * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    applyZoom()
  })
  zoomOut.addEventListener('click', () => {
    factor = clamp(factor / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    applyZoom()
  })
  reset.addEventListener('click', resetZoom)
}

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
        attachMermaidToolbar(holder, svgEl, natural)
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

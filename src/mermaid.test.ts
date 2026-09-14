import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  renderPendingMermaid,
  mermaidFenceTokens,
  responsifySvg,
  pinSvgTextColors,
  adaptDiagramColors,
  diagramNeedsBake,
  attachMermaidToolbar,
  bakeDiagram,
  reinitializeMermaidTheme,
  copyMermaidAsImage,
  saveMermaidAsImage,
} from './mermaid'

vi.mock('./bridge', () => ({
  hasBridge: vi.fn(() => true),
  invoke: vi.fn(() => Promise.resolve()),
}))

vi.mock('./files', () => ({
  pickImageSavePath: vi.fn(() => Promise.resolve('/tmp/diagram.png')),
  writeBinaryFile: vi.fn(() => Promise.resolve()),
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

import * as mermaidModule from 'mermaid'
import * as bridgeModule from './bridge'
import * as filesModule from './files'

const mermaid = vi.mocked(mermaidModule.default)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bridgeModule.hasBridge).mockImplementation(() => true)
  vi.mocked(filesModule.pickImageSavePath).mockImplementation(() =>
    Promise.resolve('/tmp/diagram.png'),
  )
  vi.mocked(filesModule.writeBinaryFile).mockImplementation(() => Promise.resolve())
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
})

describe('renderPendingMermaid', () => {
  it('does nothing when there are no pending blocks', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>plain text</p>'
    await renderPendingMermaid(container)
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('renders each pending block and marks it done', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg id="out"></svg>', diagramType: 'base' })
    const container = document.createElement('div')
    container.innerHTML =
      '<div class="mermaid" data-state="pending">graph TD</div>' +
      '<div class="mermaid" data-state="pending">pie</div>'

    await renderPendingMermaid(container)

    expect(mermaid.render).toHaveBeenCalledTimes(2)
    expect(mermaid.initialize).toHaveBeenCalledTimes(1)
    const done = container.querySelectorAll<HTMLElement>('.mermaid[data-state="done"]')
    expect(done).toHaveLength(2)
    expect(done[0]!.querySelector('svg#out')).not.toBeNull()
    expect(done[0]!.querySelector('.mermaid-toolbar')).not.toBeNull()
    expect(container.querySelector('.mermaid[data-state="pending"]')).toBeNull()
  })

  it('renders blocks with an error banner when rendering fails', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('syntax error near line 1'))
    const container = document.createElement('div')
    container.innerHTML = '<div class="mermaid" data-state="pending">graph bad</div>'

    await renderPendingMermaid(container)

    const error = container.querySelector<HTMLElement>('.mermaid-error')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('Mermaid render error')
    expect(error!.textContent).toContain('syntax error near line 1')
  })

  it('renders an error banner with the raw error for non-Error failures', async () => {
    vi.mocked(mermaid.render).mockRejectedValue('plain failure')
    const container = document.createElement('div')
    container.innerHTML = '<div class="mermaid" data-state="pending">graph bad</div>'

    await renderPendingMermaid(container)

    const error = container.querySelector<HTMLElement>('.mermaid-error')
    expect(error!.textContent).toContain('plain failure')
  })
})

describe('responsifySvg', () => {
  function makeSvg(viewBox: string | null): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    if (viewBox !== null) svg.setAttribute('viewBox', viewBox)
    return svg
  }

  it('renders at the natural viewBox width, never larger', () => {
    const svg = makeSvg('0 0 1200 400')
    expect(responsifySvg(svg)).toBe(1200)
    expect(svg.style.width).toBe('1200px')
    expect(svg.style.height).toBe('auto')
    expect(svg.style.maxWidth).toBe('none')
    expect(svg.style.minWidth).toBe('')
  })

  it('accepts fractional viewBox widths', () => {
    const svg = makeSvg('5.5 2 1200.25 400')
    expect(responsifySvg(svg)).toBe(1200.25)
    expect(svg.style.width).toBe('1200.25px')
  })

  it('returns null and falls back to 100% width when the viewBox is unusable', () => {
    const svg = makeSvg('0 0 0 400')
    expect(responsifySvg(svg)).toBeNull()
    expect(svg.style.width).toBe('100%')
    expect(responsifySvg(makeSvg(null))).toBeNull()
    expect(responsifySvg(makeSvg('0 0 100'))).toBeNull()
  })
})

describe('attachMermaidToolbar', () => {
  function buttons(host: HTMLElement): HTMLButtonElement[] {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('.mermaid-toolbar button'))
  }

  function button(host: HTMLElement, label: string): HTMLButtonElement {
    const found = buttons(host).find((b) => b.textContent === label)
    if (!found) throw new Error(`no toolbar button "${label}"`)
    return found
  }

  function makeBlock(): { host: HTMLElement; svg: SVGSVGElement } {
    const host = document.createElement('div')
    host.className = 'mermaid'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 800 400')
    responsifySvg(svg)
    const preview = document.createElement('div')
    preview.className = 'mermaid-preview'
    preview.appendChild(svg)
    host.append(preview)
    attachMermaidToolbar(host, svg, 800)
    return { host, svg }
  }

  it('creates zoom in/out and reset buttons on the host block', () => {
    const { host } = makeBlock()
    const bar = host.querySelector<HTMLElement>('.mermaid-toolbar')
    expect(bar).not.toBeNull()
    expect(buttons(host).map((b) => b.textContent)).toEqual(['−', '+', '100%'])
  })

  it('zooms in and out in 1.25x steps from the natural width', () => {
    const { host, svg } = makeBlock()
    button(host, '+').click()
    expect(svg.style.width).toBe('1000px')
    button(host, '+').click()
    expect(svg.style.width).toBe('1250px')
    button(host, '−').click()
    expect(svg.style.width).toBe('1000px')
  })

  it('clamps the zoom factor between 0.5x and 4x', () => {
    const { host, svg } = makeBlock()
    for (let i = 0; i < 20; i++) button(host, '+').click()
    expect(svg.style.width).toBe('3200px')
    for (let i = 0; i < 40; i++) button(host, '−').click()
    expect(svg.style.width).toBe('400px')
  })

  it('reset restores the natural size', () => {
    const { host, svg } = makeBlock()
    button(host, '+').click()
    expect(svg.style.width).toBe('1000px')
    button(host, '100%').click()
    expect(svg.style.width).toBe('800px')
    expect(svg.style.minWidth).toBe('')
    expect(svg.style.maxWidth).toBe('none')
  })

  it('reset emits the zoom event so a baked image is re-rasterized', () => {
    const { host } = makeBlock()
    const seen: number[] = []
    host.addEventListener('edi-mermaid-zoom', (event) => {
      seen.push(Number((event as CustomEvent<{ factor: number }>).detail.factor))
    })
    button(host, '+').click()
    button(host, '100%').click()
    expect(seen).toEqual([1.25, 1])
  })

  it('disables the buttons when the natural width is unavailable', () => {
    const host = document.createElement('div')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    attachMermaidToolbar(host, svg, null)
    for (const b of buttons(host)) expect(b.disabled).toBe(true)
  })
})

describe('mermaidFenceTokens', () => {
  it('extracts mermaid blocks from markdown source', () => {
    const source = [
      '# Heading',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      'text',
    ].join('\n')

    expect(mermaidFenceTokens(source)).toEqual(['graph TD\n  A-->B'])
  })

  it('extracts multiple blocks', () => {
    const source = [
      '```mermaid',
      'graph LR',
      '```',
      '',
      '```mermaid',
      'pie title P',
      '  "A": 1',
      '```',
    ].join('\n')

    expect(mermaidFenceTokens(source)).toEqual(['graph LR', 'pie title P\n  "A": 1'])
  })

  it('ignores code fences in other languages', () => {
    const source = ['```python', 'print("hi")', '```', '', '```mermaid', 'graph TD', '```'].join('\n')
    expect(mermaidFenceTokens(source)).toEqual(['graph TD'])
  })

  it('returns empty array when there are no mermaid blocks', () => {
    expect(mermaidFenceTokens('# just text')).toEqual([])
  })

  it('re-initializes mermaid with the requested light base palette', async () => {
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    await reinitializeMermaidTheme(false)
    const config = vi.mocked(mermaid.initialize).mock.calls.at(-1)?.[0] as {
      theme: string
      themeVariables: Record<string, string>
    }
    expect(config.theme).toBe('base')
    expect(config.themeVariables.primaryColor).toBe('#d6e4ff')
    expect(config.themeVariables.primaryTextColor).toBe('#1f2328')
  })

  it('re-initializes mermaid with the complete dark palette for dark mode', async () => {
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia
    await reinitializeMermaidTheme(true)
    const config = vi.mocked(mermaid.initialize).mock.calls.at(-1)?.[0] as {
      theme: string
      themeVariables: Record<string, string>
    }
    expect(config.theme).toBe('dark')
    expect(config.themeVariables.primaryColor).toBe('#1d3a5f')
    expect(config.themeVariables.primaryTextColor).toBe('#e6edf3')
    // Wardley/xychart-style diagrams paint their backdrop from this variable;
    // without a dark value they go white-on-white (light labels, white bg).
    expect(config.themeVariables.background).toBe('#0d1117')
    expect(config.themeVariables.fontFamily).toBe('var(--font-sans)')
  })
})

describe('adaptDiagramColors', () => {
  function stubBBox(el: SVGElement, x: number, y: number, w: number, h: number): void {
    Object.defineProperty(el, 'getBBox', {
      configurable: true,
      value: () => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }),
    })
  }

  function makeSvg(inner: string, scheme: 'dark' | 'light' = 'dark'): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 800 600')
    document.documentElement.dataset.colorScheme = scheme
    stubBBox(svg, 0, 0, 800, 600)
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('width', '800')
    bg.setAttribute('height', '600')
    bg.setAttribute('fill', scheme === 'dark' ? '#0d1117' : '#ffffff')
    stubBBox(bg, 0, 0, 800, 600)
    svg.appendChild(bg)
    svg.insertAdjacentHTML('beforeend', inner)
    return svg
  }

  afterEach(() => {
    document.documentElement.dataset.colorScheme = 'light'
  })

  it('flips dark-on-dark text to the dark palette in dark mode', () => {
    const svg = makeSvg('<text x="10" y="30" fill="#444444">Uses</text>')
    adaptDiagramColors(svg)
    const text = svg.querySelector<SVGTextElement>('text')!
    expect(text.style.fill).toBe('#e6edf3')
    expect(text.style.color).toBe('rgb(230, 237, 243)')
  })

  it('judges text against its enclosing shape fill, not the editor bg', () => {
    const svg = makeSvg(
      '<g class="person-man"><rect x="0" y="0" width="200" height="120" fill="#08427B"></rect>' +
        '<text x="100" y="60" fill="#FFFFFF">User</text></g>',
    )
    stubBBox(svg.querySelector('rect')!, 0, 0, 200, 120)
    stubBBox(svg.querySelector('text')!, 95, 45, 10, 10)
    adaptDiagramColors(svg)
    const text = svg.querySelector<SVGTextElement>('text')!
    expect(text.style.fill).toBe('')
  })

  it('keeps theme-driven text on the diagram background', () => {
    const svg = makeSvg('<text x="10" y="30" fill="#e6edf3">label</text>')
    adaptDiagramColors(svg)
    expect(svg.querySelector<SVGTextElement>('text')!.style.fill).toBe('')
  })

  it('flips light-on-light text to the light palette in light mode', () => {
    const svg = makeSvg('<text x="10" y="30" fill="#ffffff">label</text>', 'light')
    adaptDiagramColors(svg)
    const text = svg.querySelector<SVGTextElement>('text')!
    expect(text.style.fill).toBe('#1f2328')
    expect(text.style.color).toBe('rgb(31, 35, 40)')
  })

  it('never touches foreignObject HTML labels', () => {
    const svg = makeSvg(
      '<text x="10" y="30" fill="#000000">native</text>' +
        '<foreignObject width="100" height="50"><p style="color:white">html</p></foreignObject>',
    )
    adaptDiagramColors(svg)
    expect(svg.querySelector<SVGTextElement>('text')!.style.fill).toBe('#e6edf3')
    expect(svg.querySelector<HTMLParagraphElement>('p')!.style.color).toBe('white')
  })

  it('flips near-black connector strokes and arrowheads to lineColor in dark mode', () => {
    const svg = makeSvg(
      '<g><line x1="0" y1="0" x2="100" y2="0" stroke="#444444"></line><text x="50" y="-5" fill="#444444">Uses</text></g>' +
        '<defs><marker id="m"><path d="M0 0 L10 5 z" fill="#000000"></path></marker></defs>',
    )
    adaptDiagramColors(svg)
    expect(svg.querySelector<SVGLineElement>('line')!.style.stroke).toBe('#8b949e')
    expect(svg.querySelector<SVGPathElement>('marker path')!.style.fill).toBe('#8b949e')
  })

  it('leaves theme-driven strokes (lighter lineColor) untouched in dark mode', () => {
    const svg = makeSvg('<line x1="0" y1="0" x2="100" y2="0" stroke="#8b949e"></line>')
    adaptDiagramColors(svg)
    expect(svg.querySelector<SVGLineElement>('line')!.style.stroke).toBe('')
  })

  it('does no stroke surgery in light mode', () => {
    const svg = makeSvg('<line x1="0" y1="0" x2="100" y2="0" stroke="#000000"></line>', 'light')
    adaptDiagramColors(svg)
    expect(svg.querySelector<SVGLineElement>('line')!.style.stroke).toBe('')
  })

  it('is a no-op without a scheme set', () => {
    document.documentElement.removeAttribute('data-color-scheme')
    const svg = makeSvg('<text x="10" y="30" fill="#444444">Uses</text>')
    document.documentElement.removeAttribute('data-color-scheme')
    adaptDiagramColors(svg)
    expect(svg.querySelector<SVGTextElement>('text')!.style.fill).toBe('')
  })
})

describe('pinSvgTextColors', () => {
  function host(): HTMLElement {
    const div = document.createElement('div')
    div.style.color = '#000000'
    document.body.appendChild(div)
    return div
  }

  function makeSvg(inner: string): SVGSVGElement {
    const div = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    div.innerHTML = inner
    return div
  }

  it('bakes the text fill into inline fill and color', () => {
    const h = host()
    const svg = makeSvg('<text fill="#FFFFFF">C4 label</text>')
    h.appendChild(svg)
    h.style.color = '#000000'
    pinSvgTextColors(svg)
    const text = svg.querySelector<SVGTextElement>('text')!
    expect(text.style.fill).toBe('#FFFFFF')
    expect(text.style.color).toBe('rgb(255, 255, 255)')
    h.remove()
  })

  it('uses an inline style fill when present', () => {
    const h = host()
    const svg = makeSvg(`<text style="fill: rgb(230, 237, 243)">dark label</text>`)
    h.appendChild(svg)
    pinSvgTextColors(svg)
    const text = svg.querySelector<SVGTextElement>('text')!
    expect(text.style.fill).toBe('rgb(230, 237, 243)')
    expect(text.style.color).toBe('rgb(230, 237, 243)')
    h.remove()
  })

  it('pins tspans to the same color, inheriting from the parent text', () => {
    const h = host()
    const svg = makeSvg('<text fill="#FFFFFF"><tspan>T1</tspan></text>')
    h.appendChild(svg)
    pinSvgTextColors(svg)
    const tspan = svg.querySelector<SVGTextElement>('tspan')!
    expect(tspan.style.fill).toBe('#FFFFFF')
    expect(tspan.style.color).toBe('rgb(255, 255, 255)')
    h.remove()
  })

  it('leaves HTML labels inside foreignObject untouched', () => {
    const h = host()
    const svg = makeSvg(
      '<text fill="#FFFFFF">native</text>' +
        '<foreignObject><div><span style="color:white">html</span></div></foreignObject>',
    )
    h.appendChild(svg)
    pinSvgTextColors(svg)
    expect(svg.querySelector<SVGTextElement>('text')!.style.color).toBe('rgb(255, 255, 255)')
    h.remove()
  })

  it('is a no-op when no text resolves a fill', () => {
    const h = host()
    const svg = makeSvg('<rect width="10" height="10"></rect>')
    h.appendChild(svg)
    expect(() => pinSvgTextColors(svg)).not.toThrow()
    h.remove()
  })
})

describe('diagramNeedsBake', () => {
  function makeSvg(inner: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.innerHTML = inner
    return svg
  }

  it('is true for native light text like C4 labels', () => {
    expect(
      diagramNeedsBake(makeSvg('<text fill="#FFFFFF">Bank Customer</text>')),
    ).toBe(true)
    expect(diagramNeedsBake(makeSvg('<text fill="rgb(230, 237, 243)">actor</text>'))).toBe(true)
  })

  it('is false for dark native text', () => {
    expect(diagramNeedsBake(makeSvg('<text fill="#1f2328">label</text>'))).toBe(false)
    expect(diagramNeedsBake(makeSvg('<text fill="#444444">title</text>'))).toBe(false)
  })

  it('is false for foreignObject HTML labels (flowchart, class, …)', () => {
    const svg = makeSvg(
      '<foreignObject><div><span style="color:white">html label</span></div></foreignObject>',
    )
    expect(diagramNeedsBake(svg)).toBe(false)
  })

  it('is false when the diagram has no text at all', () => {
    expect(diagramNeedsBake(makeSvg('<rect width="10" height="10"></rect>'))).toBe(false)
  })
})

describe('bakeDiagram', () => {
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ])

  function makeBlock(text = '<text fill="#FFFFFF">label</text>'): {
    holder: HTMLElement
    svg: SVGSVGElement
    ctx: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> }
  } {
    const holder = document.createElement('div')
    holder.className = 'mermaid'
    const preview = document.createElement('div')
    preview.className = 'mermaid-preview'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('id', 'mermaid-0')
    svg.setAttribute('viewBox', '0 0 800 450')
    svg.innerHTML = text
    preview.appendChild(svg)
    holder.appendChild(preview)
    const ctx = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    }
    const blob = { arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer as ArrayBuffer) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback: BlobCallback) => callback(blob as Blob),
    )
    vi.stubGlobal(
      'Image',
      class FakeImage {
        src = ''
        decode = async (): Promise<void> => undefined
      },
    )
    return { holder, svg, ctx }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('replaces the live svg with a baked bitmap at 2x resolution', async () => {
    const { holder, svg, ctx } = makeBlock()
    const ok = await bakeDiagram(holder, svg, 800)
    expect(ok).toBe(true)
    const img = holder.querySelector<HTMLImageElement>('.mermaid-img')
    expect(img).not.toBeNull()
    expect(img!.src).toContain('iVBORw0KGgoAAAAN')
    expect(img!.getAttribute('src')).toMatch(/^data:image\//)
    expect(img!.style.width).toBe('800px')
    expect(img!.style.height).toBe('450px')
    expect(svg.classList.contains('mermaid-source')).toBe(true)
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1600, 900)
  })

  it('keeps the svg inside the preview so copy still has the vector source', async () => {
    const { holder, svg } = makeBlock()
    await bakeDiagram(holder, svg, 800)
    expect(holder.querySelector('.mermaid-preview svg')).toBe(svg)
  })

  it('re-bakes at the current zoom factor on a zoom event', async () => {
    const { holder, svg, ctx } = makeBlock()
    attachMermaidToolbar(holder, svg, 800)
    await bakeDiagram(holder, svg, 800)
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)

    holder.querySelector<HTMLButtonElement>('.mermaid-toolbar-btn[title="Zoom in"]')!.click()
    await vi.waitFor(() => expect(ctx.fillRect).toHaveBeenCalledTimes(2))
    const img = holder.querySelector<HTMLImageElement>('.mermaid-img')
    expect(img!.style.width).toBe('1000px')
    await vi.waitFor(() => expect(img!.style.height).toBe('563px'))
  })

  it('is a no-op when the natural size is unavailable', async () => {
    const { holder, svg } = makeBlock()
    const ok = await bakeDiagram(holder, svg, null)
    expect(ok).toBe(false)
    expect(holder.querySelector('.mermaid-img')).toBeNull()
  })

  it('keeps vector rendering for diagrams with no light native text', async () => {
    const { holder, svg } = makeBlock('<text fill="#1f2328">dark</text>')
    const ok = await bakeDiagram(holder, svg, 800)
    expect(ok).toBe(false)
    expect(holder.querySelector('.mermaid-img')).toBeNull()
    expect(svg.classList.contains('mermaid-source')).toBe(false)
  })

  it('falls back to the live svg when rasterization fails', async () => {
    const { holder, svg } = makeBlock()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const ok = await bakeDiagram(holder, svg, 800)
    expect(ok).toBe(false)
    expect(holder.querySelector('.mermaid-img')).toBeNull()
    expect(svg.classList.contains('mermaid-source')).toBe(false)
  })
})

describe('copyMermaidAsImage', () => {
  function sizedSvg(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 100 60')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 60,
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 60,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect)
    return svg
  }

  /** Minimal valid PNG header bytes; content is irrelevant for the tests. */
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ])

  interface CanvasStub {
    ctx: {
      fillStyle: string
      fillRect: ReturnType<typeof vi.fn>
      drawImage: ReturnType<typeof vi.fn>
    }
    blob: { arrayBuffer: () => Promise<ArrayBuffer> }
  }

  function stubRasterization(): CanvasStub {
    const ctx = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    }
    const blob = { arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer as ArrayBuffer) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback: BlobCallback) => callback(blob as Blob),
    )
    vi.stubGlobal(
      'Image',
      class FakeImage {
        src = ''
        decode = async (): Promise<void> => undefined
      },
    )
    return { ctx, blob }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rasterizes the diagram to a PNG for the native clipboard', async () => {
    document.documentElement.style.setProperty('--bg', '#0d1117')
    const { ctx } = stubRasterization()
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(true)
    expect(bridgeModule.invoke).toHaveBeenCalledWith(
      'copyImage',
      expect.objectContaining({
        data: expect.stringMatching(/^[A-Za-z0-9+/=]+$/),
      }),
    )
    const payload = vi.mocked(bridgeModule.invoke).mock.calls.at(-1)?.[1] as {
      data: string
    }
    // Decodes to the PNG signature.
    const raw = atob(payload.data)
    expect(raw.charCodeAt(0)).toBe(0x89)
    expect(raw.charCodeAt(1)).toBe(0x50)
    expect(raw.charCodeAt(2)).toBe(0x4e)
    expect(raw.charCodeAt(3)).toBe(0x47)
    // Rendered at 2x the displayed size.
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 200, 120)
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
  })

  it('fills the canvas with the current theme --bg', async () => {
    document.documentElement.style.setProperty('--bg', '#0d1117')
    const { ctx } = stubRasterization()
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(true)
    expect(ctx.fillStyle).toBe('#0d1117')
  })

  it('falls back to white when the theme sets no --bg', async () => {
    document.documentElement.style.removeProperty('--bg')
    const { ctx } = stubRasterization()
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(true)
    expect(ctx.fillStyle).toBe('#ffffff')
  })

  it('reports an error when the canvas is unavailable', async () => {
    document.documentElement.style.setProperty('--bg', '#ffffff')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.stubGlobal('Image', class FakeImage { decode = async () => undefined })
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('rasterize')
  })

  it('reports an error when the native bridge is missing', async () => {
    vi.mocked(bridgeModule.hasBridge).mockReturnValue(false)
    stubRasterization()
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('native app')
    expect(bridgeModule.invoke).not.toHaveBeenCalled()
  })
})

describe('saveMermaidAsImage', () => {
  function sizedSvg(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 100 60')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 60,
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 60,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect)
    return svg
  }

  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ])

  function stubRasterization(): void {
    const ctx = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    }
    const blob = { arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer as ArrayBuffer) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback: BlobCallback) => callback(blob as Blob),
    )
    vi.stubGlobal('Image', class FakeImage { decode = async () => undefined })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('picks a save path then rasterizes and writes the PNG', async () => {
    document.documentElement.style.setProperty('--bg', '#0d1117')
    stubRasterization()
    const result = await saveMermaidAsImage(sizedSvg(), 'notes')
    expect(result.ok).toBe(true)
    expect(result.path).toBe('/tmp/diagram.png')
    expect(filesModule.pickImageSavePath).toHaveBeenCalledWith('notes')
    expect(filesModule.writeBinaryFile).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(filesModule.writeBinaryFile).mock.calls.at(-1)?.[1] as string
    // The payload decodes to the PNG signature.
    const raw = atob(payload)
    expect(raw.charCodeAt(0)).toBe(0x89) // \x89
    expect(raw.charCodeAt(1)).toBe(0x50) // 'P'
    expect(raw.charCodeAt(2)).toBe(0x4e) // 'N'
    expect(raw.charCodeAt(3)).toBe(0x47) // 'G'
  })

  it('does not rasterize when the user cancels the dialog', async () => {
    vi.mocked(filesModule.pickImageSavePath).mockResolvedValue(null)
    stubRasterization()
    const result = await saveMermaidAsImage(sizedSvg(), 'notes')
    expect(result.ok).toBe(true)
    expect(result.path).toBeUndefined()
    expect(filesModule.writeBinaryFile).not.toHaveBeenCalled()
  })

  it('reports an error when the native bridge is missing', async () => {
    vi.mocked(bridgeModule.hasBridge).mockReturnValue(false)
    stubRasterization()
    const result = await saveMermaidAsImage(sizedSvg(), 'notes')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('native app')
    expect(filesModule.pickImageSavePath).not.toHaveBeenCalled()
  })

  it('reports an error when the canvas is unavailable', async () => {
    document.documentElement.style.setProperty('--bg', '#ffffff')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.stubGlobal('Image', class FakeImage { decode = async () => undefined })
    const result = await saveMermaidAsImage(sizedSvg(), 'notes')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('rasterize')
    expect(filesModule.writeBinaryFile).not.toHaveBeenCalled()
  })

  it('reports an error when writing the file fails', async () => {
    stubRasterization()
    vi.mocked(filesModule.writeBinaryFile).mockRejectedValue(
      new Error('permission denied'),
    )
    const result = await saveMermaidAsImage(sizedSvg(), 'notes')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('permission denied')
  })
})

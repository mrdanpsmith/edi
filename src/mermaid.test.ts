import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  renderPendingMermaid,
  mermaidFenceTokens,
  responsifySvg,
  attachMermaidToolbar,
  reinitializeMermaidTheme,
  copyMermaidAsImage,
} from './mermaid'

vi.mock('./bridge', () => ({
  hasBridge: vi.fn(() => true),
  invoke: vi.fn(() => Promise.resolve()),
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

import * as mermaidModule from 'mermaid'
import * as bridgeModule from './bridge'

const mermaid = vi.mocked(mermaidModule.default)

beforeEach(() => {
  vi.clearAllMocks()
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

  it('re-initializes mermaid with the requested theme palette', async () => {
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    await reinitializeMermaidTheme(true)
    const config = vi.mocked(mermaid.initialize).mock.calls.at(-1)?.[0] as {
      theme: string
      themeVariables: Record<string, string>
    }
    expect(config.theme).toBe('base')
    expect(config.themeVariables.primaryColor).toBe('#1d3a5f')
    expect(config.themeVariables.primaryTextColor).toBe('#e6edf3')
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

  it('passes the current theme --bg to the native rasterizer', async () => {
    document.documentElement.style.setProperty('--bg', '#0d1117')
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(true)
    expect(bridgeModule.invoke).toHaveBeenCalledWith(
      'copyImage',
      expect.objectContaining({ background: '#0d1117' }),
    )
  })

  it('falls back to white when the theme sets no --bg', async () => {
    document.documentElement.style.removeProperty('--bg')
    const result = await copyMermaidAsImage(sizedSvg())
    expect(result.ok).toBe(true)
    expect(bridgeModule.invoke).toHaveBeenCalledWith(
      'copyImage',
      expect.objectContaining({ background: '#ffffff' }),
    )
  })
})

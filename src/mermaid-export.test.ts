import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node as ProseNode } from 'prosemirror-model'

const hoisted = vi.hoisted(() => ({
  render: vi.fn(),
  rasterize: vi.fn(),
}))

vi.mock('./mermaid', () => ({
  loadMermaid: vi.fn(async () => ({ render: hoisted.render })),
  responsifySvg: vi.fn(),
  adaptDiagramColors: vi.fn(),
  pinSvgTextColors: vi.fn(),
}))

vi.mock('./mermaid-bake', () => ({
  rasterizeSvgToBase64Png: hoisted.rasterize,
}))

import { mermaidPngSnapshots, snapshotMermaidHtml } from './mermaid-export'
import { markdownToProse } from './markdown'
import { schema } from './schema'

function docFrom(md: string): ProseNode {
  return markdownToProse(md, schema)
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.render.mockResolvedValue({
    svg: '<svg viewBox="0 0 800 450"></svg>',
    diagramType: 'flowchart',
  })
  hoisted.rasterize.mockResolvedValue('UE5H')
})

describe('mermaidPngSnapshots', () => {
  it('rasterizes each diagram at twice its natural size', async () => {
    const snapshots = await mermaidPngSnapshots(docFrom('```mermaid\ngraph TD\n  A-->B\n```'))
    expect(snapshots.get('graph TD\n  A-->B')).toEqual({
      data: 'UE5H',
      width: 800,
      height: 450,
    })
    expect(hoisted.render).toHaveBeenCalledTimes(1)
    expect(hoisted.rasterize).toHaveBeenCalledWith(expect.any(SVGElement), 1600, 900)
  })

  it('renders identical sources once', async () => {
    const md = '```mermaid\ngraph TD\n```\n\n```mermaid\ngraph TD\n```'
    const snapshots = await mermaidPngSnapshots(docFrom(md))
    expect(snapshots.size).toBe(1)
    expect(hoisted.render).toHaveBeenCalledTimes(1)
  })

  it('omits a diagram mermaid cannot render', async () => {
    hoisted.render.mockRejectedValue(new Error('bad diagram'))
    const snapshots = await mermaidPngSnapshots(docFrom('```mermaid\ngraph bad\n```'))
    expect(snapshots.size).toBe(0)
  })

  it('omits a diagram whose SVG has no usable size', async () => {
    hoisted.render.mockResolvedValue({ svg: '<svg></svg>', diagramType: 'flowchart' })
    const snapshots = await mermaidPngSnapshots(docFrom('```mermaid\ngraph TD\n```'))
    expect(snapshots.size).toBe(0)
    expect(hoisted.rasterize).not.toHaveBeenCalled()
  })

  it('omits a diagram whose rasterization fails', async () => {
    hoisted.rasterize.mockResolvedValue(null)
    const snapshots = await mermaidPngSnapshots(docFrom('```mermaid\ngraph TD\n```'))
    expect(snapshots.size).toBe(0)
  })

  it('ignores documents with no mermaid blocks', async () => {
    const snapshots = await mermaidPngSnapshots(docFrom('hello'))
    expect(snapshots.size).toBe(0)
    expect(hoisted.render).not.toHaveBeenCalled()
  })
})

describe('snapshotMermaidHtml', () => {
  it('replaces a copied mermaid block with a PNG and its source', async () => {
    const root = document.createElement('div')
    const block = document.createElement('div')
    block.setAttribute('data-mermaid-block', '')
    block.textContent = 'graph TD\n  A-->B'
    root.append(block)

    await snapshotMermaidHtml(root)

    const figure = root.querySelector('figure.mermaid-figure')
    expect(figure).not.toBeNull()
    expect(figure!.getAttribute('data-mermaid-block')).toBe('')
    expect(figure!.getAttribute('data-mermaid-source')).toBe('graph TD\n  A-->B')
    const img = figure!.querySelector('img.mermaid-snapshot') as HTMLImageElement
    expect(img.src).toBe('data:image/png;base64,UE5H')
    expect(img.width).toBe(800)
    expect(img.height).toBe(450)
    const details = figure!.querySelector('details.mermaid-source') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Mermaid source')
    expect(details.querySelector('code.language-mermaid')?.textContent).toBe('graph TD\n  A-->B')
  })

  it('prefers the source attribute over the rendered text', async () => {
    const root = document.createElement('div')
    const block = document.createElement('div')
    block.setAttribute('data-mermaid-block', '')
    block.setAttribute('data-mermaid-source', 'graph LR')
    block.textContent = 'Mermaid source graph TD'
    root.append(block)

    await snapshotMermaidHtml(root)

    expect(hoisted.render).toHaveBeenCalledWith(expect.any(String), 'graph LR')
    expect(root.querySelector('[data-mermaid-source="graph LR"]')).not.toBeNull()
  })

  it('leaves the source block when the snapshot cannot be made', async () => {
    hoisted.render.mockRejectedValue(new Error('bad diagram'))
    const root = document.createElement('div')
    const block = document.createElement('div')
    block.setAttribute('data-mermaid-block', '')
    block.textContent = 'graph bad'
    root.append(block)

    await snapshotMermaidHtml(root)

    expect(root.querySelector('figure')).toBeNull()
    expect(root.querySelector('[data-mermaid-block]')).toBe(block)
  })
})

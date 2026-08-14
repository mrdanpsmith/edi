import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderPendingMermaid, mermaidFenceTokens } from './mermaid'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

import * as mermaidModule from 'mermaid'

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
    expect(done[0]!.innerHTML).toBe('<svg id="out"></svg>')
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
})

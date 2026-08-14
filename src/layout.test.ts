import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SplitLayout } from './layout'

function elements(): {
  workspace: HTMLElement
  previewPane: HTMLElement
  divider: HTMLElement
} {
  const workspace = document.createElement('div')
  const previewPane = document.createElement('div')
  const divider = document.createElement('div')
  return { workspace, previewPane, divider }
}

function stubRect(workspace: HTMLElement): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(workspace, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

beforeEach(() => {
  localStorage.clear()
})

describe('SplitLayout', () => {
  it('starts with the preview visible', () => {
    const { workspace, previewPane, divider } = elements()
    const layout = new SplitLayout(workspace, previewPane, divider)
    expect(layout.isPreviewVisible()).toBe(true)
    expect(previewPane.hidden).toBe(false)
    expect(divider.hidden).toBe(false)
  })

  it('applies the default ratio when nothing is stored', () => {
    const { workspace } = elements()
    new SplitLayout(workspace, document.createElement('div'), document.createElement('div'))
    expect(workspace.style.gridTemplateColumns).toBe('58fr 5px 42fr')
  })

  it('restores a persisted preview ratio', () => {
    localStorage.setItem('edi.previewRatio', '0.7')
    const { workspace } = elements()
    new SplitLayout(workspace, document.createElement('div'), document.createElement('div'))
    expect(workspace.style.gridTemplateColumns).toBe('30fr 5px 70fr')
  })

  it('clamps a persisted ratio to the allowed range', () => {
    localStorage.setItem('edi.previewRatio', '0.05')
    const { workspace } = elements()
    new SplitLayout(workspace, document.createElement('div'), document.createElement('div'))
    expect(workspace.style.gridTemplateColumns).toBe('80fr 5px 20fr')
  })

  it('toggles the preview and persists visibility', () => {
    const { workspace, previewPane, divider } = elements()
    const layout = new SplitLayout(workspace, previewPane, divider)
    layout.togglePreview()
    expect(layout.isPreviewVisible()).toBe(false)
    expect(previewPane.hidden).toBe(true)
    expect(divider.hidden).toBe(true)
    expect(workspace.classList.contains('preview-hidden')).toBe(true)
    expect(workspace.style.gridTemplateColumns).toBe('1fr 0px 0px')
    expect(localStorage.getItem('edi.previewVisible')).toBe('false')
  })

  it('toggles back on a second call', () => {
    const { workspace, previewPane } = elements()
    const layout = new SplitLayout(workspace, previewPane, document.createElement('div'))
    layout.togglePreview()
    layout.togglePreview()
    expect(layout.isPreviewVisible()).toBe(true)
    expect(previewPane.hidden).toBe(false)
    expect(workspace.classList.contains('preview-hidden')).toBe(false)
    expect(localStorage.getItem('edi.previewVisible')).toBe('true')
  })

  it('restores a persisted hidden preview', () => {
    localStorage.setItem('edi.previewVisible', 'false')
    const { workspace, previewPane, divider } = elements()
    const layout = new SplitLayout(workspace, previewPane, divider)
    expect(layout.isPreviewVisible()).toBe(false)
    expect(previewPane.hidden).toBe(true)
    expect(workspace.classList.contains('preview-hidden')).toBe(true)
  })

  it('resizes columns while dragging the divider', () => {
    const { workspace, previewPane, divider } = elements()
    const rect = stubRect(workspace)
    new SplitLayout(workspace, previewPane, divider)

    divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(document.body.classList.contains('resizing')).toBe(true)

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }))
    expect(workspace.style.gridTemplateColumns).toBe('70fr 5px 30fr')
    expect(Number.parseFloat(localStorage.getItem('edi.previewRatio')!)).toBeCloseTo(0.3)

    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(document.body.classList.contains('resizing')).toBe(false)
    rect.mockRestore()
  })

  it('ignores drags outside a mousedown', () => {
    const { workspace, previewPane, divider } = elements()
    const layout = new SplitLayout(workspace, previewPane, divider)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 800 }))
    expect(layout.isPreviewVisible()).toBe(true)
    expect(localStorage.getItem('edi.previewRatio')).toBeNull()
  })

  it('toggles the preview on divider double-click', () => {
    const { workspace, previewPane, divider } = elements()
    new SplitLayout(workspace, previewPane, divider)
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(previewPane.hidden).toBe(true)
  })
})

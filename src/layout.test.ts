import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SplitLayout } from './layout'

function elements(): {
  workspace: HTMLElement
  editorPane: HTMLElement
  previewPane: HTMLElement
  divider: HTMLElement
} {
  const workspace = document.createElement('div')
  const editorPane = document.createElement('div')
  const previewPane = document.createElement('div')
  const divider = document.createElement('div')
  return { workspace, editorPane, previewPane, divider }
}

function makeLayout(): {
  workspace: HTMLElement
  editorPane: HTMLElement
  previewPane: HTMLElement
  divider: HTMLElement
  layout: SplitLayout
} {
  const el = elements()
  return { ...el, layout: new SplitLayout(el.workspace, el.editorPane, el.previewPane, el.divider) }
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
  it('starts with both panes visible', () => {
    const { editorPane, previewPane, divider, layout } = makeLayout()
    expect(layout.isPreviewVisible()).toBe(true)
    expect(layout.isEditorVisible()).toBe(true)
    expect(editorPane.hidden).toBe(false)
    expect(previewPane.hidden).toBe(false)
    expect(divider.hidden).toBe(false)
  })

  it('applies the default ratio when nothing is stored', () => {
    const { workspace } = elements()
    const editorPane = document.createElement('div')
    const previewPane = document.createElement('div')
    new SplitLayout(workspace, editorPane, previewPane, document.createElement('div'))
    expect(workspace.style.gridTemplateColumns).toBe('58fr 5px 42fr')
  })

  it('restores a persisted preview ratio', () => {
    localStorage.setItem('edi.previewRatio', '0.7')
    const { workspace } = elements()
    const editorPane = document.createElement('div')
    const previewPane = document.createElement('div')
    new SplitLayout(workspace, editorPane, previewPane, document.createElement('div'))
    expect(workspace.style.gridTemplateColumns).toBe('30fr 5px 70fr')
  })

  it('clamps a persisted ratio to the allowed range', () => {
    localStorage.setItem('edi.previewRatio', '0.05')
    const { workspace } = elements()
    const editorPane = document.createElement('div')
    const previewPane = document.createElement('div')
    new SplitLayout(workspace, editorPane, previewPane, document.createElement('div'))
    expect(workspace.style.gridTemplateColumns).toBe('80fr 5px 20fr')
  })

  it('toggles the preview and persists visibility', () => {
    const { workspace, previewPane, divider, layout } = makeLayout()
    layout.togglePreview()
    expect(layout.isPreviewVisible()).toBe(false)
    expect(previewPane.hidden).toBe(true)
    expect(divider.hidden).toBe(true)
    expect(workspace.classList.contains('preview-hidden')).toBe(true)
    expect(workspace.style.gridTemplateColumns).toBe('1fr 0px 0px')
    expect(localStorage.getItem('edi.previewVisible')).toBe('false')
  })

  it('toggles back on a second call', () => {
    const { workspace, previewPane, layout } = makeLayout()
    layout.togglePreview()
    layout.togglePreview()
    expect(layout.isPreviewVisible()).toBe(true)
    expect(previewPane.hidden).toBe(false)
    expect(workspace.classList.contains('preview-hidden')).toBe(false)
    expect(localStorage.getItem('edi.previewVisible')).toBe('true')
  })

  it('restores a persisted hidden preview', () => {
    localStorage.setItem('edi.previewVisible', 'false')
    const { workspace, previewPane, divider, layout } = makeLayout()
    expect(layout.isPreviewVisible()).toBe(false)
    expect(previewPane.hidden).toBe(true)
    expect(workspace.classList.contains('preview-hidden')).toBe(true)
    expect(divider.hidden).toBe(true)
  })

  it('toggles the editor and persists visibility', () => {
    const { workspace, editorPane, divider, layout } = makeLayout()
    layout.toggleEditor()
    expect(layout.isEditorVisible()).toBe(false)
    expect(editorPane.hidden).toBe(true)
    expect(divider.hidden).toBe(true)
    expect(workspace.classList.contains('editor-hidden')).toBe(true)
    expect(workspace.style.gridTemplateColumns).toBe('0px 0px 1fr')
    expect(localStorage.getItem('edi.editorVisible')).toBe('false')
  })

  it('toggles the editor back on a second call', () => {
    const { workspace, editorPane, layout } = makeLayout()
    layout.toggleEditor()
    layout.toggleEditor()
    expect(layout.isEditorVisible()).toBe(true)
    expect(editorPane.hidden).toBe(false)
    expect(workspace.classList.contains('editor-hidden')).toBe(false)
    expect(workspace.style.gridTemplateColumns).toBe('58fr 5px 42fr')
    expect(localStorage.getItem('edi.editorVisible')).toBe('true')
  })

  it('restores a persisted hidden editor', () => {
    localStorage.setItem('edi.editorVisible', 'false')
    const { workspace, editorPane, divider, layout } = makeLayout()
    expect(layout.isEditorVisible()).toBe(false)
    expect(editorPane.hidden).toBe(true)
    expect(workspace.classList.contains('editor-hidden')).toBe(true)
    expect(divider.hidden).toBe(true)
    expect(workspace.style.gridTemplateColumns).toBe('0px 0px 1fr')
  })

  it('re-enables the preview when the editor is the last visible pane', () => {
    const { workspace, editorPane, previewPane, divider, layout } = makeLayout()
    layout.togglePreview()
    expect(previewPane.hidden).toBe(true)
    layout.toggleEditor()
    expect(editorPane.hidden).toBe(true)
    expect(previewPane.hidden).toBe(false)
    expect(divider.hidden).toBe(true)
    expect(workspace.classList.contains('editor-hidden')).toBe(true)
    expect(workspace.classList.contains('preview-hidden')).toBe(false)
    expect(workspace.style.gridTemplateColumns).toBe('0px 0px 1fr')
    expect(localStorage.getItem('edi.previewVisible')).toBe('true')
  })

  it('re-enables the editor when the preview is the last visible pane', () => {
    const { workspace, editorPane, previewPane, layout } = makeLayout()
    layout.toggleEditor()
    expect(editorPane.hidden).toBe(true)
    layout.togglePreview()
    expect(previewPane.hidden).toBe(true)
    expect(editorPane.hidden).toBe(false)
    expect(workspace.classList.contains('editor-hidden')).toBe(false)
    expect(workspace.classList.contains('preview-hidden')).toBe(true)
    expect(workspace.style.gridTemplateColumns).toBe('1fr 0px 0px')
    expect(localStorage.getItem('edi.editorVisible')).toBe('true')
  })

  it('normalizes a persisted state with both panes hidden', () => {
    localStorage.setItem('edi.previewVisible', 'false')
    localStorage.setItem('edi.editorVisible', 'false')
    const { workspace, previewPane, layout } = makeLayout()
    expect(layout.isPreviewVisible()).toBe(true)
    expect(layout.isEditorVisible()).toBe(false)
    expect(previewPane.hidden).toBe(false)
    expect(workspace.style.gridTemplateColumns).toBe('0px 0px 1fr')
    expect(localStorage.getItem('edi.previewVisible')).toBe('true')
  })

  it('resizes columns while dragging the divider', () => {
    const { workspace, divider } = makeLayout()
    const rect = stubRect(workspace)

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
    const { layout } = makeLayout()
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 800 }))
    expect(layout.isPreviewVisible()).toBe(true)
    expect(localStorage.getItem('edi.previewRatio')).toBeNull()
  })

  it('toggles the preview on divider double-click', () => {
    const { previewPane, divider } = makeLayout()
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(previewPane.hidden).toBe(true)
  })
})

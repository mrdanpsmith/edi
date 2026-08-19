import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EditorLayout } from './layout'

function elements(): {
  workspace: HTMLElement
  visualPane: HTMLElement
  textPane: HTMLElement
} {
  const workspace = document.createElement('div')
  const visualPane = document.createElement('div')
  const textPane = document.createElement('div')
  return { workspace, visualPane, textPane }
}

function makeLayout(): {
  workspace: HTMLElement
  visualPane: HTMLElement
  textPane: HTMLElement
  layout: EditorLayout
} {
  const el = elements()
  const callbacks = { onModeChange: vi.fn() }
  return { ...el, layout: new EditorLayout(el.workspace, el.visualPane, el.textPane, callbacks) }
}

beforeEach(() => {
  localStorage.clear()
})

describe('EditorLayout', () => {
  it('starts in visual mode by default', () => {
    const { visualPane, textPane, layout } = makeLayout()
    expect(layout.mode).toBe('visual')
    expect(layout.isVisualMode()).toBe(true)
    expect(layout.isTextMode()).toBe(false)
    expect(visualPane.hidden).toBe(false)
    expect(textPane.hidden).toBe(true)
  })

  it('starts in text mode when persisted', () => {
    localStorage.setItem('edi.mode', 'text')
    const { visualPane, textPane, layout } = makeLayout()
    expect(layout.mode).toBe('text')
    expect(layout.isVisualMode()).toBe(false)
    expect(layout.isTextMode()).toBe(true)
    expect(visualPane.hidden).toBe(true)
    expect(textPane.hidden).toBe(false)
  })

  it('toggles between visual and text modes', () => {
    const { workspace, visualPane, textPane, layout } = makeLayout()
    expect(layout.mode).toBe('visual')

    layout.toggleMode()
    expect(layout.mode).toBe('text')
    expect(visualPane.hidden).toBe(true)
    expect(textPane.hidden).toBe(false)
    expect(workspace.classList.contains('text-mode')).toBe(true)
    expect(localStorage.getItem('edi.mode')).toBe('text')

    layout.toggleMode()
    expect(layout.mode).toBe('visual')
    expect(visualPane.hidden).toBe(false)
    expect(textPane.hidden).toBe(true)
    expect(workspace.classList.contains('visual-mode')).toBe(true)
    expect(localStorage.getItem('edi.mode')).toBe('visual')
  })

  it('calls onModeChange when the mode changes', () => {
    const { workspace } = elements()
    const visualPane = document.createElement('div')
    const textPane = document.createElement('div')
    const onModeChange = vi.fn()
    const layout = new EditorLayout(workspace, visualPane, textPane, { onModeChange })

    layout.toggleMode()
    expect(onModeChange).toHaveBeenCalledWith('text')

    layout.toggleMode()
    expect(onModeChange).toHaveBeenCalledWith('visual')
  })

  it('does not call onModeChange when setting the same mode', () => {
    const { workspace } = elements()
    const visualPane = document.createElement('div')
    const textPane = document.createElement('div')
    const onModeChange = vi.fn()
    const layout = new EditorLayout(workspace, visualPane, textPane, { onModeChange })

    layout.setMode('visual')
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('sets mode explicitly', () => {
    const { visualPane, textPane, layout } = makeLayout()
    layout.setMode('text')
    expect(layout.mode).toBe('text')
    expect(visualPane.hidden).toBe(true)
    expect(textPane.hidden).toBe(false)

    layout.setMode('text')
    expect(layout.mode).toBe('text')
  })
})

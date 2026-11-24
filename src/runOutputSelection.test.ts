import { afterEach, describe, expect, it } from 'vitest'
import { runOutputSelectionText } from './runOutputSelection'

function setUp(): { prose: Text; first: Text; second: Text; other: Text } {
  document.body.innerHTML =
    '<p>prose</p>' +
    '<pre class="exec-output"><span class="term-line">first</span><span class="term-line">\nsecond</span></pre>' +
    '<pre class="exec-output"><span class="term-line">other</span></pre>'
  const text = (selector: string, index = 0) =>
    [...document.querySelectorAll(selector)][index].lastChild as Text
  return { prose: text('p'), first: text('.term-line'), second: text('.term-line', 1), other: text('.term-line', 2) }
}

function select(anchor: Text, anchorOffset: number, focus: Text, focusOffset: number): void {
  document.getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
}

describe('runOutputSelectionText', () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  it('is the selected text when both ends are in one run output', () => {
    const { first, second } = setUp()
    select(first, 2, second, 4)
    expect(runOutputSelectionText()).toBe('rst\nsec')
    // Backwards, as a drag upwards makes it.
    select(second, 4, first, 2)
    expect(runOutputSelectionText()).toBe('rst\nsec')
  })

  it('is null for a caret, prose, or a range leaving the output', () => {
    const { prose, first, other } = setUp()
    select(first, 2, first, 2)
    expect(runOutputSelectionText()).toBeNull()
    select(prose, 0, prose, 3)
    expect(runOutputSelectionText()).toBeNull()
    select(prose, 1, first, 3)
    expect(runOutputSelectionText()).toBeNull()
    select(first, 1, other, 2)
    expect(runOutputSelectionText()).toBeNull()
  })
})

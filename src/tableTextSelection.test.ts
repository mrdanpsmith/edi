import { describe, expect, it, afterEach, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Plugin } from 'prosemirror-state'
import { schema } from './schema'
import { markdownToProse } from './markdown'
import { blockModePlugin } from './block-modes'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { formulaDefsPlugin } from './formulaDefs'
import { tableNodeViewPlugin } from './node/table'
import {
  boxesIn,
  forgetPlainTableSelection,
  hasPlainTableSelection,
  liveSelectionInPlainTable,
  paintPlainTableSelection,
  plainTableSelectionText,
  rangeText,
  rememberSelection,
  selectionEndsIn,
} from './tableTextSelection'

const DOC = `Prose that comes before the table and is long enough to have a
word in the middle of it.

| Alpha | Bravo |
| --- | --- |
| one | two |
| three | four |

| Echo | Foxtrot |
| --- | --- |
| five | six |

Prose that comes after the tables and also has a word worth reading.
`

const views: EditorView[] = []

function createEditor(md: string): EditorView {
  const nodeViewPlugin = new Plugin({
    props: {
      nodeViews: Object.fromEntries(
        [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
      ),
    },
  })
  const view = new EditorView(document.body, {
    state: EditorState.create({
      doc: markdownToProse(md, schema),
      plugins: [blockModePlugin, nodeViewPlugin, tableNodeViewPlugin, formulaDefsPlugin],
    }),
  })
  views.push(view)
  return view
}

const REAL_GET_CLIENT_RECTS = Range.prototype.getClientRects

afterEach(() => {
  getSelection()?.removeAllRanges()
  // The rect stubs below are global, so a later test must not inherit them — and jsdom
  // has no layout, so the real one is an empty list rather than anything meaningful.
  Range.prototype.getClientRects = REAL_GET_CLIENT_RECTS
  vi.restoreAllMocks()
  while (views.length) views.pop()!.destroy()
  document.body.innerHTML = ''
})

function plainTables(): Element[] {
  return [...document.querySelectorAll('.ss-plain')]
}

function cellOf(table: Element, text: string): Element {
  const found = [...table.querySelectorAll('th, td')].find((c) => c.textContent === text)
  if (!found) throw new Error(`no cell reading ${text}`)
  return found
}

/** The text node holding `needle`, and where in it `needle` starts. */
function textIn(root: Element, needle: string): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? '').indexOf(needle)
    if (at >= 0) return { node: node as Text, at }
  }
  throw new Error(`no text reading ${needle}`)
}

function selectBetween(from: Node, fromAt: number, to: Node, toAt: number): void {
  const range = document.createRange()
  range.setStart(from, fromAt)
  range.setEnd(to, toAt)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('a Visual table is selected with the browser, and read from the range', () => {
  it('is not a table selection when no end of the range is in a cell', () => {
    createEditor(DOC)
    const prose = document.querySelectorAll('.block-visual-mode p')
    const before = textIn(prose[0] as Element, 'comes before')
    const after = textIn(prose[prose.length - 1] as Element, 'comes after')
    // A Ctrl+A-shaped range: it brackets both tables and has no end inside one.
    selectBetween(before.node, before.at, after.node, after.at + 12)

    expect(liveSelectionInPlainTable()).toBeNull()
    expect(plainTableSelectionText()).toBeNull()
  })

  it('is a table selection when one end of the range is in a cell', () => {
    createEditor(DOC)
    const [first, second] = plainTables()
    const one = textIn(cellOf(first, 'one'), 'one')
    const five = textIn(cellOf(second, 'five'), 'five')
    selectBetween(one.node, one.at, five.node, five.at + 4)

    expect(liveSelectionInPlainTable()?.table).toBe(first)
    // **The text comes off the range, and it crosses both tables** — with the second
    // table's header row in between, because that is what lies between the two cells.
    // Chromium's own `Selection.toString()` stops at the end of the first one —
    // measured in the real engine, where jsdom's textContent concatenation is not the
    // thing under test — so reading the range is the reason this copy exists at all.
    expect(plainTableSelectionText()).toBe('one\ttwo\nthree\tfour\nEcho\tFoxtrot\nfive')
  })

  it('copies a fragment of one cell as that fragment', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const three = textIn(cellOf(first, 'three'), 'three')
    selectBetween(three.node, three.at, three.node, three.at + 2)

    expect(plainTableSelectionText()).toBe('th')
  })

  it('copies from prose into a table, and leaves the block controls out of it', () => {
    createEditor(DOC)
    const prose = document.querySelectorAll('.block-visual-mode p')
    const before = textIn(prose[0] as Element, 'word')
    const first = plainTables()[0]!
    const four = textIn(cellOf(first, 'four'), 'four')
    // The range walks in through the control cluster on its way to the cells.
    selectBetween(before.node, before.at, four.node, four.at + 4)

    expect(plainTableSelectionText()).toBe(
      'word in the middle of it.\nAlpha\tBravo\none\ttwo\nthree\tfour',
    )
  })

  it('reads a range as a normal editor renders it: cells apart, rows apart', () => {
    createEditor(DOC)
    const [first, second] = plainTables()
    const one = textIn(cellOf(first, 'one'), 'one')
    const six = textIn(cellOf(second, 'six'), 'six')
    selectBetween(one.node, one.at, six.node, six.at + 3)

    expect(plainTableSelectionText()).toBe(
      'one\ttwo\nthree\tfour\nEcho\tFoxtrot\nfive\tsix',
    )
  })

  it('leaves the chrome out of a copied range even when it starts on a control', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const cluster = first.querySelector('.block-controls')!
    const four = textIn(cellOf(first, 'four'), 'four')
    const range = document.createRange()
    range.setStart(cluster, 0)
    range.setEnd(four.node, four.at + 4)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    // The cluster's buttons are `Edit` and `Source`, and they sit between the anchor and
    // every cell — so a range anchored on one would otherwise carry the table's own
    // controls into the reader's clipboard. (Whether a drag can *start* on one is the
    // `user-select: none` in the stylesheet, which only a real engine can answer; what is
    // claimed here is that it could not leak either way.)
    expect(plainTableSelectionText()).toBe('Alpha\tBravo\none\ttwo\nthree\tfour')
  })

  it('claims the paint for a selection the reader made inside the table', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const one = textIn(cellOf(first, 'one'), 'one')
    const four = textIn(cellOf(first, 'four'), 'four')
    selectBetween(one.node, one.at, four.node, four.at + 4)

    expect(hasPlainTableSelection()).toBe(true)
    expect(liveSelectionInPlainTable()?.table).toBe(first)
    expect(selectionEndsIn(first)).toBe(true)
  })

  it('claims the paint for both tables a range runs between, not just the one it started in', () => {
    createEditor(DOC)
    const [first, second] = plainTables()
    const one = textIn(cellOf(first, 'one'), 'one')
    const five = textIn(cellOf(second, 'five'), 'five')
    selectBetween(one.node, one.at, five.node, five.at + 4)

    // One end is in each, so both are drawn to the words. Asking for *both* ends in the
    // same table would fill one of them to its edges and highlight the other word by
    // word, which is the inconsistency the complaint is about.
    expect(selectionEndsIn(first)).toBe(true)
    expect(selectionEndsIn(second)).toBe(true)
  })

  it('leaves the bracketing case to the cell fill, which is the only thing that can paint it', () => {
    createEditor(DOC)
    const prose = document.querySelectorAll('.block-visual-mode p')
    const before = textIn(prose[0] as Element, 'comes before')
    const after = textIn(prose[prose.length - 1] as Element, 'comes after')
    selectBetween(before.node, before.at, after.node, after.at + 12)

    expect(hasPlainTableSelection()).toBe(false)
  })

  it('is not a table selection when the range is a caret', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const one = textIn(cellOf(first, 'one'), 'one')
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(document.createRange())
    selection.collapse(one.node, one.at)

    expect(liveSelectionInPlainTable()).toBeNull()
    expect(plainTableSelectionText()).toBeNull()
  })
})

describe('the highlight is one box per cell, inside that cell', () => {
  it('draws a box per cell the range runs through, positioned against the words', () => {
    // jsdom has no layout, so the cells' and the range's geometry are stubbed with what the
    // real engine reports: a line box per cell of the selection's own range.
    createEditor(DOC)
    const first = plainTables()[0]!
    const prose = document.querySelectorAll('.block-visual-mode p')[0] as Element
    const before = textIn(prose, 'comes before')
    const four = textIn(cellOf(first, 'four'), 'four')
    selectBetween(before.node, before.at, four.node, four.at + 4)

    // Cells, in reading order: two columns by three rows, each 90x30 at a known origin.
    const cells = [...first.querySelectorAll('th, td')] as HTMLElement[]
    cells.forEach((cell, i) => {
      const col = i % 2
      const row = Math.floor(i / 2)
      const left = 50 + col * 100
      const top = 200 + row * 40
      cell.getBoundingClientRect = () =>
        ({ left, top, right: left + 90, bottom: top + 30 }) as DOMRect
    })
    // ...where a box placed at `left: 0; top: 0` lands: half a pixel inside the cell, which
    // is what a collapsed 1px border gives (each cell owns half of the line). The painter
    // has to measure this; working it out from the computed `1px` was half a pixel off.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ss-plain-selection-rect') || !this.parentElement) {
        return { left: 0, top: 0, right: 0, bottom: 0 } as DOMRect
      }
      const cell = this.parentElement.getBoundingClientRect()
      const left = cell.left + 0.5 + (parseFloat(this.style.left) || 0)
      const top = cell.top + 0.5 + (parseFloat(this.style.top) || 0)
      return { left, top, right: left, bottom: top } as DOMRect
    })
    // ...and the range's own boxes: over the prose, then over the four cells it covers
    // (rows one and two of the body, 8px down inside each cell for its border and padding).
    Range.prototype.getClientRects = function (): DOMRectList {
      return [
        { left: 50, top: 150, right: 400, bottom: 198 } as DOMRect,
        { left: 55, top: 248, right: 95, bottom: 262 } as DOMRect,
        { left: 155, top: 248, right: 195, bottom: 262 } as DOMRect,
        { left: 55, top: 288, right: 95, bottom: 302 } as DOMRect,
        { left: 155, top: 288, right: 195, bottom: 302 } as DOMRect,
      ] as unknown as DOMRectList
    }

    paintPlainTableSelection()
    const drawn = [...first.querySelectorAll<HTMLElement>('.ss-plain-selection-rect')].map((el) => [
      el.parentElement?.textContent?.trim(),
      el.style.left, el.style.top, el.style.width, el.style.height,
    ])

    // **One box per cell, inside the cell** — the prose rect and the block's controls are
    // not drawn, because they are not in a cell; and each box sits on the text rather
    // than on the cell, less the half-pixel of border the box is placed inside.
    expect(drawn).toEqual([
      ['one', '4.5px', '7.5px', '40px', '14px'],
      ['two', '4.5px', '7.5px', '40px', '14px'],
      ['three', '4.5px', '7.5px', '40px', '14px'],
      ['four', '4.5px', '7.5px', '40px', '14px'],
    ])

    // A repaint replaces them rather than adding to them.
    Range.prototype.getClientRects = function (): DOMRectList {
      return this.intersectsNode(cells[4]!)
        ? [{ left: 55, top: 288, right: 95, bottom: 302 } as DOMRect] as unknown as DOMRectList
        : [] as unknown as DOMRectList
    }
    paintPlainTableSelection()
    expect(boxesIn(first)).toHaveLength(1)
  })

  it('leaves a table the selection never reached alone', () => {
    createEditor(DOC)
    const [first, second] = plainTables()
    const one = textIn(cellOf(first, 'one'), 'one')
    const two = textIn(cellOf(first, 'two'), 'two')
    selectBetween(one.node, one.at, two.node, two.at + 3)
    for (const table of [first, second]) {
      for (const cell of table.querySelectorAll('th, td')) {
        cell.getBoundingClientRect = () =>
          ({ left: 50, top: 200, right: 140, bottom: 230 }) as DOMRect
      }
    }
    Range.prototype.getClientRects = function (): DOMRectList {
      return this.intersectsNode(first)
        ? [{ left: 55, top: 208, right: 95, bottom: 222 } as DOMRect] as unknown as DOMRectList
        : [] as unknown as DOMRectList
    }

    paintPlainTableSelection()
    expect(boxesIn(first).length).toBe(2)
    expect(boxesIn(second)).toHaveLength(0)
  })
})

describe('it remembers the selection, because the engine takes it away', () => {
  /** What ProseMirror's rewrite looks like from here: the DOM selection, gone. */
  function collapseEverything(): void {
    getSelection()!.removeAllRanges()
  }

  it('still answers after the DOM selection has been collapsed under it', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const one = textIn(cellOf(first, 'one'), 'one')
    const four = textIn(cellOf(first, 'four'), 'four')
    selectBetween(one.node, one.at, four.node, four.at + 4)
    rememberSelection()

    collapseEverything()
    expect(liveSelectionInPlainTable()).toBeNull()
    // …and this is the whole point: the highlight and the copy do not depend on the
    // browser still holding it, because it does not paint any of it anyway.
    expect(plainTableSelectionText()).toBe('one\ttwo\nthree\tfour')
    expect(hasPlainTableSelection()).toBe(true)
  })

  it('follows the reader while the drag is still going', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const one = textIn(cellOf(first, 'one'), 'one')
    const three = textIn(cellOf(first, 'three'), 'three')
    selectBetween(one.node, one.at, one.node, one.at + 3)
    rememberSelection()
    expect(plainTableSelectionText()).toBe('one')

    // The next move of the drag: a longer range, remembered in its place.
    selectBetween(one.node, one.at, three.node, three.at + 5)
    rememberSelection()
    expect(plainTableSelectionText()).toBe('one\ttwo\nthree')
  })

  it('forgets it when the reader presses the pointer or a key', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const one = textIn(cellOf(first, 'one'), 'one')
    selectBetween(one.node, one.at, one.node, one.at + 3)
    rememberSelection()

    forgetPlainTableSelection()
    collapseEverything()
    expect(plainTableSelectionText()).toBeNull()
    expect(hasPlainTableSelection()).toBe(false)
  })

  it('forgets it when the text it was over is no longer in the document', () => {
    createEditor(DOC)
    const first = plainTables()[0]!
    const one = textIn(cellOf(first, 'one'), 'one')
    selectBetween(one.node, one.at, one.node, one.at + 3)
    rememberSelection()

    // A table re-rendering its cells replaces them, and the remembered text nodes go
    // with them — a selection over detached text is nobody's.
    first.querySelector('.ss-plain-table')!.innerHTML = '<tbody><tr><td>new</td></tr></tbody>'
    expect(plainTableSelectionText()).toBeNull()
  })
})

describe('rangeText', () => {
  it('separates cells with tabs and rows with newlines', () => {
    const table = document.createElement('table')
    table.innerHTML =
      '<thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody>'
    const range = document.createRange()
    range.selectNodeContents(table)
    expect(rangeText(range.cloneContents())).toBe('A\tB\n1\t2\n3\t4')
  })

  it('keeps a hard break as a newline and skips the block chrome', () => {
    const host = document.createElement('div')
    host.innerHTML =
      '<div class="block-controls"><button>Edit</button><button>Source</button></div>' +
      '<p>one<br>two</p>'
    const range = document.createRange()
    range.selectNodeContents(host)
    expect(rangeText(range.cloneContents())).toBe('one\ntwo')
  })

  it('puts a blank line between blocks and none at either end', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>one</p><p>two</p><p>three</p>'
    const range = document.createRange()
    range.selectNode(host.firstChild as Node)
    range.setEnd(host.lastChild?.firstChild ?? host, 0)
    range.collapse(true)
    const wide = document.createRange()
    wide.selectNodeContents(host)
    expect(rangeText(wide.cloneContents())).toBe('one\n\ntwo\n\nthree')
  })
})
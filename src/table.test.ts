import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Plugin } from 'prosemirror-state'
import { NodeSelection } from 'prosemirror-state'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { parsePipes } from './spreadsheet-util'
import { blockPlugin, enterSourceMode, exitSourceMode } from './blockplugin'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { tableNodeViewPlugin, insertTable, enterSpreadsheetMode } from './node/table'
import { getActiveCellHost } from './inline-format'
import { encryptField } from './crypto'
import { createBlockEditor } from './editor'

function createEditor(md: string): EditorView {
  const doc = markdownToProse(md, schema)
  const nodeViewPlugin = new Plugin({
    props: {
      nodeViews: Object.fromEntries(
        [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
      ),
    },
  })
  const view = new EditorView(document.body, {
    state: EditorState.create({
      doc,
      plugins: [blockPlugin, nodeViewPlugin, tableNodeViewPlugin],
    }),
  })
  // Tables render in the plain view by default (`_plain` is true); enter
  // spreadsheet mode for the existing suite so `.ss-grid` etc. are present.
  const firstNode = view.state.doc.child(0)
  if (firstNode?.type.name === 'table') {
    view.dispatch(
      view.state.tr.setNodeMarkup(0, undefined, { ...firstNode.attrs, _plain: false }),
    )
  }
  return view
}

/** Build an editor that leaves the table in its default plain view mode. */
function createPlainTable(md: string): EditorView {
  const doc = markdownToProse(md, schema)
  const nodeViewPlugin = new Plugin({
    props: {
      nodeViews: Object.fromEntries(
        [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
      ),
    },
  })
  return new EditorView(document.body, {
    state: EditorState.create({
      doc,
      plugins: [blockPlugin, nodeViewPlugin, tableNodeViewPlugin],
    }),
  })
}

function tableGrid(view: EditorView): HTMLElement {
  const grid = view.dom.querySelector('.ss-grid') as HTMLElement
  if (!grid) throw new Error('no .ss-grid rendered')
  return grid
}

function cell(view: EditorView, row: number, col: number): HTMLElement {
  const rows = tableGrid(view).querySelectorAll('tbody tr')
  return rows[row]!.querySelectorAll('td')[col]! as HTMLElement
}

function colHeader(view: EditorView, col: number): HTMLElement {
  return tableGrid(view).querySelectorAll('thead th')[col + 1]! as HTMLElement
}

function rowGutter(view: EditorView, row: number): HTMLElement {
  const rows = tableGrid(view).querySelectorAll('tbody tr')
  return rows[row]!.querySelector('th.ss-row')! as HTMLElement
}

function tool(view: EditorView, label: string): HTMLElement {
  const buttons = view.dom.querySelectorAll<HTMLElement>('.ss-tool')
  for (const button of buttons) {
    if (button.textContent === label) return button
  }
  throw new Error(`no tool ${label}`)
}

function alignTool(view: EditorView, align: 'left' | 'center' | 'right'): HTMLElement {
  const button = view.dom.querySelector<HTMLElement>(`.ss-tool[data-align='${align}']`)
  if (!button) throw new Error(`no align tool ${align}`)
  return button
}

/** Right-click `el` and pick the context-menu item with `label`. */
function deleteViaMenu(el: Element, label: string): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
  )
  const items = document.querySelectorAll<HTMLButtonElement>('.edi-menu-item')
  for (const item of items) {
    if (item.textContent === label) {
      item.click()
      return
    }
  }
  throw new Error(`no context-menu item ${label}`)
}

function mousedown(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init }))
}

function fillHandle(view: EditorView): HTMLElement {
  const handle = view.dom.querySelector('.ss-fill-handle') as HTMLElement | null
  if (!handle) throw new Error('no .ss-fill-handle rendered')
  return handle
}

/** Press the fill handle of the current selection and drag it out to
 * (row, col), releasing there. */
function dragFill(view: EditorView, row: number, col: number): void {
  mousedown(fillHandle(view))
  cell(view, row, col).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

/** Select a rectangular region by drag, then release. */
function selectRegion(view: EditorView, r1: number, c1: number, r2: number, c2: number): void {
  mousedown(cell(view, r1, c1))
  cell(view, r2, c2).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

function gridkey(view: EditorView, key: string, mod = false): void {
  tableGrid(view).dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: mod,
      metaKey: mod,
    }),
  )
}

function docValue(view: EditorView): string {
  const table = view.state.doc.firstChild
  return String(table?.attrs.value ?? '')
}

describe('TableNodeView grid', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders column letters, row numbers, and a name box', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |')
    const headers = tableGrid(view).querySelectorAll('thead th')
    expect(headers[1]!.querySelector('.ss-cell-content')!.textContent).toBe('A')
    expect(headers[2]!.querySelector('.ss-cell-content')!.textContent).toBe('B')
    expect(headers[3]!.querySelector('.ss-cell-content')!.textContent).toBe('C')
    const gutters = tableGrid(view).querySelectorAll('tbody th.ss-row')
    expect(Array.from(gutters).map((g) => g.querySelector('.ss-gutter-label')?.textContent)).toEqual(['1', '2'])
    const namebox = view.dom.querySelector('.ss-namebox')
    expect(namebox?.textContent).toBe('A1')
    view.destroy()
  })

  it('renders the GFM header row as a header, not a plain data row', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(cell(view, 0, 0).classList.contains('ss-header')).toBe(true)
    expect(cell(view, 0, 1).classList.contains('ss-header')).toBe(true)
    expect(cell(view, 1, 0).classList.contains('ss-header')).toBe(false)
    view.destroy()
  })

  it('renders computed formula values and error cells', () => {
    const view = createEditor(
      '| A | B |\n| --- | --- |\n| 5 | =A2*3 |\n| =SUM(A2:B2) | 0 |',
    )
    expect(cell(view, 1, 1).textContent).toBe('15')
    expect(cell(view, 1, 1).classList.contains('ss-formula')).toBe(true)
    expect(cell(view, 2, 0).textContent).toBe('20')
    expect(cell(view, 2, 1).textContent).toBe('0')

    const errView = createEditor('| A |\n| --- |\n| 0 |\n| =1/A2 |')
    expect(cell(errView, 2, 0).textContent).toBe('#DIV/0!')
    expect(cell(errView, 2, 0).classList.contains('ss-error')).toBe(true)
    expect(cell(errView, 2, 0).title).toBe('=1/A2')
    errView.destroy()
    view.destroy()
  })

  it('flags a reference to a column that does not exist', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | =F2+C2 |')
    expect(cell(view, 1, 1).textContent).toBe('#REF!')
    expect(cell(view, 1, 1).classList.contains('ss-error')).toBe(true)
    view.destroy()
  })

  it('makes a cell active on click and labels it in the name box', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 1, 1))
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    expect(cell(view, 1, 0).classList.contains('ss-active')).toBe(false)
    expect(view.dom.querySelector('.ss-namebox')?.textContent).toBe('B2')
    view.destroy()
  })

  it('extends a range with drag and Shift+click', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')
    mousedown(cell(view, 0, 0))
    cell(view, 2, 2).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(cell(view, 0, 0).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 2, 2).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 2, 2).classList.contains('ss-active')).toBe(true)

    mousedown(cell(view, 1, 1), { shiftKey: true })
    expect(cell(view, 0, 0).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 1, 1).classList.contains('ss-range')).toBe(true)
    view.destroy()
  })

  it('toggles cells with Mod+click', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 1, 1), { ctrlKey: true })
    expect(cell(view, 1, 1).classList.contains('ss-selected')).toBe(true)
    mousedown(cell(view, 1, 1), { ctrlKey: true })
    expect(cell(view, 1, 1).classList.contains('ss-selected')).toBe(false)
    view.destroy()
  })

  it('selects whole columns, rows, and every cell from the corner', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    mousedown(colHeader(view, 1))
    expect(cell(view, 0, 1).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 2, 1).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 0, 0).classList.contains('ss-range')).toBe(false)

    mousedown(rowGutter(view, 0))
    expect(cell(view, 0, 0).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 0, 1).classList.contains('ss-range')).toBe(true)
    expect(cell(view, 1, 0).classList.contains('ss-range')).toBe(false)

    mousedown(tableGrid(view).querySelector('.ss-corner')!)
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        expect(cell(view, r, c).classList.contains('ss-range')).toBe(true)
      }
    }
    view.destroy()
  })

  it('shows the raw cell in the formula bar and commits edits', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | =A2*3 |')
    mousedown(cell(view, 1, 1))
    const fx = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    expect(fx.value).toBe('=A2*3')
    fx.value = '=A2+2'
    fx.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(docValue(view)).toContain('=A2+2')
    expect(cell(view, 1, 1).textContent).toBe('7')
    view.destroy()
  })

  it('recalculates totals when an input cell changes', () => {
    const view = createEditor(
      '| A | B |\n| --- | --- |\n| 10 | 5 |\n| =SUM(A2:B2) | x |',
    )
    expect(cell(view, 2, 0).textContent).toBe('15')
    mousedown(cell(view, 1, 0))
    const fx = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    fx.value = '5'
    fx.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(cell(view, 2, 0).textContent).toBe('10')
    view.destroy()
  })

  it('removes columns and rows from the chrome context menu', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |')
    deleteViaMenu(colHeader(view, 0), 'Delete column')
    expect(tableGrid(view).querySelectorAll('thead th').length).toBe(3)
    expect(docValue(view)).not.toContain('| 1 ')
    expect(docValue(view)).toContain('| 2 | 3 |')

    deleteViaMenu(rowGutter(view, 1), 'Delete row')
    expect(tableGrid(view).querySelectorAll('tbody tr').length).toBe(1)
    expect(docValue(view)).not.toContain('| 2 | 3 |')
    view.destroy()
  })

  it('deletes the clicked column from its header context menu', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |')
    colHeader(view, 1).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    )
    const menu = document.querySelector('.edi-context-menu')
    expect(menu).not.toBeNull()
    const items = menu!.querySelectorAll<HTMLButtonElement>('.edi-menu-item')
    expect(items).toHaveLength(1)
    expect(items[0]!.textContent).toBe('Delete column')
    items[0]!.click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'C'],
      ['1', '3'],
    ])
    expect(document.querySelector('.edi-context-menu')).toBeNull()
    view.destroy()
  })

  it('deletes the clicked row from its gutter context menu', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    rowGutter(view, 1).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    )
    const item = document.querySelector<HTMLButtonElement>('.edi-menu-item')
    expect(item?.textContent).toBe('Delete row')
    item!.click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['3', '4'],
    ])
    view.destroy()
  })

  it('disables deleting the last remaining column', () => {
    const view = createEditor('| A |\n| --- |\n| 1 |')
    colHeader(view, 0).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    )
    const colItem = document.querySelector<HTMLButtonElement>('.edi-menu-item')
    expect(colItem?.textContent).toBe('Delete column')
    expect(colItem?.disabled).toBe(true)
    rowGutter(view, 0).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    )
    const rowItem = document.querySelector<HTMLButtonElement>('.edi-menu-item')
    expect(rowItem?.textContent).toBe('Delete row')
    expect(rowItem?.disabled).toBe(false)
    rowItem!.click()
    expect(parsePipes(docValue(view))).toEqual([['1']])
    view.destroy()
  })

  it('adjusts a sum range when a row inside it is removed', () => {
    const view = createEditor(
      '| Item | Qty |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n| C | 3 |\n| Total | =SUM(B2:B4) |',
    )
    expect(cell(view, 4, 1).textContent).toBe('6')
    deleteViaMenu(rowGutter(view, 3), 'Delete row')
    expect(parsePipes(docValue(view))).toEqual([
      ['Item', 'Qty'],
      ['A', '1'],
      ['B', '2'],
      ['Total', '=SUM(B2:B3)'],
    ])
    expect(cell(view, 3, 1).textContent).toBe('3')
    expect(cell(view, 3, 1).classList.contains('ss-error')).toBe(false)
    view.destroy()
  })

  it('adjusts a sum range when a column inside it is removed', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | =SUM(A2:B2) |')
    expect(cell(view, 1, 2).textContent).toBe('3')
    deleteViaMenu(colHeader(view, 1), 'Delete column')
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'C'],
      ['1', '=SUM(A2:A2)'],
    ])
    expect(cell(view, 1, 1).textContent).toBe('1')
    view.destroy()
  })

  it('collapses a reference to a removed row into #REF!', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | =A2 |')
    deleteViaMenu(rowGutter(view, 1), 'Delete row')
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['3', '=#REF!'],
    ])
    expect(cell(view, 1, 1).textContent).toBe('#REF!')
    view.destroy()
  })

  it('clears a selection with the Delete key', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 1, 0), { ctrlKey: true })
    mousedown(cell(view, 1, 1), { ctrlKey: true })
    tableGrid(view).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    )
    expect(docValue(view)).toContain('|  |  |')

    mousedown(cell(view, 0, 0))
    tableGrid(view).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    )
    expect(docValue(view)).toContain('|  | B |')
    view.destroy()
  })

  it('keeps grid focus across a rebuild so typing still starts an edit', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, 'Delete')
    expect(document.activeElement).toBe(tableGrid(view))
    gridkey(view, 'x')
    expect((view.dom.querySelector('.ss-edit-input') as HTMLInputElement).value).toBe('x')
    view.destroy()
  })

  it('copies the selection as TSV', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    mousedown(cell(view, 1, 0))
    cell(view, 2, 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    const calls: Array<[string, string]> = []
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (type: string, data: string) => calls.push([type, data]),
        getData: () => '',
      },
    })
    tableGrid(view).dispatchEvent(event)
    expect(calls).toEqual([['text/plain', '1\t2\r\n3\t4']])
    view.destroy()
  })

  it('cut copies the selection as TSV and marquees the source cells', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    mousedown(cell(view, 1, 0))
    cell(view, 2, 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    const calls: Array<[string, string]> = []
    const event = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, data: string) => calls.push([type, data]), getData: () => '' },
    })
    tableGrid(view).dispatchEvent(event)
    expect(calls).toEqual([['text/plain', '1\t2\r\n3\t4']])
    expect(cell(view, 1, 0).classList.contains('ss-cut')).toBe(true)
    expect(cell(view, 2, 1).classList.contains('ss-cut')).toBe(true)
    expect(cell(view, 0, 0).classList.contains('ss-cut')).toBe(false)
    view.destroy()
  })

  it('cut then paste moves the cells and leaves the source blank', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    mousedown(cell(view, 1, 0))
    cell(view, 2, 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    const cutEvent = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(cutEvent, 'clipboardData', {
      value: { setData: () => {}, getData: () => '' },
    })
    tableGrid(view).dispatchEvent(cutEvent)
    mousedown(cell(view, 0, 0))
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? '1\t2\r\n3\t4' : ''), setData: () => {} },
    })
    tableGrid(view).dispatchEvent(pasteEvent)
    expect(parsePipes(docValue(view))).toEqual([
      ['1', '2'],
      ['3', '4'],
      ['', ''],
    ])
    expect(tableGrid(view).querySelector('td.ss-cut')).toBeNull()
    view.destroy()
  })

  it('updates references when the referenced cell is cut and pasted', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 5 | =A2 |  |')
    mousedown(cell(view, 1, 0))
    const cutEvent = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(cutEvent, 'clipboardData', {
      value: { setData: () => {}, getData: () => '' },
    })
    tableGrid(view).dispatchEvent(cutEvent)
    mousedown(cell(view, 1, 2))
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? '5' : ''), setData: () => {} },
    })
    tableGrid(view).dispatchEvent(pasteEvent)
    expect(parsePipes(docValue(view))[1]).toEqual(['', '=C2', '5'])
    view.destroy()
  })

  it('leaves references unchanged when the cell is copied and pasted', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 5 | =A2 |  |')
    mousedown(cell(view, 1, 0))
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(copyEvent, 'clipboardData', {
      value: { setData: () => {}, getData: () => '' },
    })
    tableGrid(view).dispatchEvent(copyEvent)
    mousedown(cell(view, 1, 2))
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? '5' : ''), setData: () => {} },
    })
    tableGrid(view).dispatchEvent(pasteEvent)
    expect(parsePipes(docValue(view))[1]).toEqual(['5', '=A2', '5'])
    view.destroy()
  })

  it('pastes tile the pattern across a selection larger than the data', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |')
    mousedown(cell(view, 1, 0))
    cell(view, 2, 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? 'x\ty\nz' : ''), setData: () => {} },
    })
    tableGrid(view).dispatchEvent(event)
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['x', 'y'],
      ['z', ''],
      ['5', '6'],
    ])
    view.destroy()
  })

  it('does not hijack copy or paste while editing a cell', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const editInput = grid.querySelector('.ss-edit-input') as HTMLInputElement
    editInput.focus()
    editInput.value = 'FOO'
    let calls = 0
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(copyEvent, 'clipboardData', {
      value: { setData: () => { calls += 1 }, getData: () => '' },
    })
    editInput.dispatchEvent(copyEvent)
    expect(copyEvent.defaultPrevented).toBe(false)
    expect(calls).toBe(0)
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => 'CLIP', setData: () => {} },
    })
    editInput.dispatchEvent(pasteEvent)
    expect(pasteEvent.defaultPrevented).toBe(false)
    expect(docValue(view)).not.toContain('CLIP')
    view.destroy()
  })

  it('pastes TSV over the grid, growing it as needed', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    mousedown(cell(view, 1, 1))
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'x\ty\nz' : ''), setData: () => {} },
    })
    tableGrid(view).dispatchEvent(event)
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B', ''],
      ['1', 'x', 'y'],
      ['3', 'z', ''],
    ])
    view.destroy()
  })

  it('round-trips through source mode', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const pos = 0
    view.dispatch(enterSourceMode(view.state, pos))
    expect(view.dom.querySelector('.spreadsheet')).toBeNull()
    expect(view.dom.querySelector('.cm-content')).toBeTruthy()
    view.dispatch(exitSourceMode(view.state))
    expect(view.dom.querySelector('.spreadsheet')).toBeTruthy()
    expect(proseToMarkdown(view.state.doc)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n')
    view.destroy()
  })

  it('inserts an empty table of the requested size', () => {
    const view = createEditor('hello')
    insertTable(view, 3, 4)
    const table = view.state.doc.child(view.state.doc.childCount - 1)
    expect(table.type.name).toBe('table')
    expect(proseToMarkdown(view.state.doc)).toContain(
      '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |',
    )
    view.destroy()
  })

  it('opens a newly inserted table directly in spreadsheet mode', () => {
    const view = createEditor('')
    insertTable(view, 3, 2)
    expect(view.state.doc.firstChild?.attrs._plain).toBe(false)
    expect(view.state.selection).not.toBeInstanceOf(NodeSelection)
    expect(view.dom.querySelector('.spreadsheet')).toBeTruthy()
    expect(view.dom.querySelector('.ss-grid')).toBeTruthy()
    view.destroy()
  })

  it('keeps a single spreadsheet open at a time, like block source mode', () => {
    const view = createPlainTable('| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |')
    const handles = Array.from(view.dom.querySelectorAll('.block-handle'))
    expect(handles.length).toBe(2)
    enterSpreadsheetMode(view, Number(handles[0]!.getAttribute('data-block-pos')))
    expect(view.dom.querySelectorAll('.spreadsheet').length).toBe(1)
    enterSpreadsheetMode(view, Number(handles[1]!.getAttribute('data-block-pos')))
    expect(view.dom.querySelectorAll('.spreadsheet').length).toBe(1)
    expect(view.state.doc.child(0).attrs._plain).toBe(true)
    expect(view.state.doc.child(1).attrs._plain).toBe(false)
    view.destroy()
  })

  it('double-clicking outside the spreadsheet closes edit mode', () => {
    const view = createPlainTable('| A |\n| --- |\n| 1 |')
    const tbl = view.dom.querySelector('.ss-plain-table') as HTMLElement
    tbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.spreadsheet')).toBeTruthy()
    view.dom.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.spreadsheet')).toBeNull()
    expect(view.dom.querySelector('.ss-plain')).toBeTruthy()
    view.destroy()
  })

  it('double-clicking outside the editor closes edit mode when the table is the only node', () => {
    const view = createPlainTable('| A |\n| --- |\n| 1 |')
    const tbl = view.dom.querySelector('.ss-plain-table') as HTMLElement
    tbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.spreadsheet')).toBeTruthy()
    document.body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.spreadsheet')).toBeNull()
    expect(view.dom.querySelector('.ss-plain')).toBeTruthy()
    view.destroy()
  })

  it('spreadsheet mode deselects the table so typing cannot replace it', () => {
    const view = createPlainTable('| A |\n| --- |\n| 1 |')
    const tbl = view.dom.querySelector('.ss-plain-table') as HTMLElement
    tbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.state.selection).not.toBeInstanceOf(NodeSelection)
    const grid = view.dom.querySelector('.ss-grid') as HTMLElement
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.firstChild?.type.name).toBe('table')
    view.destroy()
  })

  it('inserts a table at the start of a new document without a leading paragraph', () => {
    const view = createEditor('')
    insertTable(view, 3, 2)
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.firstChild?.type.name).toBe('table')
    view.destroy()
  })

  it('sizes columns to their content', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    const cols = grid.querySelectorAll('colgroup col')
    expect(cols.length).toBe(3)
    for (const col of Array.from(cols)) {
      expect((col as HTMLTableColElement).style.width).not.toBe('')
    }
    view.destroy()
  })

  it('renders masked fields and formatting inside cells', () => {
    const view = createEditor(
      '| A | B |\n| --- | --- |\n| **bold** | !masked[c1]{label="PIN"} |',
    )
    const a = cell(view, 1, 0)
    expect(a.querySelector('strong')?.textContent).toBe('bold')
    expect(a.innerHTML).toContain('<strong>bold</strong>')
    const b = cell(view, 1, 1)
    expect(b.querySelector('.masked-field')?.textContent).toBe(
      '•••••••••••• (PIN)',
    )
    view.destroy()
  })

  it('Tab moves right and wraps to the next row column 0', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 0, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 0, 1).classList.contains('ss-active')).toBe(true)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 1, 0).classList.contains('ss-active')).toBe(true)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 2, 0).classList.contains('ss-active')).toBe(true)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 2, 1).classList.contains('ss-active')).toBe(true)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 0, 0).classList.contains('ss-active')).toBe(true)
    view.destroy()
  })

  it('Shift+Tab moves left and wraps to the previous row last col', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 0, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(cell(view, 1, 0).classList.contains('ss-active')).toBe(true)
    view.destroy()
  })

  it('Tab in the edit overlay commits and moves right', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const editInput = grid.querySelector('.ss-edit-input') as HTMLInputElement
    expect(editInput.value).toBe('1')
    editInput.value = 'FOO'
    editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    expect(docValue(view)).toContain('FOO')
    view.destroy()
  })

  it('undoes and redoes cell edits with Ctrl+Z / Ctrl+Shift+Z', () => {
    const ed = createBlockEditor(document.body, '| A |\n| --- |\n| 1 |')
    const view = ed.getView()
    enterSpreadsheetMode(view, 0)
    let grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const editInput = grid.querySelector('.ss-edit-input') as HTMLInputElement
    editInput.value = '2'
    editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(parsePipes(docValue(view))[1]).toEqual(['2'])

    grid = tableGrid(view)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(parsePipes(docValue(view))[1]).toEqual(['1'])
    expect(cell(view, 1, 0).classList.contains('ss-active')).toBe(true)

    grid = tableGrid(view)
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    expect(parsePipes(docValue(view))[1]).toEqual(['2'])
    expect(cell(view, 1, 0).classList.contains('ss-active')).toBe(true)
    ed.destroy()
  })

  it('a blur arriving during edit teardown does not swallow the Tab move', () => {
    // Chromium fires `blur` synchronously when the focused edit input is
    // removed mid-commit (teardownEdit). The blur handler re-enters
    // commitCellEdit, which must be a safe no-op (edit/overlay already
    // nulled in teardownEdit) so the Tab handler's move still runs. The
    // previous remove-after-null ordering let that reentrant commit swallow
    // the outer handler, leaving the active cell stuck on the first Tab.
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const editInput = grid.querySelector('.ss-edit-input') as HTMLInputElement
    editInput.value = 'FOO'
    const realRemove = editInput.remove.bind(editInput)
    let commitsDuringTeardown = 0
    const blurHandler = () => {
      commitsDuringTeardown += 1
    }
    editInput.addEventListener('blur', blurHandler)
    ;(editInput as unknown as { remove: () => void }).remove = () => {
      // Model Chromium: removal of the focused element fires blur on the
      // input before the input is actually detached.
      editInput.dispatchEvent(new Event('blur'))
      realRemove()
    }
    editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(commitsDuringTeardown).toBe(1)
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    expect(docValue(view)).toContain('FOO')
    editInput.removeEventListener('blur', blurHandler)
    view.destroy()
  })

  it('Tab in the fx bar commits and moves right', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const fxInput = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    fxInput.focus()
    fxInput.value = 'FOO'
    fxInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    expect(docValue(view)).toContain('FOO')
    view.destroy()
  })

  it('applyInline wraps and unwraps bold in the active cell', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const host = getActiveCellHost()
    expect(host).toBeTruthy()
    host!.applyInline('bold')
    expect(docValue(view)).toContain('**hello**')
    host!.applyInline('bold')
    expect(docValue(view)).toContain('hello')
    expect(docValue(view)).not.toContain('**')
    view.destroy()
  })

  it('applyInline wraps link with url', () => {
    const view = createEditor('| A |\n| --- |\n| clickme |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    getActiveCellHost()!.applyInline('link', 'https://example.com')
    expect(docValue(view)).toContain('[clickme](https://example.com)')
    view.destroy()
  })

  it('applyInline combines bold with italic as nested marks', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const host = getActiveCellHost()!
    host.applyInline('bold')
    host.applyInline('italic')
    expect(docValue(view)).toContain('***hello***')
    const pill = cell(view, 1, 0).querySelector('.ss-cell-content')!
    expect(pill.innerHTML).toContain('<strong><em>hello</em></strong>')
    // Redundant apply keeps the composition instead of mangling it.
    host.applyInline('bold')
    host.applyInline('italic')
    expect(docValue(view)).toContain('hello')
    expect(docValue(view)).not.toContain('*')
    view.destroy()
  })

  it('applyInline combines code inside bold', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const host = getActiveCellHost()!
    host.applyInline('code')
    host.applyInline('bold')
    expect(docValue(view)).toContain('**`hello`**')
    expect(cell(view, 1, 0).querySelector('.ss-cell-content')!.innerHTML).toContain(
      '<strong><code>hello</code></strong>',
    )
    view.destroy()
  })

  it('applyInline toggles highlight, sub, and sup in the active cell', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const host = getActiveCellHost()!
    host.applyInline('highlight')
    host.applyInline('sub')
    host.applyInline('sup')
    expect(docValue(view)).toContain('==~^hello^~==')
    expect(cell(view, 1, 0).querySelector('.ss-cell-content')!.innerHTML).toContain(
      '<mark><sub><sup>hello</sup></sub></mark>',
    )
    // All marks still toggle off together.
    host.applyInline('highlight')
    host.applyInline('sub')
    host.applyInline('sup')
    expect(docValue(view)).toContain('hello')
    expect(docValue(view)).not.toContain('==')
    expect(docValue(view)).not.toContain('~')
    expect(docValue(view)).not.toContain('^')
    view.destroy()
  })

  it('applyInline renders pre-existing sub/sup/highlight cells', () => {
    const view = createEditor('| A |\n| --- |\n| H~2~O and x^2^ and ==y== |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const content = cell(view, 1, 0).querySelector('.ss-cell-content')!.innerHTML
    expect(content).toContain('H<sub>2</sub>O')
    expect(content).toContain('x<sup>2</sup>')
    expect(content).toContain('<mark>y</mark>')
    view.destroy()
  })

  it('applyInline bold round-trips a mixed-marks cell through the streaming serializer', () => {
    const view = createEditor('| A |\n| --- |\n| ***start** middle* |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const host = getActiveCellHost()!
    // The importer normalizes the slightly-off form into a uniform strong+em
    // run, so the bold toggle flips it to italic-only…
    expect(docValue(view)).toContain('***start middle***')
    host.applyInline('bold')
    expect(docValue(view)).toContain('*start middle*')
    expect(cell(view, 1, 0).querySelector('.ss-cell-content')!.innerHTML).toContain(
      '<em>start middle</em>',
    )
    // …and back on again, keeping the marks composed.
    host.applyInline('bold')
    expect(docValue(view)).toContain('***start middle***')
    view.destroy()
  })

  it('Mod+b / Mod+i keyboard shortcuts toggle bold and italic in the grid', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    gridkey(view, 'b', true)
    expect(docValue(view)).toContain('**hello**')
    gridkey(view, 'i', true)
    expect(docValue(view)).toContain('***hello***')
    gridkey(view, 'b', true)
    gridkey(view, 'i', true)
    expect(docValue(view)).toContain('hello')
    expect(docValue(view)).not.toContain('*')
    view.destroy()
  })

  it('Mod+b / Mod+i keyboard shortcuts work across a grid selection', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    const grid = tableGrid(view)
    grid.focus()
    selectRegion(view, 1, 0, 2, 1)
    gridkey(view, 'b', true)
    expect(docValue(view)).toContain('**1**')
    expect(docValue(view)).toContain('**2**')
    expect(docValue(view)).toContain('**3**')
    expect(docValue(view)).toContain('**4**')
    view.destroy()
  })

  it('Mod+b while editing a cell toggles bold on the edited value', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const editInput = view.dom.querySelector('.ss-edit-input') as HTMLInputElement
    expect(editInput).toBeTruthy()
    editInput.value = 'world'
    editInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
    )
    expect(docValue(view)).toContain('**world**')
    view.destroy()
  })

  it('Mod+b in the fx bar wraps the active cell in bold', () => {
    const view = createEditor('| A |\n| --- |\n| hello |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    const fx = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    fx.focus()
    fx.value = 'world'
    fx.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
    expect(docValue(view)).toContain('**world**')
    view.destroy()
  })

  it('cell masked pill gets interactive actions', async () => {
    const envelope = await encryptField('s3cret', 'pw')
    const view = createEditor(`| A |\n| --- |\n| !masked[${envelope}]{label="Key"} |`)
    const pill = cell(view, 1, 0).querySelector('.masked-field') as HTMLElement
    expect(pill).toBeTruthy()
    expect(pill.classList.contains('masked-field-cell')).toBe(true)
    expect(pill.querySelector('.masked-field-eye')).toBeTruthy()
    expect(pill.querySelector('.masked-field-copy')).toBeTruthy()
    expect(pill.querySelector('.masked-field-edit-btn')).toBeTruthy()
    ;(pill.querySelector('.masked-field-eye') as HTMLButtonElement).click()
    const overlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    const input = overlay.querySelector('.edi-dialog-input') as HTMLInputElement
    input.value = 'pw'
    ;(overlay.querySelector('.fmt-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('.edi-dialog-overlay')).toBeNull()
    }, { timeout: 5000 })
    expect(pill.querySelector('.masked-field-value')?.textContent).toBe('s3cret')
    expect(pill.classList.contains('masked-field-revealed')).toBe(true)
    view.destroy()
  })

  it('cell masked pill edits inline like a body masked field', async () => {
    const envelope = await encryptField('s3cret', 'pw')
    const view = createEditor(`| A |\n| --- |\n| !masked[${envelope}]{label="Key"} |`)
    const pill = cell(view, 1, 0).querySelector('.masked-field') as HTMLElement
    ;(pill.querySelector('.masked-field-edit-btn') as HTMLButtonElement).click()

    const overlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    const pwInput = overlay.querySelector('.edi-dialog-input') as HTMLInputElement
    pwInput.value = 'pw'
    ;(overlay.querySelector('.fmt-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('.edi-dialog-overlay')).toBeNull()
    }, { timeout: 5000 })

    const editInput = pill.querySelector('.masked-field-input') as HTMLInputElement
    expect(editInput).toBeTruthy()
    expect(editInput.value).toBe('s3cret')
    editInput.value = 'updated'
    editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // Saving re-encrypts with the same password: no second prompt.
    expect(document.body.querySelector('.edi-dialog-overlay')).toBeNull()
    await vi.waitFor(() => {
      expect(docValue(view)).toContain('!masked[')
    }, { timeout: 5000 })
    expect(docValue(view)).toContain(']{label="Key"}')
    view.destroy()
  })

  it('cell masked pill edit with a wrong password shows the error and never opens the editor', async () => {
    const envelope = await encryptField('s3cret', 'pw')
    const view = createEditor(`| A |\n| --- |\n| !masked[${envelope}]{label="Key"} |`)
    const pill = cell(view, 1, 0).querySelector('.masked-field') as HTMLElement
    ;(pill.querySelector('.masked-field-edit-btn') as HTMLButtonElement).click()

    const overlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
    const pwInput = overlay.querySelector('.edi-dialog-input') as HTMLInputElement
    pwInput.value = 'wrong'
    ;(overlay.querySelector('.fmt-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      const err = overlay.querySelector('.edi-dialog-error') as HTMLElement
      expect(err.hidden).toBe(false)
    }, { timeout: 15000 })
    expect(overlay.querySelector('.edi-dialog-error')?.textContent).toBe('Incorrect password')
    expect(pill.querySelector('.masked-field-input')).toBeNull()

    const cancel = overlay.querySelector('.edi-dialog-actions .fmt-btn:not(.fmt-primary)') as HTMLButtonElement
    cancel.click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('.edi-dialog-overlay')).toBeNull()
    }, { timeout: 15000 })
    expect(pill.querySelector('.masked-field-input')).toBeNull()
    view.destroy()
  }, 30000)

  it('format toolbar inserts an encrypted field into the active cell', async () => {
    const view = createEditor('| A |\n| --- |\n|  |')
    mousedown(cell(view, 0, 0))
    expect(getActiveCellHost()).toBeTruthy()
    expect(getActiveCellHost()!.applyInline('secret')).toBe(true)

    const createOverlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
    expect(createOverlay).toBeTruthy()
    const createInputs = createOverlay.querySelectorAll<HTMLInputElement>('.edi-dialog-input')
    createInputs[0]!.value = 'Api'
    createInputs[1]!.value = 'hunter2'
    ;(createOverlay.querySelector('.fmt-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('.edi-dialog-overlay')).toBeTruthy()
    }, { timeout: 3000 })

    const pwdOverlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
    expect(pwdOverlay).toBeTruthy()
    const pwdInput = pwdOverlay.querySelector('.edi-dialog-input') as HTMLInputElement
    pwdInput.value = 'pw3'
    ;(pwdOverlay.querySelector('.fmt-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(docValue(view)).toContain('!masked[')
    }, { timeout: 5000 })

    expect(docValue(view)).toContain(']{label="Api"}')
    const pill = cell(view, 0, 0).querySelector('.masked-field') as HTMLElement
    expect(pill.classList.contains('masked-field-cell')).toBe(true)
    view.destroy()
  })

  it('renders the default plain table view without spreadsheet chrome', () => {
    const view = createPlainTable('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(view.dom.querySelector('.ss-plain')).toBeTruthy()
    expect(view.dom.querySelector('.spreadsheet')).toBeNull()
    expect(view.dom.querySelector('.ss-grid')).toBeNull()
    expect(view.dom.querySelector('.ss-tools')).toBeNull()
    expect(view.dom.querySelector('.ss-fxbar')).toBeNull()
    expect(view.dom.querySelector('.ss-namebox')).toBeNull()

    const ths = view.dom.querySelectorAll('.ss-plain-table thead th')
    expect(ths.length).toBe(2)
    expect(ths[0]!.textContent).toBe('A')
    expect(ths[1]!.textContent).toBe('B')
    const tds = view.dom.querySelectorAll('.ss-plain-table tbody td')
    expect(tds.length).toBe(2)
    expect(tds[0]!.textContent).toBe('1')
    expect(tds[1]!.textContent).toBe('2')

    const spreadBtn = view.dom.querySelector('.ss-plain-tools .ss-tool')
    expect(spreadBtn?.textContent).toBe('Edit')
    view.destroy()
  })

  it('toggles from plain view to spreadsheet mode and back', () => {
    const view = createPlainTable('| A |\n| --- |\n| 1 |')
    const spreadBtn = view.dom.querySelector('.ss-plain-tools .ss-tool') as HTMLButtonElement
    spreadBtn.click()
    expect(view.dom.querySelector('.spreadsheet')).toBeTruthy()
    expect(view.dom.querySelector('.ss-plain')).toBeNull()
    expect(view.dom.querySelector('.ss-grid')).toBeTruthy()

    tool(view, 'View').click()
    expect(view.dom.querySelector('.ss-plain')).toBeTruthy()
    expect(view.dom.querySelector('.spreadsheet')).toBeNull()
    expect(proseToMarkdown(view.state.doc)).toBe('| A |\n| --- |\n| 1 |\n')
    view.destroy()
  })

  it('double-clicking a plain table opens the spreadsheet view', () => {
    const view = createPlainTable('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const tbl = view.dom.querySelector('.ss-plain-table') as HTMLElement
    tbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.spreadsheet')).toBeTruthy()
    expect(view.dom.querySelector('.ss-plain')).toBeNull()
    view.destroy()
  })

  it('double-clicking a masked-field pill in a plain table keeps its actions', async () => {
    const envelope = await encryptField('s3cret', 'pw')
    const view = createPlainTable(`| A |\n| --- |\n| !masked[${envelope}]{label="Key"} |`)
    const pill = view.dom.querySelector('.masked-field') as HTMLElement
    pill.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.ss-plain')).toBeTruthy()
    expect(view.dom.querySelector('.spreadsheet')).toBeNull()
    view.destroy()
  })

  it('keeps the row gutter a small fixed width', () => {
    const view = createEditor('| A |\n| --- |\n| 1 |')
    const gutter = view.dom.querySelector('.ss-gutter') as HTMLTableColElement
    expect(gutter).toBeTruthy()
    expect(gutter.style.width).toBe('30px')
    view.destroy()
  })

  it('renders computed formulas and masked pills in the plain view', async () => {
    const envelope = await encryptField('s3cret', 'pw')
    const view = createPlainTable(
      `| A | B |\n| --- | --- |\n| 5 | =A2*3 |\n| **bold** | !masked[${envelope}]{label="Key"} |`,
    )
    const tds = Array.from(view.dom.querySelectorAll('.ss-plain-table tbody td'))
    expect(tds[1]!.textContent).toBe('15')
    expect(tds[1]!.classList.contains('ss-formula')).toBe(true)
    expect(tds[2]!.querySelector('strong')?.textContent).toBe('bold')
    const pill = tds[3]!.querySelector('.masked-field') as HTMLElement
    expect(pill).toBeTruthy()
    expect(pill.classList.contains('masked-field-cell')).toBe(true)
    ;(pill.querySelector('.masked-field-eye') as HTMLButtonElement).click()
    const overlay = document.body.querySelector('.edi-dialog-overlay') as HTMLElement
    const input = overlay.querySelector('.edi-dialog-input') as HTMLInputElement
    input.value = 'pw'
    ;(overlay.querySelector('.fmt-primary') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('.edi-dialog-overlay')).toBeNull()
    }, { timeout: 5000 })
    expect(pill.querySelector('.masked-field-value')?.textContent).toBe('s3cret')
    view.destroy()
  })

  it('applyInline bold applies to the whole selection', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| x | **y** |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    mousedown(cell(view, 1, 1), { shiftKey: true })
    const host = getActiveCellHost()
    expect(host).toBeTruthy()
    host!.applyInline('bold')
    expect(docValue(view)).toContain('**x**')
    expect(docValue(view)).toContain('**y**')
    host!.applyInline('bold')
    expect(docValue(view)).not.toContain('**x**')
    expect(docValue(view)).not.toContain('**y**')
    expect(docValue(view)).toContain('x')
    expect(docValue(view)).toContain('y')
    view.destroy()
  })

  it('applyInline link sets the same URL across the selection', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| a | b |\n| 1 | 2 |')
    const grid = tableGrid(view)
    grid.focus()
    mousedown(cell(view, 1, 0))
    mousedown(cell(view, 1, 1), { shiftKey: true })
    getActiveCellHost()!.applyInline('link', 'https://example.com')
    expect(docValue(view)).toContain('[a](https://example.com)')
    expect(docValue(view)).toContain('[b](https://example.com)')
    view.destroy()
  })
})

describe('TableNodeView fill handle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('draws the handle on the selected corner and hides it while editing', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 0, 0))
    expect(fillHandle(view).parentElement).toBe(cell(view, 0, 0))
    mousedown(cell(view, 1, 1))
    expect(fillHandle(view).parentElement).toBe(cell(view, 1, 1))

    gridkey(view, 'Enter')
    expect(view.dom.querySelector('.ss-fill-handle')).toBeNull()
    view.destroy()
  })

  it('fills a numeric series down the column', () => {
    const view = createEditor('| A |\n| --- |\n| 1 |\n| 2 |\n|  |')
    selectRegion(view, 1, 0, 2, 0)
    dragFill(view, 3, 0)
    expect(parsePipes(docValue(view))).toEqual([['A'], ['1'], ['2'], ['3']])
    view.destroy()
  })

  it('duplicates a single text value down the column', () => {
    const view = createEditor('| A |\n| --- |\n| hi |\n|  |\n|  |')
    mousedown(cell(view, 1, 0))
    dragFill(view, 3, 0)
    expect(parsePipes(docValue(view))).toEqual([['A'], ['hi'], ['hi'], ['hi']])
    view.destroy()
  })

  it('extends embedded-number patterns', () => {
    const view = createEditor('| A |\n| --- |\n| Q1 |\n| Q2 |\n|  |')
    selectRegion(view, 1, 0, 2, 0)
    dragFill(view, 3, 0)
    expect(parsePipes(docValue(view))).toEqual([['A'], ['Q1'], ['Q2'], ['Q3']])
    view.destroy()
  })

  it('repeats a text cycle across rows', () => {
    const view = createEditor('| A |\n| --- |\n| Red |\n| Green |\n|  |')
    selectRegion(view, 1, 0, 2, 0)
    dragFill(view, 3, 0)
    expect(parsePipes(docValue(view))).toEqual([['A'], ['Red'], ['Green'], ['Red']])
    view.destroy()
  })

  it('shifts formula references as it fills down', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| =A2*2 | 0 |\n| 4 | 0 |\n|  |  |\n|  |  |')
    mousedown(cell(view, 1, 0))
    dragFill(view, 4, 0)
    const rows = parsePipes(docValue(view))
    expect(rows[2]?.[0]).toBe('=A3*2')
    expect(rows[3]?.[0]).toBe('=A4*2')
    expect(rows[4]?.[0]).toBe('=A5*2')
    view.destroy()
  })

  it('fills horizontally across a row', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 5 | 6 |  |')
    selectRegion(view, 1, 0, 1, 1)
    dragFill(view, 1, 2)
    expect(parsePipes(docValue(view))).toEqual([['A', 'B', 'C'], ['5', '6', '7']])
    view.destroy()
  })

  it('tints cells in the drag target region and previews the series', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n|  |  |')
    selectRegion(view, 1, 0, 2, 1)
    mousedown(fillHandle(view))
    cell(view, 3, 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(cell(view, 3, 1).classList.contains('ss-fill-target')).toBe(true)
    expect(view.dom.querySelector('.ss-fill-tooltip')?.textContent).toBe('5 \u2192 7 \u2192 9')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ])
    view.destroy()
  })

  it('double-clicking the handle autofills down to the adjacent data extent', () => {
    const view = createEditor(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n|  | 3 |\n|  | 4 |\n|  |  |',
    )
    mousedown(cell(view, 1, 0))
    fillHandle(view).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    const rows = parsePipes(docValue(view))
    expect(rows[2]).toEqual(['1', '3'])
    expect(rows[3]).toEqual(['1', '4'])
    expect(rows[4]).toEqual(['', ''])
    view.destroy()
  })

  it('Ctrl+D fills the selection down from its top row', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | 6 |\n|  |  |')
    selectRegion(view, 1, 0, 2, 1)
    gridkey(view, 'd', true)
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['5', '6'],
      ['5', '6'],
    ])
    view.destroy()
  })

  it('Ctrl+R fills the selection right from its left column', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 5 |  |  |\n| 7 |  |  |')
    selectRegion(view, 1, 0, 2, 2)
    gridkey(view, 'r', true)
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B', 'C'],
      ['5', '5', '5'],
      ['7', '7', '7'],
    ])
    view.destroy()
  })
})

describe('TableNodeView column alignment', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders alignment parsed from the delimiter row', () => {
    const view = createEditor('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')
    expect(cell(view, 0, 0).dataset.align).toBe('left')
    expect(cell(view, 0, 1).dataset.align).toBe('center')
    expect(cell(view, 0, 2).dataset.align).toBe('right')
    view.destroy()
  })

  it('aligns the active column and writes the colons into the delimiter row', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 0, 1))
    alignTool(view, 'center').click()
    expect(docValue(view)).toContain('| --- | :---: |')
    expect(cell(view, 0, 1).dataset.align).toBe('center')
    expect(cell(view, 0, 0).dataset.align).toBe('none')
    view.destroy()
  })

  it('clears the alignment when the active alignment is clicked again', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    mousedown(cell(view, 0, 1))
    alignTool(view, 'center').click()
    expect(docValue(view)).toContain('| --- | :---: |')
    alignTool(view, 'center').click()
    expect(docValue(view)).toContain('| --- | --- |')
    expect(cell(view, 0, 1).dataset.align).toBe('none')
    expect(alignTool(view, 'center').classList.contains('ss-tool-active')).toBe(false)
    view.destroy()
  })

  it('aligns every selected column and highlights the active button', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    selectRegion(view, 0, 0, 1, 1)
    alignTool(view, 'right').click()
    expect(docValue(view)).toContain('| ---: | ---: |')
    expect(alignTool(view, 'right').classList.contains('ss-tool-active')).toBe(true)
    view.destroy()
  })

  it('preserves alignment when adding a row', () => {
    const view = createEditor('| A | B |\n| :---: | ---: |\n| 1 | 2 |')
    const gutter = rowGutter(view, 1)
    gutter.getBoundingClientRect = () =>
      ({ left: 0, right: 30, top: 100, bottom: 124, width: 30, height: 24, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
    gutter.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 122 }))
    ;(view.dom.querySelector('.ss-insert-plus') as HTMLElement).click()
    expect(parsePipes(docValue(view))).toHaveLength(3)
    expect(docValue(view)).toContain('| :---: | ---: |')
    view.destroy()
  })

  it('remaps alignment when a column is removed', () => {
    const view = createEditor('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')
    deleteViaMenu(colHeader(view, 1), 'Delete column')
    expect(docValue(view)).toContain('| :--- | ---: |')
    view.destroy()
  })

  it('renders alignment in the plain table view', () => {
    const view = createPlainTable('| A | B |\n| :---: | ---: |\n| 1 | 2 |')
    const tds = view.dom.querySelectorAll('.ss-plain-table tbody td')
    expect(tds[0]!.getAttribute('data-align')).toBe('center')
    expect(tds[1]!.getAttribute('data-align')).toBe('right')
    view.destroy()
  })
})

describe('TableNodeView insert row/column', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function hoverInsert(el: Element, clientX = 0, clientY = 0): void {
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }))
  }

  function stubRect(el: Element, left: number, right: number, top = 0, bottom = 20): void {
    el.getBoundingClientRect = () =>
      ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  }

  function insertPlus(view: EditorView): HTMLElement {
    const plus = view.dom.querySelector('.ss-insert-plus') as HTMLElement | null
    if (!plus) throw new Error('no insert plus rendered')
    return plus
  }

  function guide(view: EditorView): HTMLElement {
    return view.dom.querySelector('.ss-insert-guide') as HTMLElement
  }

  function spreadsheetDom(view: EditorView): HTMLElement {
    return view.dom.querySelector('.spreadsheet') as HTMLElement
  }

  it('shows the guide on a column boundary and inserts on click', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(guide(view).hidden).toBe(true)
    hoverInsert(colHeader(view, 1))
    expect(guide(view).hidden).toBe(false)
    expect(spreadsheetDom(view).classList.contains('ss-inserting-col')).toBe(true)
    insertPlus(view).click()
    expect(guide(view).hidden).toBe(true)
    expect(parsePipes(docValue(view))).toEqual([
      ['A', '', 'B'],
      ['1', '', '2'],
    ])
    view.destroy()
  })

  it('only shows the guide near a header boundary, not over its middle', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const header = colHeader(view, 1)
    stubRect(header, 100, 150)
    hoverInsert(header, 125, 5)
    expect(guide(view).hidden).toBe(true)
    hoverInsert(header, 102, 5)
    expect(guide(view).hidden).toBe(false)
    expect(spreadsheetDom(view).classList.contains('ss-inserting-col')).toBe(true)
    view.destroy()
  })

  it('appends a column when hovering the last column trailing boundary', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const header = colHeader(view, 1)
    stubRect(header, 100, 150)
    hoverInsert(header, 148, 5)
    expect(guide(view).hidden).toBe(false)
    expect((view.dom.querySelector('.ss-insert-line') as HTMLElement).style.left).toBe('149px')
    expect(insertPlus(view).title).toBe('Append column at the end')
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B', ''],
      ['1', '2', ''],
    ])
    view.destroy()
  })

  it('appends a row when hovering the last row bottom boundary', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    const gutter = rowGutter(view, 2)
    stubRect(gutter, 0, 30, 100, 124)
    hoverInsert(gutter, 5, 122)
    expect(guide(view).hidden).toBe(false)
    expect(spreadsheetDom(view).classList.contains('ss-inserting-row')).toBe(true)
    expect(insertPlus(view).title).toBe('Append row at the end')
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['1', '2'],
      ['3', '4'],
      ['', ''],
    ])
    view.destroy()
  })

  it('hides the guide when hovering the middle of a cell', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    hoverInsert(colHeader(view, 1))
    expect(guide(view).hidden).toBe(false)
    hoverInsert(cell(view, 1, 0), 1000, 1000)
    expect(guide(view).hidden).toBe(true)
    view.destroy()
  })

  it('keeps the guide while the pointer travels to the floating button', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    hoverInsert(colHeader(view, 1))
    const fxbar = view.dom.querySelector('.ss-fxbar') as Element
    hoverInsert(fxbar, 0, 0)
    expect(guide(view).hidden).toBe(false)
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', '', 'B'],
      ['1', '', '2'],
    ])
    view.destroy()
  })

  it('shifts references past an inserted column', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | =B2 |')
    hoverInsert(colHeader(view, 0))
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['', 'A', 'B', 'C'],
      ['', '1', '2', '=C2'],
    ])
    view.destroy()
  })

  it('carries column alignment across an insertion', () => {
    const view = createEditor('| A | B |\n| :---: | ---: |\n| 1 | 2 |')
    hoverInsert(colHeader(view, 1))
    insertPlus(view).click()
    expect(docValue(view)).toContain('| :---: | --- | ---: |')
    view.destroy()
  })

  it('grows a sum range when a row is inserted above the total', () => {
    const view = createEditor(
      '| Item | Qty |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n| Total | =SUM(B2:B3) |',
    )
    expect(cell(view, 3, 1).textContent).toBe('3')
    hoverInsert(rowGutter(view, 3))
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['Item', 'Qty'],
      ['A', '1'],
      ['B', '2'],
      ['', ''],
      ['Total', '=SUM(B2:B4)'],
    ])
    expect(cell(view, 4, 1).textContent).toBe('3')

    // A value typed into the freshly inserted row flows into the total.
    mousedown(cell(view, 3, 1))
    const fx = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    fx.value = '5'
    fx.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(cell(view, 4, 1).textContent).toBe('8')
    view.destroy()
  })

  it('shows the guide over a row gutter and inserts above it', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    hoverInsert(rowGutter(view, 2))
    expect(guide(view).hidden).toBe(false)
    expect(spreadsheetDom(view).classList.contains('ss-inserting-row')).toBe(true)
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['1', '2'],
      ['', ''],
      ['3', '4'],
    ])
    view.destroy()
  })

  it('shifts references at or below an inserted row', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | =A3 |\n| 3 | 4 |')
    hoverInsert(rowGutter(view, 2))
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['1', '=A4'],
      ['', ''],
      ['3', '4'],
    ])
    view.destroy()
  })

  it('leaves references above the insertion point untouched', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | =A2 |\n| 3 | 4 |')
    hoverInsert(rowGutter(view, 2))
    insertPlus(view).click()
    expect(parsePipes(docValue(view))).toEqual([
      ['A', 'B'],
      ['1', '=A2'],
      ['', ''],
      ['3', '4'],
    ])
    view.destroy()
  })
})

describe('TableNodeView formula point mode', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function editInput(view: EditorView): HTMLInputElement {
    const input = tableGrid(view).querySelector('.ss-edit-input') as HTMLInputElement | null
    if (!input) throw new Error('no .ss-edit-input rendered')
    return input
  }

  it('inserts a cell reference when clicking while entering a formula', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, '=')
    const input = editInput(view)
    expect(input.value).toBe('=')
    mousedown(cell(view, 1, 1))
    expect(input.value).toBe('=B2')
    expect(editInput(view)).toBe(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(parsePipes(docValue(view))[1]).toEqual(['=B2', '6'])
    view.destroy()
  })

  it('inserts a range reference when dragging while entering a formula', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, 'Enter')
    const input = editInput(view)
    input.value = '=SUM('
    input.setSelectionRange(5, 5)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    mousedown(cell(view, 1, 0))
    cell(view, 2, 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(input.value).toBe('=SUM(A2:B3')
    expect(cell(view, 1, 0).classList.contains('ss-point')).toBe(true)
    expect(cell(view, 2, 1).classList.contains('ss-point')).toBe(true)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(parsePipes(docValue(view))[1]?.[0]).toBe('=SUM(A2:B3')
    expect(tableGrid(view).querySelectorAll('.ss-point')).toHaveLength(0)
    view.destroy()
  })

  it('keeps editing when clicking the edit input itself', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, 'Enter')
    const input = editInput(view)
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(editInput(view)).toBe(input)
    view.destroy()
  })

  it('still commits and moves when the cell is not a formula', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, 'Enter')
    const input = editInput(view)
    input.value = 'X'
    mousedown(cell(view, 1, 1))
    expect(tableGrid(view).querySelector('.ss-edit-input')).toBeNull()
    expect(parsePipes(docValue(view))[1]).toEqual(['X', '6'])
    view.destroy()
  })

  it('inserts a reference into the fx bar formula', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | 6 |')
    const fx = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    fx.focus()
    fx.value = '='
    fx.dispatchEvent(new Event('input', { bubbles: true }))
    mousedown(cell(view, 1, 1))
    expect(fx.value).toBe('=B2')
    expect(document.activeElement).toBe(fx)
    view.destroy()
  })

  it('does not treat a highlighted cell as a formula', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| ==x== | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, 'Enter')
    expect(editInput(view).value).toBe('==x==')
    mousedown(cell(view, 1, 1))
    expect(tableGrid(view).querySelector('.ss-edit-input')).toBeNull()
    view.destroy()
  })

  it('replaces the picked reference instead of concatenating', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, '=')
    const input = editInput(view)
    mousedown(cell(view, 1, 1))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    mousedown(cell(view, 1, 2))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(input.value).toBe('=C2')
    view.destroy()
  })

  it('double-clicking a cell finishes the formula and selects that cell', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, '=')
    mousedown(cell(view, 1, 1))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    cell(view, 2, 2).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(parsePipes(docValue(view))[1]?.[0]).toBe('=C3')
    expect(view.dom.querySelector('.ss-namebox')?.textContent).toBe('C3')
    view.destroy()
  })

  it('uses the pointer cursor only while picking references', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const grid = tableGrid(view)
    mousedown(cell(view, 1, 0))
    gridkey(view, '9')
    expect(editInput(view).value).toBe('9')
    expect(grid.classList.contains('ss-pointing')).toBe(false)
    editInput(view).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    mousedown(cell(view, 1, 0))
    gridkey(view, '=')
    expect(grid.classList.contains('ss-pointing')).toBe(true)
    view.destroy()
  })

  it('mirrors the in-cell editor into the fx bar', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 5 | 6 |')
    const fx = view.dom.querySelector('.ss-fx-input') as HTMLInputElement
    mousedown(cell(view, 1, 0))
    gridkey(view, '=')
    const input = editInput(view)
    expect(input.value).toBe('=')
    expect(fx.value).toBe('=')
    mousedown(cell(view, 1, 1))
    expect(input.value).toBe('=B2')
    expect(fx.value).toBe('=B2')
    view.destroy()
  })

  it('replaces a picked reference when extending it to a dragged range', () => {
    const view = createEditor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')
    mousedown(cell(view, 1, 0))
    gridkey(view, '=')
    const input = editInput(view)
    mousedown(cell(view, 1, 1))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(input.value).toBe('=B2')
    mousedown(cell(view, 2, 1))
    cell(view, 2, 2).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(input.value).toBe('=B3:C3')
    view.destroy()
  })

  it('resolves formulas through the toolbar checkbox', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 10 | =A2*2 |')
    const input = view.dom.querySelector('.ss-tool-check input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.checked).toBe(false)

    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))

    const node = view.state.doc.child(0)
    expect(node.attrs._resolved).toBe(true)
    const serialized = proseToMarkdown(view.state.doc)
    expect(serialized).toBe(
      '| A | B |\n| --- | --- |\n| 10 | 20 |\n\n<!-- edi-fml {"B2":"=A2*2"} -->\n',
    )

    const refreshed = view.dom.querySelector('.ss-tool-check input') as HTMLInputElement
    expect(refreshed.checked).toBe(true)
    view.destroy()
  })

  it('untoggles resolution back to formulas', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 10 | =A2*2 |')
    const input = view.dom.querySelector('.ss-tool-check input') as HTMLInputElement
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const refreshed = view.dom.querySelector('.ss-tool-check input') as HTMLInputElement
    refreshed.checked = false
    refreshed.dispatchEvent(new Event('change', { bubbles: true }))
    const node = view.state.doc.child(0)
    expect(node.attrs._resolved).toBe(false)
    expect(proseToMarkdown(view.state.doc)).toBe(
      '| A | B |\n| --- | --- |\n| 10 | =A2*2 |\n',
    )
    view.destroy()
  })

  it('keeps the active cell when toggling resolve', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 10 | =A2*2 |')
    mousedown(cell(view, 1, 1))
    expect(view.dom.querySelector('.ss-namebox')?.textContent).toBe('B2')
    const input = view.dom.querySelector('.ss-tool-check input') as HTMLInputElement
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(view.state.doc.child(0).attrs._resolved).toBe(true)
    expect(view.dom.querySelector('.ss-tool-check input')).toBe(input)
    expect(view.dom.querySelector('.ss-namebox')?.textContent).toBe('B2')
    expect(cell(view, 1, 1).classList.contains('ss-active')).toBe(true)
    view.destroy()
  })
})
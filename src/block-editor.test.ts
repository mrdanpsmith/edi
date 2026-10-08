import { describe, expect, it, beforeEach, vi } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Node as ProseNode } from 'prosemirror-model'
import { setBlockType } from 'prosemirror-commands'
import { history, undo } from 'prosemirror-history'
import { blockModePlugin, currentBlockMode, enterSourceMode, exitSourceMode, setBlockModeAt, toggleSourceMode } from './block-modes'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { enterDiagramEditMode, exitDiagramEditMode, mermaidNodeViewPlugin } from './node/mermaid'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { tableNodeViewPlugin } from './node/table'
import { serializeBlock } from './markdown'
import { Plugin } from 'prosemirror-state'

/** The position the single block-mode record names, or null. */
function sourcePos(view: EditorView): number | null {
  return currentBlockMode(view.state)?.pos ?? null
}

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg viewBox="0 0 900 300"></svg>',
      diagramType: 'base',
    }),
  },
}))

import * as mermaidModule from 'mermaid'

function createEditor(initialMarkdown: string, extraPlugins: Plugin[] = []) {
  const doc = markdownToProse(initialMarkdown, schema)
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
      plugins: [blockModePlugin, codeBlockNodeViewPlugin, nodeViewPlugin, mermaidNodeViewPlugin, tableNodeViewPlugin, ...extraPlugins],
    }),
  })
  return view
}

function firstBlockPos(view: EditorView): number {
  let pos = -1
  view.state.doc.forEach((_node, offset) => {
    if (pos < 0) pos = offset
  })
  return pos
}

function allBlockPositions(view: EditorView): number[] {
  const positions: number[] = []
  view.state.doc.forEach((_node, offset) => {
    positions.push(offset)
  })
  return positions
}

function blockNodeAt(view: EditorView, pos: number): ProseNode | null {
  let result: ProseNode | null = null
  view.state.doc.forEach((node: ProseNode, offset: number) => {
    if (offset === pos) result = node
  })
  return result
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.matchMedia = ((_query: string) => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

describe('blockMode record', () => {
  it('starts with no source block', () => {
    const view = createEditor('# Hello')
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })

  it('enterSourceMode sets _source attr and the record', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)

    expect(sourcePos(view)).toBe(pos)
    expect(currentBlockMode(view.state)).toEqual({
      pos,
      type: 'heading',
      representation: 'source',
      interaction: 'viewing',
    })

    const node = blockNodeAt(view, pos)
    expect(node!.attrs._source).toBe(true)
    view.destroy()
  })

  it('exitSourceMode clears _source attr and the record', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)

    expect(sourcePos(view)).toBeNull()

    const node = blockNodeAt(view, pos)
    expect(node!.attrs._source).toBe(false)
    view.destroy()
  })

  it('toggleSourceMode enters when not in source mode', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    toggleSourceMode(view, pos)
    expect(sourcePos(view)).toBe(pos)
    view.destroy()
  })

  it('toggleSourceMode exits when clicking same block', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    toggleSourceMode(view, pos)
    expect(sourcePos(view)).toBeNull()
    view.destroy()
  })

  it('toggleSourceMode switches to different block', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const positions = allBlockPositions(view)
    expect(positions.length).toBe(2)

    enterSourceMode(view, positions[0])
    expect(sourcePos(view)).toBe(positions[0])

    toggleSourceMode(view, positions[1])
    expect(sourcePos(view)).toBe(positions[1])

    const node0 = blockNodeAt(view, positions[0])
    expect(node0!.attrs._source).toBe(false)
    const node1 = blockNodeAt(view, positions[1])
    expect(node1!.attrs._source).toBe(true)
    view.destroy()
  })
})

describe('block nodeView factory', () => {
  it('creates visual NodeView when _source is false', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    const deco = view.nodeDOM(pos) as HTMLElement
    expect(deco).toBeTruthy()
    expect(deco.classList.contains('block-visual-mode')).toBe(true)
    view.destroy()
  })

  it('creates source NodeView when _source is true', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const deco = view.nodeDOM(pos) as HTMLElement
    expect(deco).toBeTruthy()
    expect(deco.classList.contains('block-source-mode')).toBe(true)
    view.destroy()
  })

  it('switches back to visual after exitSourceMode', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    expect((view.nodeDOM(pos) as HTMLElement).classList.contains('block-source-mode')).toBe(true)

    exitSourceMode(view)
    const deco = view.nodeDOM(pos) as HTMLElement
    expect(deco).toBeTruthy()
    expect(deco.classList.contains('block-visual-mode')).toBe(true)
    view.destroy()
  })

  it('source view has exit button', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    const btn = dom.querySelector('.block-source-exit') as HTMLElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toBe('Visual mode')
    view.destroy()
  })

  it('source view has a CodeMirror editor', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    const cm = dom.querySelector('.cm-editor') as HTMLElement
    expect(cm).toBeTruthy()
    view.destroy()
  })

  it('visual view has block handle', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    const dom = view.nodeDOM(pos) as HTMLElement
    const handle = dom.querySelector('.block-handle') as HTMLElement
    expect(handle).toBeTruthy()
    expect(handle.getAttribute('data-block-pos')).toBe(String(pos))
    view.destroy()
  })

  it('source view does NOT have block handle', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    const handle = dom.querySelector('.block-handle')
    expect(handle).toBeNull()
    view.destroy()
  })

  it('re-renders the heading element when the level changes', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    const before = (view.nodeDOM(pos) as HTMLElement).querySelector('h1') as HTMLElement
    expect(before).not.toBeNull()

    const doc = view.state.doc
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 2)))
    setBlockType(view.state.schema.nodes.heading, { level: 3 })(view.state, view.dispatch)

    const after = (view.nodeDOM(pos) as HTMLElement).querySelector('h3') as HTMLElement
    expect(after).not.toBeNull()
    expect(after.textContent).toBe('Hello')
    view.destroy()
  })

  it('re-renders the element when a paragraph becomes a heading (and back)', () => {
    const view = createEditor('Hello')
    const pos = firstBlockPos(view)
    expect((view.nodeDOM(pos) as HTMLElement).querySelector('p')).not.toBeNull()

    const doc = view.state.doc
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 2)))
    setBlockType(view.state.schema.nodes.heading, { level: 1 })(view.state, view.dispatch)
    expect((view.nodeDOM(pos) as HTMLElement).querySelector('h1')).not.toBeNull()

    setBlockType(view.state.schema.nodes.paragraph)(view.state, view.dispatch)
    expect((view.nodeDOM(pos) as HTMLElement).querySelector('p')).not.toBeNull()
    view.destroy()
  })
})

describe('source mode round-trip', () => {
  it('content survives enter source and exit', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)

    enterSourceMode(view, pos)
    exitSourceMode(view)

    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('Hello')
    view.destroy()
  })

  it('entering source mode on a block above a table does not select the table', () => {
    const view = createEditor('Alpha\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
    enterSourceMode(view, 0)

    // The caret was inside the block being toggled; the remap of the block's
    // replaceWith must not snap forward onto the adjacent table (which turned
    // the selection into a bogus NodeSelection with a blue outline).
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.from).toBeGreaterThan(0)

    let tablePos = -1
    view.state.doc.forEach((n, offset) => {
      if (n.type.name === 'table') tablePos = offset
    })
    expect(view.state.selection.from).toBeLessThan(tablePos)
    expect((view.nodeDOM(tablePos) as Element | null)?.classList.contains('ProseMirror-selectednode')).toBe(false)
    view.destroy()
  })

  it('exiting source mode on a block above a table does not select the table', () => {
    const view = createEditor('Alpha\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
    enterSourceMode(view, 0)
    exitSourceMode(view)

    expect(view.state.selection).toBeInstanceOf(TextSelection)

    let tablePos = -1
    view.state.doc.forEach((n, offset) => {
      if (n.type.name === 'table') tablePos = offset
    })
    expect((view.nodeDOM(tablePos) as Element | null)?.classList.contains('ProseMirror-selectednode')).toBe(false)
    view.destroy()
  })

  it('switching source mode between blocks above a table does not select the table', () => {
    const view = createEditor('Alpha\n\nBeta\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
    const positions = allBlockPositions(view)
    expect(positions[1]).toBeGreaterThan(0)

    enterSourceMode(view, positions[0])
    toggleSourceMode(view, positions[1])

    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(sourcePos(view)).toBe(positions[1])

    let tablePos = -1
    view.state.doc.forEach((n, offset) => {
      if (n.type.name === 'table') tablePos = offset
    })
    expect((view.nodeDOM(tablePos) as Element | null)?.classList.contains('ProseMirror-selectednode')).toBe(false)
    view.destroy()
  })

  it('edited source content is applied on exit', () => {
    const view = createEditor('Original text')
    const pos = firstBlockPos(view)

    enterSourceMode(view, pos)

    const dom = view.nodeDOM(pos) as HTMLElement
    const cmEditor = dom.querySelector('.cm-editor') as HTMLElement
    expect(cmEditor).toBeTruthy()

    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('Original text')
    view.destroy()
  })

  it('escape key exits source mode', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    expect(sourcePos(view)).toBe(pos)

    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    cmContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(sourcePos(view)).toBeNull()
    view.destroy()
  })
})

describe('source mode serialization', () => {
  it('code block shows fence and language in source mode', () => {
    const view = createEditor('```js\nconst x = 1;\n```')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('```js')
    expect(cmContent.textContent).toContain('const x = 1;')
    view.destroy()
  })

  it('code block round-trips through source mode', () => {
    const view = createEditor('```js\nconst x = 1;\n```')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('```js')
    expect(md).toContain('const x = 1;')
    view.destroy()
  })

  it('mermaid block shows content in source mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('graph TD')
    expect(cmContent.textContent).toContain('A-->B')
    view.destroy()
  })

  it('mermaid block round-trips through source mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('graph TD')
    expect(md).toContain('A-->B')
    view.destroy()
  })

  it('table shows pipe-formatted markdown in source mode', () => {
    const view = createEditor('| H1 | H2 |\n| --- | --- |\n| A | B |')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('| H1 | H2 |')
    expect(cmContent.textContent).toContain('| A | B |')
    view.destroy()
  })

  it('table round-trips through source mode', () => {
    const view = createEditor('| H1 | H2 |\n| --- | --- |\n| A | B |')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('| H1 | H2 |')
    expect(md).toContain('| A | B |')
    view.destroy()
  })
})

describe('table source mode', () => {
  it('serialized table includes separator row', () => {
    const view = createEditor('| H1 | H2 |\n| --- | --- |\n| A | B |')
    const pos = firstBlockPos(view)
    const node = blockNodeAt(view, pos)
    const md = serializeBlock(node!)
    expect(md).toContain('| --- | --- |')
    view.destroy()
  })

  it('table round-trips preserving structure', () => {
    const view = createEditor('| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('| Name | Age |')
    expect(md).toContain('| Alice | 30 |')
    expect(md).toContain('| Bob | 25 |')
    const node = blockNodeAt(view, pos)
    expect(node!.type.name).toBe('table')
    view.destroy()
  })
})

describe('task list support', () => {
  it('parses unchecked task list items', () => {
    const view = createEditor('- [ ] Buy groceries\n- [ ] Clean house')
    const pos = firstBlockPos(view)
    const node = blockNodeAt(view, pos)
    expect(node!.type.name).toBe('bullet_list')
    const firstItem = node!.child(0)
    expect(firstItem.type.name).toBe('list_item')
    expect(firstItem.attrs.checked).toBe(false)
    view.destroy()
  })

  it('parses checked task list items', () => {
    const view = createEditor('- [x] Done task\n- [ ] Pending task')
    const pos = firstBlockPos(view)
    const node = blockNodeAt(view, pos)
    const firstItem = node!.child(0)
    expect(firstItem.attrs.checked).toBe(true)
    const secondItem = node!.child(1)
    expect(secondItem.attrs.checked).toBe(false)
    view.destroy()
  })

  it('serializes task list items with checkbox syntax', () => {
    const view = createEditor('- [ ] Buy milk\n- [x] Walk dog')
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('- [ ] Buy milk')
    expect(md).toContain('- [x] Walk dog')
    view.destroy()
  })

  it('task list round-trips through source mode', () => {
    const view = createEditor('- [ ] Todo item\n- [x] Done item')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('- [ ] Todo item')
    expect(md).toContain('- [x] Done item')
    view.destroy()
  })

  it('nested ordered list round-trips through source mode', () => {
    const md = '1. First\n   1. Sub A\n   2. Sub B\n2. Second'
    const view = createEditor(md)
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const restored = proseToMarkdown(view.state.doc)
    expect(restored).toContain('1. First')
    expect(restored).toContain('1. Sub A')
    expect(restored).toContain('2. Sub B')
    expect(restored).toContain('2. Second')
    const nestedList = view.state.doc.child(0).child(0).lastChild
    expect(nestedList!.type.name).toBe('ordered_list')
    view.destroy()
  })

  it('nested bullet list round-trips through source mode', () => {
    const md = '- First\n  - Sub A\n  - Sub B\n- Second'
    const view = createEditor(md)
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const restored = proseToMarkdown(view.state.doc)
    expect(restored).toContain('- First')
    expect(restored).toContain('- Sub A')
    expect(restored).toContain('- Sub B')
    expect(restored).toContain('- Second')
    const nestedList = view.state.doc.child(0).child(0).lastChild
    expect(nestedList!.type.name).toBe('bullet_list')
    view.destroy()
  })

  it('renders checkbox attribute in DOM', () => {
    const view = createEditor('- [ ] Unchecked\n- [x] Checked')
    const pos = firstBlockPos(view)
    const node = blockNodeAt(view, pos)
    const firstLi = node!.child(0)
    expect(firstLi.attrs.checked).toBe(false)
    const secondLi = node!.child(1)
    expect(secondLi.attrs.checked).toBe(true)
    view.destroy()
  })
})

describe('no duplicate handles', () => {
  it('bulleted list with items shows only one handle', () => {
    const view = createEditor('- Item 1\n- Item 2\n- Item 3')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(1)
    view.destroy()
  })

  it('nested blockquote shows only one handle', () => {
    const view = createEditor('> Quoted text\n> More quoted')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(1)
    view.destroy()
  })

  it('table shows only one handle', () => {
    const view = createEditor('| A | B |\n| --- | --- |\n| 1 | 2 |')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(1)
    view.destroy()
  })

  it('multiple top-level blocks each get a handle', () => {
    const view = createEditor('First\n\nSecond\n\nThird')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(3)
    view.destroy()
  })
})

describe('mermaid block handles', () => {
  it('mermaid block has a handle in visual mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(1)
    const handle = handles[0] as HTMLElement
    expect(handle.getAttribute('data-block-pos')).toBeTruthy()
    view.destroy()
  })

  it('clicking mermaid handle enters source mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    expect(sourcePos(view)).toBeNull()

    const handle = view.dom.querySelector('.block-handle') as HTMLElement
    expect(handle).toBeTruthy()
    const handlePos = Number(handle.getAttribute('data-block-pos'))
    expect(handlePos).toBe(pos)

    toggleSourceMode(view, handlePos)
    expect(sourcePos(view)).toBe(pos)
    view.destroy()
  })

  it('mermaid source mode shows code in CodeMirror', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    const dom = view.nodeDOM(pos) as HTMLElement
    expect(dom.classList.contains('block-source-mode')).toBe(true)
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('graph TD')
    expect(cmContent.textContent).toContain('A-->B')
    view.destroy()
  })

  it('mermaid round-trips through source mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    enterSourceMode(view, pos)
    exitSourceMode(view)
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('graph TD')
    expect(md).toContain('A-->B')
    view.destroy()
  })
})

describe('mermaid visual mode rendering', () => {
  // Edit mode only offers a label the source can be patched with, so the mock
  // draws a node for every `A[Alpha]` in the source it is handed rather than a
  // fixed one: a diagram whose labels the source never spells out is
  // deliberately left with nothing to edit.
  function flowchartSvg(code: string): string {
    const labels = [...code.matchAll(/\w+\[([^\]]+)\]/g)].map((match) => match[1])
    const nodes = labels
      .map(
        (label) =>
          `<g class="node"><g class="label"><foreignObject width="60" height="20">` +
          `<div class="labelBkg"><span class="nodeLabel"><p>${label}</p></span></div>` +
          `</foreignObject></g></g>`,
      )
      .join('')
    return `<svg viewBox="0 0 900 300">${nodes}</svg>`
  }

  function mockFlowchart(): void {
    vi.mocked(mermaidModule.default.render).mockImplementation(async (_id, code) => ({
      svg: flowchartSvg(code),
      diagramType: 'flowchart',
    }))
  }

  // A kanban board, drawn the way mermaid draws one: one section per column and
  // the cards inside `.items`, in source order, so the model and the DOM agree
  // the way the layer requires before it offers a ＋ or arms a drag. An empty
  // column still gets its section — a shorter band, which is what makes a
  // per-column ＋ possible at all.
  function kanbanSvg(code: string): string {
    const rows = code
      .split('\n')
      .slice(1)
      .map((raw) => ({ indent: /^[ \t]*/.exec(raw)?.[0].length ?? 0, text: raw.trim() }))
      .filter((row) => row.text && !row.text.startsWith('%%'))
    const level = Math.min(...rows.map((row) => row.indent))
    const label = (text: string): string => /\[([^\]]*)\]/.exec(text)?.[1] ?? text
    const section = (name: string): string =>
      `<g class="cluster section-x"><rect /><g class="cluster-label"><foreignObject width="60" height="20">` +
      `<div class="labelBkg"><span class="nodeLabel"><p>${name}</p></span></div></foreignObject></g></g>`
    const card = (name: string): string =>
      `<g class="node"><g class="label"><foreignObject width="60" height="20">` +
      `<div class="labelBkg"><span class="nodeLabel"><p>${name}</p></span></div></foreignObject></g></g>`
    const columns = rows.filter((row) => row.indent === level)
    const cards = rows.filter((row) => row.indent > level)
    return (
      `<svg viewBox="0 0 900 300"><g class="sections">` +
      columns.map((row) => section(label(row.text))).join('') +
      `</g><g class="items">` +
      cards.map((row) => card(label(row.text))).join('') +
      `</g></svg>`
    )
  }

  function mockKanban(): void {
    vi.mocked(mermaidModule.default.render).mockImplementation(async (_id, code) => ({
      svg: kanbanSvg(code),
      diagramType: 'kanban',
    }))
  }

  function editToggle(view: EditorView): HTMLButtonElement {
    const button = view.dom.querySelector<HTMLButtonElement>('.mermaid-edit-toggle')
    expect(button).not.toBeNull()
    return button!
  }

  function editModeOf(view: EditorView): boolean {
    return view.state.doc.firstChild!.attrs._edit === true
  }

  /** Mermaid renders asynchronously; wait for the render to land, not a tick. */
  async function rendered(view: EditorView, selector: string, present = true): Promise<boolean> {
    for (let i = 0; i < 25; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (view.dom.querySelector(selector) !== null === present) return true
    }
    return false
  }

  beforeEach(() => {
    vi.mocked(mermaidModule.default.render).mockReset()
    vi.mocked(mermaidModule.default.render).mockResolvedValue({
      svg: '<svg viewBox="0 0 900 300"><rect width="900" height="300"></rect></svg>',
      diagramType: 'flowchart-elk',
    })
  })

  it('renders the diagram at natural size and attaches the zoom toolbar', async () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const block = view.dom.querySelector<HTMLElement>('.mermaid')
    expect(block).not.toBeNull()

    const svg = block!.querySelector<SVGSVGElement>('.mermaid-preview svg')
    expect(svg).not.toBeNull()
    expect(svg!.style.width).toBe('900px')
    expect(svg!.style.maxWidth).toBe('none')

    const bar = block!.querySelector<HTMLElement>('.mermaid-toolbar')
    expect(bar).not.toBeNull()

    const zoomIn = Array.from(bar!.querySelectorAll('button')).find((b) => b.textContent === '+')
    zoomIn!.click()
    expect(svg!.style.width).toBe('1125px')

    view.destroy()
  })

  it('renders an error block when the diagram fails to render', async () => {
    vi.mocked(mermaidModule.default.render).mockRejectedValue(new Error('syntax error near line 1'))
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const error = view.dom.querySelector<HTMLElement>('.mermaid-error')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('syntax error near line 1')

    view.destroy()
  })

  it('a visual label edit becomes one transaction and re-renders in place', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const preview = view.dom.querySelector<HTMLElement>('.mermaid-preview')!
    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-editables')).toBe(true)

    const label = preview.querySelector('.mermaid-editables')!
    label.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))

    const input = view.dom.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    expect(input).not.toBeNull()
    expect(input.value).toBe('Alpha')

    input.value = 'Beta'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await rendered(view, '.mermaid-edit-input')

    expect(proseToMarkdown(view.state.doc)).toContain('A[Beta]')
    expect(view.dom.querySelector('.mermaid-edit-input')).toBeNull()
    // Same preview element, so the diagram was updated rather than rebuilt...
    expect(view.dom.querySelector('.mermaid-preview')).toBe(preview)
    // ...and it really did re-render: the source and the picture agree again.
    expect(vi.mocked(mermaidModule.default.render).mock.calls.at(-1)?.[1]).toBe('graph TD\n  A[Beta]')

    view.destroy()
  })

  it('keeps the label editor out of ProseMirror while it is open', async () => {
    mockFlowchart()
    // A plugin prop is only reached when no node view stops the event, so it
    // records exactly which events ProseMirror handled.
    const seen: string[] = []
    const probe = new Plugin({
      props: {
        handleDOMEvents: {
          keydown: (_state, event) => {
            seen.push(`keydown:${(event.target as Element).className}`)
            return false
          },
        },
      },
    })
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```', [probe])

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()
    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-editables')).toBe(true)

    const label = view.dom.querySelector<HTMLElement>('.mermaid-editables')!
    label.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    const input = view.dom.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(seen).toEqual([])

    input.remove()
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(seen).toEqual(['keydown:nodeLabel mermaid-editables'])

    view.destroy()
  })

  it('keeps the last good diagram and explains itself when a re-render fails', async () => {
    vi.mocked(mermaidModule.default.render).mockResolvedValue({
      svg: '<svg viewBox="0 0 900 300"><rect width="900" height="300"></rect></svg>',
      diagramType: 'flowchart',
    })
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()
    const preview = view.dom.querySelector<HTMLElement>('.mermaid-preview')!
    expect(preview.querySelector('svg')).not.toBeNull()

    vi.mocked(mermaidModule.default.render).mockRejectedValue(new Error('Parse error on line 1'))
    view.dispatch(
      view.state.tr.setNodeMarkup(firstBlockPos(view), undefined, {
        value: 'graph TD\n  A[',
        _source: false,
      }),
    )
    await flush()
    await flush()

    expect(view.dom.querySelector('.mermaid-preview')).toBe(preview)
    expect(preview.querySelector('svg')).not.toBeNull()
    expect(view.dom.querySelector('.mermaid-error')).toBeNull()
    const notice = view.dom.querySelector<HTMLElement>('.mermaid-edit-notice')!
    expect(notice).not.toBeNull()
    expect(notice.title).toContain('Parse error on line 1')

    view.destroy()
  })

  it('previews read-only until edit mode is asked for', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const block = view.dom.querySelector<HTMLElement>('.mermaid')!
    expect(editModeOf(view)).toBe(false)
    expect(block.classList.contains('mermaid-editing')).toBe(false)
    expect(view.dom.querySelectorAll('.mermaid-editables')).toHaveLength(0)
    expect(editToggle(view).textContent).toBe('Edit')

    view.destroy()
  })

  it('toggles edit mode from the hover toolbar', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    editToggle(view).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(true)
    expect(await rendered(view, '.mermaid-editables')).toBe(true)
    expect(view.dom.querySelector('.mermaid')!.classList.contains('mermaid-editing')).toBe(true)
    expect(editToggle(view).textContent).toBe('Done')
    expect(editToggle(view).classList.contains('mermaid-edit-toggle-on')).toBe(true)
    // The source round-trips through the doc, attrs do not leak into markdown.
    expect(proseToMarkdown(view.state.doc)).toBe('```mermaid\ngraph TD\n  A[Alpha]\n```\n')

    editToggle(view).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    expect(await rendered(view, '.mermaid-editables', false)).toBe(true)
    expect(editToggle(view).textContent).toBe('Edit')
    expect(view.dom.querySelector('.mermaid')!.classList.contains('mermaid-editing')).toBe(false)

    view.destroy()
  })

  it('toggles edit mode on double click, ignoring clicks on the toolbar', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const preview = view.dom.querySelector<HTMLElement>('.mermaid-preview')!
    preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(true)
    expect(await rendered(view, '.mermaid-editables')).toBe(true)

    preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    expect(await rendered(view, '.mermaid-editables', false)).toBe(true)

    // A double click on a toolbar button is a click on a button, not a
    // request to leave the toolbar behind.
    editToggle(view).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    editToggle(view).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(true)
    editToggle(view).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(true)

    view.destroy()
  })

  it('finishes a label edit in progress when Done is clicked', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const preview = view.dom.querySelector<HTMLElement>('.mermaid-preview')!
    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-editables')).toBe(true)

    preview.querySelector('.mermaid-editables')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0 }),
    )
    const input = view.dom.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    input.value = 'Beta'

    // Done's own mousedown keeps the input focused, so the edit cannot be left
    // to the input's blur: the toggle has to resolve it. Clicking away from a
    // field commits, and so does finishing the diagram.
    const toggle = editToggle(view)
    toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))

    expect(editModeOf(view)).toBe(false)
    expect(proseToMarkdown(view.state.doc)).toContain('A[Beta]')
    expect(view.dom.querySelector('.mermaid-edit-input')).toBeNull()
    // The input is a child of the block, not of the container a render
    // replaces, so it must be gone for good — not resurrected by the re-render
    // the committed value triggers.
    expect(await rendered(view, '.mermaid-edit-input', false)).toBe(true)
    expect(view.dom.querySelector('.mermaid-edit-input')).toBeNull()
    expect(await rendered(view, '.mermaid-editables', false)).toBe(true)
    expect(editToggle(view).textContent).toBe('Edit')

    view.destroy()
  })

  it('finishes a label edit in progress when another diagram takes edit mode', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\n```mermaid\ngraph TD\n  B[Beta]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    enterDiagramEditMode(view, allBlockPositions(view)[0]!)
    expect(await rendered(view, '.mermaid-editables')).toBe(true)
    view.dom
      .querySelectorAll('.mermaid-preview')[0]!
      .querySelector('.mermaid-editables')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    const input = view.dom.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    input.value = 'Gamma'

    enterDiagramEditMode(view, allBlockPositions(view)[1]!)

    // Edit mode is one diagram at a time, so the first one is finished by
    // handing over — its pending label is not left on screen.
    expect(proseToMarkdown(view.state.doc)).toContain('A[Gamma]')
    expect(view.dom.querySelector('.mermaid-edit-input')).toBeNull()
    expect(view.state.doc.child(1)!.attrs._edit).toBe(true)

    view.destroy()
  })

  it('leaves edit mode on a double click outside the diagram', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\nAfter the diagram')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    // Edit mode is a mode of one diagram; the gesture that ends it should not
    // have to land back on that diagram.
    // The paragraph after the diagram. The diagram's own labels are `<p>`
    // elements too, and a double click on one of those is a request about the
    // diagram, so pick the one that is not inside a `.mermaid` block.
    const paragraph = Array.from(view.dom.querySelectorAll<HTMLElement>('p')).find(
      (el) => el.textContent === 'After the diagram' && el.closest('.mermaid') === null,
    )!
    paragraph.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)

    enterDiagramEditMode(view, firstBlockPos(view))
    expect(editModeOf(view)).toBe(true)
    expect(await rendered(view, '.mermaid-editables')).toBe(true)

    paragraph.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    expect(await rendered(view, '.mermaid-editables', false)).toBe(true)

    // ...but the click is not swallowed, so it still does what it was aimed at.
    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-editables')).toBe(true)
    const editor = view.dom.querySelector<HTMLElement>('.mermaid-editing')!
    editor.querySelector('.mermaid-editables')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0 }),
    )
    const input = view.dom.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    // A double click in the input belongs to the input, not to edit mode.
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(true)

    view.destroy()
  })

  it('leaves edit mode on a double click in the editor space below the document', async () => {
    mockFlowchart()
    // A document of one diagram only, so the editor's own box ends just under
    // it and everything below is the *scroller's* white space -- the area a
    // double click lands on when it is aimed at the page under the board.
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    const space = view.dom.parentElement!
    expect(space.contains(view.dom)).toBe(true)

    space.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    // Nothing is in edit mode, so the gesture is not ours to answer.
    expect(editModeOf(view)).toBe(false)

    enterDiagramEditMode(view, firstBlockPos(view))
    expect(editModeOf(view)).toBe(true)
    expect(await rendered(view, '.mermaid-editables')).toBe(true)

    // The gesture that turns the mode off should not have to land back on the
    // diagram, and the page below it is not even part of the editor's own box.
    space.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    expect(await rendered(view, '.mermaid-editables', false)).toBe(true)

    view.destroy()
  })

  it('ignores a double click outside when no diagram is in edit mode', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\nAfter the diagram')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    // The paragraph after the diagram. The diagram's own labels are `<p>`
    // elements too, and a double click on one of those is a request about the
    // diagram, so pick the one that is not inside a `.mermaid` block.
    const paragraph = Array.from(view.dom.querySelectorAll<HTMLElement>('p')).find(
      (el) => el.textContent === 'After the diagram' && el.closest('.mermaid') === null,
    )!
    paragraph.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))

    expect(editModeOf(view)).toBe(false)
    expect(view.dom.querySelector('.mermaid-editables')).toBeNull()

    view.destroy()
  })

  it('syncs the mode class when a transaction changes the source and the mode', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    // Source and mode land in the same step, as an undo of a failed edit can.
    const pos = firstBlockPos(view)
    const tr = view.state.tr.setNodeMarkup(pos, undefined, {
      ...view.state.doc.nodeAt(pos)!.attrs,
      value: 'graph TD\n  A[Gamma]\n  B[Beta]\n  A --> B',
    })
    setBlockModeAt(tr, pos, { interaction: 'editing' })
    view.dispatch(tr)
    expect(await rendered(view, '.mermaid-editing')).toBe(true)
    expect(view.dom.querySelectorAll('.mermaid-editables').length).toBeGreaterThan(0)
    expect(vi.mocked(mermaidModule.default.render).mock.calls.at(-1)?.[1]).toBe(
      'graph TD\n  A[Gamma]\n  B[Beta]\n  A --> B',
    )

    view.destroy()
  })

  it('keeps edit mode to one diagram at a time', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\n```mermaid\ngraph TD\n  B[Beta]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    enterDiagramEditMode(view, allBlockPositions(view)[1])
    expect(await rendered(view, '.mermaid-editables')).toBe(true)
    expect(view.state.doc.firstChild!.attrs._edit).not.toBe(true)
    expect(view.state.doc.child(1).attrs._edit).toBe(true)

    exitDiagramEditMode(view, allBlockPositions(view)[1])
    expect(view.state.doc.child(1).attrs._edit).not.toBe(true)
    expect(await rendered(view, '.mermaid-editing', false)).toBe(true)

    view.destroy()
  })

  it('leaves a selected block behind when edit mode starts', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\nAfter the diagram')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    // Selecting the block is how the user got to the Edit button in the first
    // place. A selection left in place would let the next keystroke replace the
    // whole diagram with typed text.
    const pos = firstBlockPos(view)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    enterDiagramEditMode(view, pos)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.empty).toBe(true)
    // The caret ends up on real text, so the deselect never builds a text
    // selection on a position that is not one (the document end used to warn
    // about exactly that, once per session).
    expect(view.state.selection.$from.parent.inlineContent).toBe(true)
    expect(view.state.selection.$from.parent).toBe(view.state.doc.lastChild)
    expect(warn).not.toHaveBeenCalled()

    warn.mockRestore()
    view.destroy()
  })

  // A board with an empty middle column: mermaid still draws that column, as a
  // shorter band, so it is drawn with a card slot of its own.
  const KANBAN_BOARD = ['kanban', '  Todo', '    id1[One]', '  Doing', '  Done', '    id2[Two]'].join('\n')

  /** The drawn slots, in board order: one per column, then the new column. */
  function drawnSlots(view: EditorView): SVGElement[] {
    return Array.from(view.dom.querySelectorAll<SVGElement>('.mermaid-kanban-slot, .mermaid-kanban-column-slot'))
  }

  function cardSlots(view: EditorView): SVGElement[] {
    return Array.from(view.dom.querySelectorAll<SVGElement>('.mermaid-kanban-slot'))
  }

  it('adds a card to the column whose slot was pressed, in one transaction', async () => {
    mockKanban()
    let transactions = 0
    const counted = new Plugin({
      appendTransaction: (trs) => {
        transactions += trs.length
        return null
      },
    })
    const view = createEditor('```mermaid\n' + KANBAN_BOARD + '\n```', [history(), counted])

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-kanban-slot')).toBe(true)
    // One card slot per column, and the column the board would have next — with a
    // card slot of its own, which is the bin a card is dropped on to be deleted.
    // The places to add are drawn rather than waited for.
    expect(cardSlots(view)).toHaveLength(4)
    expect(drawnSlots(view)).toHaveLength(5)

    cardSlots(view)[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    const input = view.dom.querySelector<HTMLTextAreaElement>('.mermaid-edit-input')!
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Card title')

    transactions = 0
    input.value = 'Fresh'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const patched = [
      'kanban',
      '  Todo',
      '    id1[One]',
      '  Doing',
      '    [Fresh]',
      '  Done',
      '    id2[Two]',
    ].join('\n')
    expect(proseToMarkdown(view.state.doc)).toBe('```mermaid\n' + patched + '\n```\n')
    expect(view.dom.querySelector('.mermaid-edit-input')).toBeNull()
    // One transaction for the whole insert, so undo takes it back in one step.
    expect(transactions).toBe(1)
    await flush()
    await flush()
    // The board is *drawn* with somewhere to add: the rendered source is the
    // patched board plus its slots, which is why the document above is not it.
    expect(vi.mocked(mermaidModule.default.render).mock.calls.at(-1)?.[1]).toBe(
      [
        'kanban',
        '  Todo',
        '    id1[One]',
        '    slotc0[+ Add a card]',
        '  Doing',
        '    [Fresh]',
        '    slotc1[+ Add a card]',
        '  Done',
        '    id2[Two]',
        '    slotc2[+ Add a card]',
        '  slotn[+ Add a column]',
        '    slotc3[+ Add a card]',
      ].join('\n'),
    )
    // The render replaced the SVG, and with it the slots, which are re-drawn from
    // the board that was just committed — a slot per column, still.
    expect(cardSlots(view)).toHaveLength(4)

    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toBe('```mermaid\n' + KANBAN_BOARD + '\n```\n')

    view.destroy()
  })

  it('leaves the board alone when a new card is abandoned', async () => {
    mockKanban()
    const view = createEditor('```mermaid\n' + KANBAN_BOARD + '\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-kanban-slot')).toBe(true)

    cardSlots(view)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    const input = view.dom.querySelector<HTMLTextAreaElement>('.mermaid-edit-input')!
    input.value = 'Discarded'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(await rendered(view, '.mermaid-edit-input, .mermaid [contenteditable="true"]', false)).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toBe('```mermaid\n' + KANBAN_BOARD + '\n```\n')
    expect(cardSlots(view)).toHaveLength(4)

    view.destroy()
  })

  it('takes the slots away with the editing layer, and draws them again after', async () => {
    mockKanban()
    const view = createEditor('```mermaid\n' + KANBAN_BOARD + '\n```\n\nAfter the board')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-kanban-slot')).toBe(true)
    expect(cardSlots(view)).toHaveLength(4)

    editToggle(view).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    // They are part of the editing layer, so Done removes them like it removes
    // the labels: the document's own source has no slots in it.
    expect(await rendered(view, '.mermaid-kanban-slot', false)).toBe(true)
    expect(await rendered(view, '.mermaid-editables', false)).toBe(true)

    // ...and so does a double click outside the diagram, which ends the mode
    // from a gesture that never lands on it.
    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-kanban-slot')).toBe(true)
    const paragraph = Array.from(view.dom.querySelectorAll<HTMLElement>('p')).find(
      (el) => el.textContent === 'After the board' && el.closest('.mermaid') === null,
    )!
    paragraph.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    expect(editModeOf(view)).toBe(false)
    expect(await rendered(view, '.mermaid-kanban-slot', false)).toBe(true)

    view.destroy()
  })

  it('draws no slots on a diagram that is not a board', async () => {
    mockFlowchart()
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    await flush()

    enterDiagramEditMode(view, firstBlockPos(view))
    expect(await rendered(view, '.mermaid-editables')).toBe(true)
    expect(drawnSlots(view)).toHaveLength(0)

    view.destroy()
  })
})

describe('handle position accuracy', () => {
  it('each handle maps to the correct block in multi-block doc', () => {
    const view = createEditor('# Hello\n\nWorld\n\n```python\nx = 1\n```')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(3)

    const positions = allBlockPositions(view)
    expect(positions.length).toBe(3)

    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i] as HTMLElement
      const handlePos = Number(handle.getAttribute('data-block-pos'))
      const block = blockNodeAt(view, handlePos)
      const expectedBlock = blockNodeAt(view, positions[i])
      expect(block).toBe(expectedBlock)
    }
    view.destroy()
  })

  it('toggling source on first block does not affect second block', () => {
    const view = createEditor('First block\n\nSecond block')
    const positions = allBlockPositions(view)
    expect(positions.length).toBe(2)

    toggleSourceMode(view, positions[0])
    expect(sourcePos(view)).toBe(positions[0])

    const block0 = blockNodeAt(view, positions[0])
    const block1 = blockNodeAt(view, positions[1])
    expect(block0!.attrs._source).toBe(true)
    expect(block1!.attrs._source).toBe(false)
    view.destroy()
  })

  it('code block handle toggles code block not adjacent task list', () => {
    const md = '## Tasks\n\n- [x] Fast editing\n- [x] Spreadsheet tables\n\n```python\nprint("Hello")\n```\n\nMore text'
    const view = createEditor(md)
    const positions = allBlockPositions(view)
    const nodeTypes = positions.map(p => blockNodeAt(view, p)!.type.name)

    const codeBlockIndex = nodeTypes.indexOf('code_block')
    expect(codeBlockIndex).toBeGreaterThanOrEqual(0)
    const codeBlockPos = positions[codeBlockIndex]

    const handles = Array.from(view.dom.querySelectorAll('.block-handle')) as HTMLElement[]
    const codeHandle = handles.find(h => Number(h.getAttribute('data-block-pos')) === codeBlockPos)
    expect(codeHandle).toBeTruthy()

    const handlePos = Number(codeHandle!.getAttribute('data-block-pos'))
    expect(handlePos).toBe(codeBlockPos)

    toggleSourceMode(view, handlePos)
    expect(sourcePos(view)).toBe(codeBlockPos)

    const toggledBlock = blockNodeAt(view, codeBlockPos)
    expect(toggledBlock!.type.name).toBe('code_block')

    for (const p of positions) {
      if (p !== codeBlockPos) {
        expect(blockNodeAt(view, p)!.attrs._source).toBe(false)
      }
    }
    view.destroy()
  })

  it('handle positions remain valid after entering source mode', () => {
    const view = createEditor('# Hello\n\nWorld\n\n```python\nx = 1\n```')
    const positions = allBlockPositions(view)
    const handles = Array.from(view.dom.querySelectorAll('.block-handle')) as HTMLElement[]
    const prePositions = handles.map(h => Number(h.getAttribute('data-block-pos')))

    toggleSourceMode(view, positions[1])

    const postHandles = Array.from(view.dom.querySelectorAll('.block-handle')) as HTMLElement[]
    const postPositions = postHandles.map(h => Number(h.getAttribute('data-block-pos')))

    for (const pp of postPositions) {
      expect(prePositions).toContain(pp)
    }
    view.destroy()
  })
})

describe('runnable code block toggle', () => {
  it('a shebang code block stays a code_block and gets a handle', () => {
    const view = createEditor('```\n#!/usr/bin/env python3\nprint("hello")\n```')
    const handles = view.dom.querySelectorAll('.block-handle')
    expect(handles.length).toBe(1)
    const handle = handles[0] as HTMLElement
    const pos = Number(handle.getAttribute('data-block-pos'))
    const block = blockNodeAt(view, pos)
    expect(block!.type.name).toBe('code_block')
    expect(block!.textContent.startsWith('#!/usr/bin/env python3')).toBe(true)
    view.destroy()
  })

  it('shows a Run button for a code block whose first line is a shebang', () => {
    const view = createEditor('```\n#!/usr/bin/env python3\nprint("hello")\n```')
    expect(view.dom.querySelector('.exec-run')).toBeTruthy()
    view.destroy()
  })

  it('does not show a Run button for a plain code block', () => {
    const view = createEditor('```js\nconsole.log(1)\n```')
    expect(view.dom.querySelector('.exec-run')).toBeNull()
    view.destroy()
  })

  it('toggling source mode for a shebang block enters source mode for it not other blocks', () => {
    const md = 'Some text\n\n```\n#!/usr/bin/env python3\nprint("hello")\n```\n\n- [x] task'
    const view = createEditor(md)
    const positions = allBlockPositions(view)

    const runPos = positions.find(p => blockNodeAt(view, p)!.type.name === 'code_block' && blockNodeAt(view, p)!.textContent.startsWith('#!'))
    expect(runPos).toBeDefined()

    const handle = Array.from(view.dom.querySelectorAll('.block-handle')).find(
      h => Number((h as HTMLElement).getAttribute('data-block-pos')) === runPos
    ) as HTMLElement
    expect(handle).toBeTruthy()

    const handlePos = Number(handle.getAttribute('data-block-pos'))
    expect(handlePos).toBe(runPos)

    toggleSourceMode(view, handlePos)
    expect(sourcePos(view)).toBe(runPos)

    for (const p of positions) {
      const block = blockNodeAt(view, p)
      if (p === runPos) {
        expect(block!.attrs._source).toBe(true)
      } else {
        expect(block!.attrs._source).toBe(false)
      }
    }
    view.destroy()
  })

  it('shows a Run button after typing a shebang into a code block first line', () => {
    const view = createEditor('```\nprint("hello")\n```')
    expect(view.dom.querySelector('.exec-run')).toBeNull()

    // Simulate adding a shebang as the first line of the code block.
    const pos = firstBlockPos(view)
    const tr = view.state.tr.insertText('#!/usr/bin/env python3\n', pos + 1)
    view.dispatch(tr)

    expect(view.dom.querySelector('.exec-run')).toBeTruthy()
    view.destroy()
  })
})

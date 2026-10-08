import { describe, expect, it, beforeEach, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { EditorView as CMEditorView } from '@codemirror/view'
import { markdownToProse, proseToMarkdown } from './markdown'
import { schema } from './schema'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { mermaidNodeViewPlugin } from './node/mermaid'
import { tableNodeViewPlugin } from './node/table'
import {
  BLOCK_MODE_KEY,
  blockModeFor,
  blockModePlugin,
  currentBlockMode,
  enterSourceMode,
  modeFor,
  toggleSourceMode,
} from './block-modes'
import { Plugin } from 'prosemirror-state'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg viewBox="0 0 900 300"></svg>',
      diagramType: 'base',
    }),
  },
}))

function createEditor(initialMarkdown: string): EditorView {
  const doc = markdownToProse(initialMarkdown, schema)
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
      plugins: [blockModePlugin, codeBlockNodeViewPlugin, nodeViewPlugin, mermaidNodeViewPlugin, tableNodeViewPlugin],
    }),
  })
}

function allBlockPositions(view: EditorView): number[] {
  const positions: number[] = []
  view.state.doc.forEach((_node, offset) => {
    positions.push(offset)
  })
  return positions
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.matchMedia = ((_query: string) => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

describe('the outgoing block commits before the record moves', () => {
  // The regression this ordering rule exists for. A block's source lives in a
  // CodeMirror buffer, not in the document, so a path that moves the record
  // without reading that buffer throws the edit away. Before the record existed
  // this was reachable from the block handle and from the context menu's "Edit
  // source" — neither of which committed first — and no test caught it, because
  // every test toggled a buffer nobody had typed into.
  it('keeps what was typed in the block it moves off', () => {
    const view = createEditor('# First heading\n\nSecond paragraph')
    const [first, second] = allBlockPositions(view)
    expect(second).toBe(15)

    enterSourceMode(view, first)
    const cmEl = (view.nodeDOM(first) as HTMLElement).querySelector<HTMLElement>('.cm-editor')!
    const cm = CMEditorView.findFromDOM(cmEl)!
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: '# Renamed by the test\n' } })
    expect(cm.state.doc.toString()).toBe('# Renamed by the test\n')

    toggleSourceMode(view, second)

    expect(proseToMarkdown(view.state.doc)).toContain('# Renamed by the test')
    // The record names the block that was asked for — at its position *after*
    // the commit, not the one it had before. The reparse grew the heading by six
    // characters, so keeping the old position would have put the mode on
    // whatever moved into it. Compared by identity rather than by number,
    // because the number is the thing that moved.
    const after = allBlockPositions(view)
    expect(view.state.doc.nodeAt(currentBlockMode(view.state)!.pos)!.type.name).toBe('paragraph')
    expect(view.state.doc.nodeAt(after[0])!.type.name).toBe('heading')
    expect(view.state.doc.nodeAt(after[0])!.attrs._source).toBe(false)
    expect(view.state.doc.nodeAt(after[1])!.attrs._source).toBe(true)
    view.destroy()
  })

  it('leaves nothing open behind when the outgoing block was the only one', () => {
    const view = createEditor('# First heading\n\nSecond paragraph')
    const [first, second] = allBlockPositions(view)
    enterSourceMode(view, first)
    toggleSourceMode(view, second)
    expect(view.dom.querySelectorAll('.block-source-mode').length).toBe(1)
    view.destroy()
  })
})

describe('blockModeFor', () => {
  it('offers the source form for every top-level block but a source_block', () => {
    const view = createEditor('# Heading\n\nPara\n\n- item\n\n```py\nx=1\n```\n\n| A |\n| --- |\n| 1 |\n')
    const kinds: string[] = []
    view.state.doc.forEach((node) => {
      kinds.push(node.type.name)
      const descriptor = blockModeFor(node)
      expect(descriptor.representation).toBe(true)
    })
    expect(kinds).toContain('heading')
    expect(kinds).toContain('bullet_list')
    expect(kinds).toContain('code_block')
    expect(kinds).toContain('table')
    view.destroy()
  })

  it('gives a source_block no source form to go back to', () => {
    // A source_block has no markdown syntax — it is built programmatically — so
    // it is the one block type that is *permanently* in its source form, and the
    // one that must never take the record.
    const node = schema.nodes.source_block.create({ markdown: '# hi\n' })
    expect(blockModeFor(node)).toEqual({ representation: false, interaction: 'none' })
    expect(schema.nodes.source_block.create({ markdown: 'x' }).attrs._source).toBeUndefined()
  })

  it('declares the interaction axis for mermaid only', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\n# Plain\n\n| A |\n| --- |\n| 1 |\n')
    const interactive: string[] = []
    const forms: string[] = []
    view.state.doc.forEach((node) => {
      const descriptor = blockModeFor(node)
      if (descriptor.interaction === 'toggle') interactive.push(node.type.name)
      for (const form of descriptor.forms ?? []) forms.push(`${node.type.name}:${form.id}`)
    })
    expect(interactive).toEqual(['mermaid_block'])
    // A table's text/sheet choice is a *form*, not one of the two axes.
    expect(forms).toEqual(['table:text', 'table:sheet'])
    view.destroy()
  })
})

describe('the record is mapped, not merely bounds-checked', () => {
  it('still names the same block after an edit above it', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const [first] = allBlockPositions(view)
    enterSourceMode(view, first)

    // A block inserted above shifts the one holding the record. The old
    // policy bounds-checked the stored position and nothing else, so it would
    // quietly come to mean the *new* block.
    view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.paragraph.create(null, view.state.schema.text('Inserted above'))))

    expect(currentBlockMode(view.state)!.pos).toBeGreaterThan(first)
    expect(modeFor(view.state, first)).toBeNull()
    expect(view.state.doc.nodeAt(currentBlockMode(view.state)!.pos)!.type.name).toBe('heading')
    view.destroy()
  })

  it('releases the record when the block it names is deleted', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const [first] = allBlockPositions(view)
    enterSourceMode(view, first)
    const node = view.state.doc.nodeAt(first)!
    view.dispatch(view.state.tr.delete(first, first + node.nodeSize))
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })
})

describe('one block at a time', () => {
  it('gives the record to the incoming block and takes it from the outgoing one', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const [first, second] = allBlockPositions(view)
    enterSourceMode(view, first)
    expect(view.state.doc.nodeAt(first)!.attrs._source).toBe(true)

    toggleSourceMode(view, second)
    expect(currentBlockMode(view.state)!.pos).toBe(second)
    expect(view.state.doc.nodeAt(second)!.attrs._source).toBe(true)
    // The block that lost the mode also loses the attr that mirrored it, in the
    // same transaction — so the two can never disagree.
    expect(view.state.doc.nodeAt(first)!.attrs._source).toBe(false)
    view.destroy()
  })

  it('carries both axes on one record', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\n# Heading\n')
    const [board, heading] = allBlockPositions(view)
    enterSourceMode(view, heading)
    expect(currentBlockMode(view.state)).toEqual({
      pos: heading,
      type: 'heading',
      representation: 'source',
      interaction: 'viewing',
    })
    view.destroy()
    expect(board).toBe(0)
  })
})

describe('the plugin key', () => {
  it('is the only registry: a mode set on the tr is what the record reads', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const [first] = allBlockPositions(view)
    const tr = view.state.tr.setMeta(BLOCK_MODE_KEY, {
      pos: first,
      type: 'heading',
      representation: 'preview' as const,
      interaction: 'editing' as const,
    })
    view.dispatch(tr)
    expect(currentBlockMode(view.state)!.interaction).toBe('editing')
    expect(proseToMarkdown(view.state.doc)).toBe('# First\n\nSecond paragraph\n')
    view.destroy()
  })
})
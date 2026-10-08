import { describe, expect, it, beforeEach, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { history, undo } from 'prosemirror-history'
import { EditorView } from 'prosemirror-view'
import { EditorView as CMEditorView } from '@codemirror/view'
import { markdownToProse, proseToMarkdown } from './markdown'
import { schema } from './schema'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { encryptedBlockNodeViewPlugin } from './node/encryptedblock'
import { enterDiagramEditMode, mermaidNodeViewPlugin } from './node/mermaid'
import { tableNodeViewPlugin } from './node/table'
import {
  BLOCK_CONTROLS_CLASS,
  BLOCK_MODE_CLASS,
  BLOCK_MODE_EDITING_CLASS,
  BLOCK_MODE_KEY,
  BLOCK_MODE_SOURCE_CLASS,
  BLOCK_MODE_VISUAL_CLASS,
  blockModeFor,
  blockModePlugin,
  currentBlockMode,
  enterBlockMode,
  enterSourceMode,
  exitBlockMode,
  modeFor,
  toggleBlockMode,
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

function createEditor(initialMarkdown: string, extraPlugins: Plugin[] = []): EditorView {
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
      plugins: [
        blockModePlugin,
        codeBlockNodeViewPlugin,
        nodeViewPlugin,
        mermaidNodeViewPlugin,
        tableNodeViewPlugin,
        encryptedBlockNodeViewPlugin,
        ...extraPlugins,
      ],
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
    expect(modeFor(view.state, after[0])).toBeNull()
    expect(modeFor(view.state, after[1])?.representation).toBe('source')
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
    // No node type carries a representation attr any more, so a block cannot
    // claim a mode by saying so about itself.
    expect(schema.nodes.source_block.create({ markdown: 'x' }).attrs._source).toBeUndefined()
    expect(schema.nodes.heading.create().attrs._source).toBeUndefined()
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
    expect(modeFor(view.state, first)?.representation).toBe('source')

    toggleSourceMode(view, second)
    // One record names one block, so the outgoing block is not merely un-marked:
    // it has no claim left on the mode at all.
    expect(currentBlockMode(view.state)!.pos).toBe(second)
    expect(modeFor(view.state, second)?.representation).toBe('source')
    expect(modeFor(view.state, first)).toBeNull()
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
      representation: 'visual' as const,
      interaction: 'editing' as const,
    })
    view.dispatch(tr)
    expect(currentBlockMode(view.state)!.interaction).toBe('editing')
    expect(proseToMarkdown(view.state.doc)).toBe('# First\n\nSecond paragraph\n')
    view.destroy()
  })
})
describe('the mode is not document content', () => {
  it('is not undoable: undo after entering leaves the block in source', () => {
    const view = createEditor('# Hello\n\nSecond paragraph', [history()])
    const [first] = allBlockPositions(view)
    const before = view.state.doc.toString()
    enterSourceMode(view, first)
    expect(modeFor(view.state, first)?.representation).toBe('source')
    expect(view.state.doc.toString()).toBe(before)

    // Nothing for history to undo, because a mode is not an edit to the file.
    expect(undo(view.state, view.dispatch)).toBe(false)
    // With the mode in an attr, an undo *could* revert `_source` while the
    // record still said otherwise — a block drawing visually and answering to a
    // mode whose CodeMirror instance was never there. Both live in the record
    // now, so there is nothing for history to get half-right.
    expect(modeFor(view.state, first)?.representation).toBe('source')
    expect(view.state.doc.toString()).toBe(before)
    view.destroy()
  })

  it('rebuilds the node view when the record changes, despite no doc change', () => {
    const view = createEditor('# Hello')
    const [first] = allBlockPositions(view)
    const dom = view.nodeDOM(first) as HTMLElement
    expect(dom.classList.contains('block-visual-mode')).toBe(true)

    enterSourceMode(view, first)

    // ProseMirror only walks the tree when the document or a node's decorations
    // changed, and a mode flip now changes neither — so the record publishes
    // itself as a decoration to make the walk happen. Without that, the block
    // would keep drawing as it was with nothing wrong to see.
    const after = view.nodeDOM(first) as HTMLElement
    expect(after).not.toBe(dom)
    expect(after.classList.contains('block-source-mode')).toBe(true)
    expect(after.classList.contains(BLOCK_MODE_CLASS)).toBe(true)
    view.destroy()
  })

  it('gives the block back its rendering on the way out', () => {
    const view = createEditor('# Hello')
    const [first] = allBlockPositions(view)
    enterSourceMode(view, first)
    expect((view.nodeDOM(first) as HTMLElement).classList.contains('block-source-mode')).toBe(true)

    exitBlockMode(view)

    const after = view.nodeDOM(first) as HTMLElement
    expect(after.classList.contains('block-visual-mode')).toBe(true)
    expect(after.classList.contains(BLOCK_MODE_CLASS)).toBe(false)
    view.destroy()
  })
})

describe('one cluster per top-level block', () => {
  const DOC = [
    '# Heading',
    '',
    'A paragraph.',
    '',
    '- Item 1',
    '- Item 2',
    '',
    '> Quoted',
    '',
    '```js',
    'console.log(1)',
    '```',
    '',
    '```mermaid',
    'graph TD',
    '  A[Alpha]',
    '```',
    '',
    '| A |',
    '| --- |',
    '| 1 |',
    '',
  ].join('\n')

  function clusters(view: EditorView): HTMLElement[] {
    return Array.from(view.dom.querySelectorAll<HTMLElement>(`.${BLOCK_CONTROLS_CLASS}`))
  }

  it('gives every top-level block exactly one, and a nested block none', async () => {
    const view = createEditor(DOC)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())
    // heading, paragraph, list, blockquote, code block, diagram, table. A
    // `source_block` is deliberately absent: it is permanently in its source
    // form, so it carries the banner and no cluster (§6.5).
    expect(clusters(view).length).toBe(7)
    expect(view.dom.querySelectorAll('li > .block-controls').length).toBe(0)
    expect(view.dom.querySelectorAll('blockquote .block-controls').length).toBe(0)
    view.destroy()
  })

  it('puts every one of them in the same place in its own block', async () => {
    const view = createEditor(DOC)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())
    // Compared by geometry rather than by counting buttons: what the
    // consolidation promises is *one place*, and a block type with more controls
    // (a diagram's zoom) must not push its own cluster somewhere else.
    const rights = new Set<number>()
    for (const cluster of clusters(view)) {
      cluster.getBoundingClientRect = () =>
        ({ right: 100, left: 60, top: 8, bottom: 30, width: 40, height: 22, x: 60, y: 8, toJSON: () => ({}) }) as DOMRect
      rights.add(cluster.getBoundingClientRect().right)
    }
    expect(rights.size).toBe(1)
    view.destroy()
  })

  it('labels a diagram\'s two axes from the descriptor and a table\'s form from it too', async () => {
    const view = createEditor(DOC)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())
    const heading = view.nodeDOM(0) as HTMLElement
    expect(heading.querySelector('.block-control-representation')?.textContent).toBe('Source')
    expect(heading.querySelector('.block-control-interaction')).toBeNull()

    const diagram = view.dom.querySelector<HTMLElement>('.mermaid')!
    expect(diagram.querySelector('.block-control-representation')?.textContent).toBe('Source')
    expect(diagram.querySelector('.block-control-interaction')?.textContent).toBe('Edit')

    const table = view.dom.querySelector<HTMLElement>('.ss-plain')!
    expect(table.querySelector('.block-control-form')?.textContent).toBe('Show as sheet')
    view.destroy()
  })

  it('takes the block back to its rendering when the cluster\'s own Visual is pressed', () => {
    const view = createEditor('# Hello\n\nSecond paragraph')
    const [first] = allBlockPositions(view)
    enterSourceMode(view, first)
    // The one-way dot grid of §1.5 returned early when the block it named was
    // already open, so the mode could not be turned off from there at all.
    expect((view.nodeDOM(first) as HTMLElement).querySelector(`.${BLOCK_CONTROLS_CLASS}`)).toBeNull()
    const banner = (view.nodeDOM(first) as HTMLElement).querySelector('.block-source-exit') as HTMLButtonElement
    expect(banner.textContent).toBe('Visual')
    banner.click()
    expect(currentBlockMode(view.state)).toBeNull()
    expect((view.nodeDOM(first) as HTMLElement).classList.contains('block-visual-mode')).toBe(true)
    view.destroy()
  })

  it('shows no floating cluster and exactly one Visual control while in Source', () => {
    const view = createEditor('# Hello')
    const [first] = allBlockPositions(view)
    enterSourceMode(view, first)
    expect(view.dom.querySelectorAll(`.${BLOCK_CONTROLS_CLASS}`).length).toBe(0)
    const previews = Array.from(view.dom.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Visual')
    expect(previews.length).toBe(1)
    view.destroy()
  })

  it('reveals an encrypted block\'s controls, which the old reveal list omitted', () => {
    const view = createEditor('> Just text')
    expect(view.dom.querySelectorAll(`.${BLOCK_CONTROLS_CLASS}`).length).toBe(1)
    view.destroy()
  })
})

describe('the Escape ladder (§5.3)', () => {
  it('commits a block in Source and hands it back its rendering', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const [first] = allBlockPositions(view)
    enterSourceMode(view, first)
    const cm = CMEditorView.findFromDOM(
      (view.nodeDOM(first) as HTMLElement).querySelector<HTMLElement>('.cm-editor')!,
    )!
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: '# Typed\n' } })

    expect(exitBlockMode(view)).toBe(true)

    // There is deliberately no rung that "just forgets" a source block: the
    // buffer is the only copy of what was typed, so committing *is* the exit.
    expect(proseToMarkdown(view.state.doc)).toContain('# Typed')
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })

  it('goes to Done on the interaction axis, and says nothing when nothing is open', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    enterBlockMode(view, board, { interaction: 'editing' })
    expect(modeFor(view.state, board)?.interaction).toBe('editing')

    expect(exitBlockMode(view)).toBe(true)
    expect(currentBlockMode(view.state)).toBeNull()
    // ...and the last rung: hand Escape straight on, so selection handling and
    // every other Escape handler are unaffected.
    expect(exitBlockMode(view)).toBe(false)
    view.destroy()
  })

  it('finishes a pending kanban label before the interaction axis goes', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    enterDiagramEditMode(view, board)
    expect(modeFor(view.state, board)?.interaction).toBe('editing')
    expect(exitBlockMode(view)).toBe(true)
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })
})

describe('the Alt+click gesture (§5.2)', () => {
  /** Alt+click, the gesture that toggles a block's interaction axis. */
  function altClick(target: EventTarget | null): void {
    ;(target as Element).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, button: 0 }),
    )
  }

  it('toggles a diagram, and leaves it alone for a bare double click', async () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())
    const diagram = view.dom.querySelector<HTMLElement>('.mermaid-preview')!

    altClick(diagram)
    expect(modeFor(view.state, board)?.interaction).toBe('editing')

    altClick(diagram)
    expect(modeFor(view.state, board)).toBeNull()

    // The gesture the mode used to claim, given back: a double click is the
    // browser selecting a word inside the diagram.
    const notPrevented = diagram.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }),
    )
    expect(notPrevented).toBe(true)
    expect(modeFor(view.state, board)).toBeNull()
    view.destroy()
  })

  it('finishes the interaction axis from anywhere else in the editor', async () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```\n\nAfter the diagram')
    const [board] = allBlockPositions(view)
    enterDiagramEditMode(view, board)
    const paragraph = Array.from(view.dom.querySelectorAll<HTMLElement>('p')).find(
      (el) => el.textContent === 'After the diagram',
    )!
    altClick(paragraph)
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })

  it('toggles a table\'s form and never its interaction axis', () => {
    const view = createEditor('| A |\n| --- |\n| 1 |')
    const [table] = allBlockPositions(view)
    expect(view.state.doc.nodeAt(table)!.type.name).toBe('table')
    expect(blockModeFor(view.state.doc.nodeAt(table)!).interaction).toBe('none')

    altClick(view.dom.querySelector('.ss-plain-table tbody td'))
    expect(view.state.doc.nodeAt(table)!.attrs._plain).toBe(false)
    expect(view.dom.querySelector('.spreadsheet')).not.toBeNull()

    altClick(view.dom.querySelector('.spreadsheet .ss-grid tbody td')!)
    expect(view.state.doc.nodeAt(table)!.attrs._plain).toBe(true)
    expect(view.dom.querySelector('.ss-plain')).not.toBeNull()
    // A form is not on either axis, so no record ever names it.
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })

  it('is inert on a block type that registers nothing to toggle', () => {
    const view = createEditor('# Hello\n\nSecond paragraph')
    altClick(view.dom.querySelector('h1'))
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })
})

describe('the generated controls', () => {
  it('toggles the representation axis from the API, in both directions', () => {
    const view = createEditor('# Hello')
    const [first] = allBlockPositions(view)
    toggleBlockMode(view, first, 'representation')
    expect(modeFor(view.state, first)?.representation).toBe('source')
    toggleBlockMode(view, first, 'representation')
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })
})

describe('a mode flip reaches the node views (BLOCK_MODE_CLASS)', () => {
  // The bug this whole describe exists for. A mode is not a document edit, so
  // ProseMirror re-walks the tree only when a node's *decorations* change —
  // `ViewDesc.matchesNode` compares them by value and returns "nothing to do"
  // when they match. A decoration that only said "there is a mode" is therefore
  // byte-identical across two different modes, so flipping an axis while the
  // record stays held changed nothing the view could see: the record moved to
  // Source and the board kept drawing, which is a control that looks inert.
  //
  // The class carries the mode, so the accent rule is the load-bearing half of
  // the notification as well as the legible one.

  it('carries the representation, so the two forms decorate differently', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    const classes = (): string[] =>
      [...(view.nodeDOM(board) as HTMLElement).classList].sort()

    // Both forms on one block, with the record held throughout: the transition
    // the old single class could not express.
    enterBlockMode(view, board, { interaction: 'editing' })
    expect(classes()).toContain(BLOCK_MODE_VISUAL_CLASS)
    expect(classes()).toContain(BLOCK_MODE_EDITING_CLASS)

    enterSourceMode(view, board)
    expect(classes()).toContain(BLOCK_MODE_SOURCE_CLASS)
    expect(classes()).not.toContain(BLOCK_MODE_VISUAL_CLASS)

    exitBlockMode(view)
    expect(classes()).not.toContain(BLOCK_MODE_CLASS)
    view.destroy()
  })

  it('rebuilds a diagram that enters Source from its own edit mode', () => {
    // The gesture that reported it: alt-click a board into edit mode, press
    // Source. Both records are non-null and both decorate the same node, so this
    // is the transition the class has to distinguish.
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    enterDiagramEditMode(view, board)
    expect(modeFor(view.state, board)?.interaction).toBe('editing')

    enterSourceMode(view, board)

    expect(modeFor(view.state, board)).toMatchObject({
      representation: 'source',
      interaction: 'viewing',
    })
    // The board is asked to become something else, and it does.
    const dom = view.nodeDOM(board) as HTMLElement
    expect(dom.classList.contains('block-source-mode')).toBe(true)
    expect(dom.querySelector('.mermaid-preview')).toBeNull()
    expect(dom.querySelector('.block-source-exit')?.textContent).toBe('Visual')
    view.destroy()
  })

  it('rebuilds a diagram that enters edit mode from its own Source form', async () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    enterSourceMode(view, board)
    expect((view.nodeDOM(board) as HTMLElement).classList.contains('block-source-mode')).toBe(true)

    enterBlockMode(view, board, { interaction: 'editing' })
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())

    const dom = view.nodeDOM(board) as HTMLElement
    expect(dom.classList.contains('mermaid')).toBe(true)
    expect(dom.classList.contains('mermaid-editing')).toBe(true)
    expect(dom.classList.contains('block-source-mode')).toBe(false)
    view.destroy()
  })
})

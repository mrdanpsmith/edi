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
import { enterSpreadsheetMode, tableNodeViewPlugin } from './node/table'
import {
  BLOCK_CONTROLS_CLASS,
  BLOCK_MODE_CLASS,
  BLOCK_MODE_EDITING_CLASS,
  BLOCK_MODE_KEY,
  BLOCK_MODE_SOURCE_CLASS,
  BLOCK_MODE_VISUAL_CLASS,
  advanceBlockMode,
  blockFormMode,
  blockModeFor,
  blockModePlugin,
  currentBlockMode,
  enterBlockMode,
  enterSourceMode,
  exitBlockMode,
  keepOneNonVisualBlock,
  leaveBlockMode,
  modeFor,
  setBlockForm,
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

    // A spreadsheet is a table's *Edit*, so a table's cluster reads exactly like a
    // diagram's: Source, Edit. One vocabulary for the whole cycle.
    const table = view.dom.querySelector<HTMLElement>('.ss-plain')!
    expect(table.querySelector('.block-control-form')?.textContent).toBe('Edit')
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

  it('is not a way round the cycle: only a source form answers it', () => {
    // Escape is a *cancel*, and the only step that reads as one is a raw-markdown
    // buffer you opened and do not want. The other two steps are moves through the
    // cycle, so they belong to Alt+Shift+click (§5.2) and to the block's controls.
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)

    // A diagram being edited: not Escape's business, and said so by returning false
    // so the key is handed on to every other handler.
    enterBlockMode(view, board, { interaction: 'editing' })
    expect(modeFor(view.state, board)?.interaction).toBe('editing')
    expect(exitBlockMode(view)).toBe(false)
    expect(modeFor(view.state, board)?.interaction).toBe('editing')

    // A table as a sheet, likewise.
    const table = createEditor('| A |\n| --- |\n| 1 |')
    const [pos] = allBlockPositions(table)
    setBlockForm(table, pos, 'sheet')
    expect(exitBlockMode(table)).toBe(false)
    expect(blockFormMode(table.state, pos)).toBe('sheet')
    table.destroy()

    // The source form is the one Escape does answer, and it commits.
    enterSourceMode(view, board)
    expect(exitBlockMode(view)).toBe(true)
    expect(currentBlockMode(view.state)).toBeNull()
    // ...and with nothing open it hands straight on.
    expect(exitBlockMode(view)).toBe(false)
    view.destroy()
  })

  it("leaves a diagram's editing layer through the backwards gesture, not Escape", () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    enterDiagramEditMode(view, board)
    expect(modeFor(view.state, board)?.interaction).toBe('editing')

    // `leaveBlockMode` is the cycle's backwards step, and what
    // `Mod-Shift-e` and the page's one-slot rule both use.
    expect(leaveBlockMode(view, board)).toBe(true)
    expect(currentBlockMode(view.state)).toBeNull()
    // A block that was merely being viewed is left alone and reported as such, so
    // the gesture does not consume a click that was not about anything.
    expect(leaveBlockMode(view, board)).toBe(false)
    view.destroy()
  })
})

describe('the Alt+click gesture (§5.2)', () => {
  /** Alt+click, the gesture that advances a block one step through its cycle. */
  function altClick(target: EventTarget | null, shift = false): void {
    ;(target as Element).dispatchEvent(
      new MouseEvent('click', {
        bubbles: true, cancelable: true, altKey: true, button: 0, shiftKey: shift,
      }),
    )
  }

  it('cycles a diagram visual → edit → source → visual, and leaves a double click alone', async () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())

    // Each step is aimed at the block's own node view. A step's element is
    // detached by the step after it, and the gesture's listener is on the
    // scroller, so an Alt+click on a detached node reaches nothing at all — and
    // aiming *inside* a block in its source form reaches nothing either, because
    // that is a CodeMirror instance and `chromeOwnsClick` rightly calls an
    // Alt+click in a text field the field's own business.
    const step = (): void => {
      altClick(view.nodeDOM(board))
    }

    step()
    expect(modeFor(view.state, board)?.interaction).toBe('editing')

    // Edit is not a terminal state: the step on from it is the block's own source,
    // and the diagram's pending field is accepted on the way out of edit mode
    // rather than dropped — `enterSourceMode` cannot finish it, the exit does.
    step()
    expect(modeFor(view.state, board)).toMatchObject({
      representation: 'source',
      interaction: 'viewing',
    })
    expect((view.nodeDOM(board) as HTMLElement).classList.contains('block-source-mode')).toBe(true)

    // ...and the cycle wraps, committing the source buffer on the way through.
    step()
    expect(modeFor(view.state, board)).toBeNull()
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())

    // The gesture the mode used to claim, given back: a double click is the
    // browser selecting a word inside the diagram.
    const diagram = view.dom.querySelector<HTMLElement>('.mermaid-preview')!
    const notPrevented = diagram.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }),
    )
    expect(notPrevented).toBe(true)
    expect(modeFor(view.state, board)).toBeNull()
    view.destroy()
  })

  it('steps back down the cycle with Escape, which is the only way off it', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)

    enterSourceMode(view, board)
    expect(exitBlockMode(view)).toBe(true)
    expect(modeFor(view.state, board)).toBeNull()
    // Visual is the bottom of the ladder, so from there Escape is handed on to
    // every other handler — selection, dialogs, a diagram's own.
    expect(exitBlockMode(view)).toBe(false)
    view.destroy()
  })

  it('cycles a table text → sheet → source → text, and never its interaction axis', () => {
    const view = createEditor('| A |\n| --- |\n| 1 |')
    const [table] = allBlockPositions(view)
    expect(view.state.doc.nodeAt(table)!.type.name).toBe('table')
    expect(blockModeFor(view.state.doc.nodeAt(table)!).interaction).toBe('none')

    const step = (): void => {
      altClick(view.nodeDOM(table))
    }

    step()
    expect(blockFormMode(view.state, table)).toBe('sheet')
    expect(view.dom.querySelector('.spreadsheet')).not.toBeNull()

    step()
    expect(modeFor(view.state, table)?.representation).toBe('source')

    // The wrap lands on the cycle's *first* step rather than on whatever the
    // block was drawn as before, or a sheet table would oscillate sheet ⇄ source
    // and never reach text again.
    step()
    expect(blockFormMode(view.state, table)).toBeUndefined()
    expect(view.dom.querySelector('.ss-plain')).not.toBeNull()
    // Plain text is a table's *rendering*, not a mode, so the wrap releases the
    // record entirely rather than leaving a formless one sitting in the slot.
    expect(currentBlockMode(view.state)).toBeNull()
    view.destroy()
  })

  it('cycles a plain block straight to its source, and gives it no middle step', () => {
    const view = createEditor('# Hello\n\nSecond paragraph')
    const [heading] = allBlockPositions(view)
    expect(blockModeFor(view.state.doc.nodeAt(heading)!).forms).toBeUndefined()
    expect(blockModeFor(view.state.doc.nodeAt(heading)!).interaction).toBe('none')

    altClick(view.dom.querySelector('h1'))
    expect(modeFor(view.state, heading)?.representation).toBe('source')
    expect(view.dom.querySelector('.block-source-exit')?.textContent).toBe('Visual')
    view.destroy()
  })

  it('has no cycle on a block that is permanently its own source', () => {
    // `source_block` has no markdown syntax — it is built programmatically — and
    // it *is* its source form, so `advanceBlockMode` declines it and the gesture
    // keeps its older meaning for this one type: finish whatever is open.
    const view = createEditor('# Hello')
    const only = view.state.schema.nodes.source_block.create({ markdown: 'plain text\n' })
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, only)
    view.dispatch(tr)

    expect(blockModeFor(view.state.doc.nodeAt(0)!).representation).toBe(false)
    expect(advanceBlockMode(view, 0)).toBe(false)
    view.destroy()
  })

  it('advances a code block from its own text, which is a CodeMirror and not a field', () => {
    // A code block's visual form *is* a CodeMirror instance, so the rule that
    // hands an Alt+click in a text field to that field used to claim it — which
    // made the cycle unreachable on the only part of a code block anyone clicks.
    const view = createEditor('```python\nprint(1)\n```')
    const [code] = allBlockPositions(view)
    const editor = view.dom.querySelector<HTMLElement>('.cm-content')!
    expect(editor.closest('.cm-editor')).not.toBeNull()

    altClick(editor)
    expect(modeFor(view.state, code)?.representation).toBe('source')
    view.destroy()
  })

  it('walks the cycle backwards on Alt+Shift+click, and forwards on Alt+click', async () => {
    // A mirror, not a shortcut out. `visual → edit → source` and
    // `source → edit → visual` are the same three steps in two directions, so the
    // block under the pointer is all either has to be told — and either can reach
    // every step, which an earlier "straight to Visual" version could not.
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid')).not.toBeNull())
    const click = (back: boolean) => altClick(view.nodeDOM(board) as HTMLElement, back)

    const step = (): string => {
      const mode = modeFor(view.state, board)
      return mode === null ? 'visual' : mode.representation === 'source'
        ? 'source'
        : mode.interaction === 'editing' ? 'edit' : mode.form ?? 'visual'
    }

    expect(step()).toBe('visual')
    click(false)
    expect(step()).toBe('edit')
    click(false)
    expect(step()).toBe('source')
    // Forward wraps to the start of the cycle.
    click(false)
    expect(step()).toBe('visual')

    click(false)
    expect(step()).toBe('edit')
    // Backwards goes edit → visual, which is the step a shortcut-out could not do
    // without going forward through source first.
    click(true)
    expect(step()).toBe('visual')
    // ...and from visual, backwards is the last step.
    click(true)
    expect(step()).toBe('source')
    click(true)
    expect(step()).toBe('edit')

    // The editing layer really goes, not merely unrecorded.
    click(true)
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid-editing')).toBeNull())
    expect(view.dom.querySelector('.mermaid-editables')).toBeNull()
    view.destroy()
  })

  it('comes back from Source as a sheet, because a form is sticky', () => {
    // Source → edit on a table returns the *form it left in*, which is what makes
    // the backwards gesture a mirror rather than a reset.
    const view = createEditor('| A |\n| --- |\n| 1 |')
    const [table] = allBlockPositions(view)
    const dom = () => view.nodeDOM(table) as HTMLElement

    altClick(dom())
    expect(blockFormMode(view.state, table)).toBe('sheet')
    altClick(dom())
    expect(modeFor(view.state, table)?.representation).toBe('source')
    altClick(dom(), true)
    expect(blockFormMode(view.state, table)).toBe('sheet')
    expect(view.dom.querySelector('.spreadsheet')).not.toBeNull()
    view.destroy()
  })

  it('moves the block it lands on, and only ever one block', () => {
    // Visual is the *start* of the cycle, so backwards from it is the last step:
    // there is nothing to leave, but there is somewhere to go, and it is that
    // block which goes.
    const view = createEditor('# Hello\n\nSecond paragraph')
    const [heading] = allBlockPositions(view)
    enterSourceMode(view, heading)

    altClick(view.nodeDOM(allBlockPositions(view)[1]!) as HTMLElement, true)
    // Positions are re-read: entering the paragraph's source committed the
    // heading's, and a re-parse moves whatever follows it.
    const positions = allBlockPositions(view)
    const holder = positions.filter((pos) => modeFor(view.state, pos) !== null)
    expect(holder.length).toBe(1)
    expect(modeFor(view.state, positions[1]!)?.representation).toBe('source')
    // The record is exclusive, so the heading it displaced is no longer holding it.
    expect(modeFor(view.state, positions[0]!)).toBeNull()
    view.destroy()
  })

  it('cycles a block out of its own source form, from inside the buffer', () => {
    // A cycle that can only be entered is not a cycle. A block in Source is a
    // raw-markdown editor, and that editor used to be claimed as "a text field",
    // so the block Alt+click had just opened could not be Alt+clicked closed —
    // and the same claim made a code block's visual form unreachable to begin
    // with, since a code block's text is the whole block.
    const view = createEditor('```python\nprint(1)\n```')
    const [code] = allBlockPositions(view)
    enterSourceMode(view, code)

    altClick(view.dom.querySelector<HTMLElement>('.cm-content')!)
    expect(modeFor(view.state, code)).toBeNull()
    expect(
      (view.nodeDOM(code) as HTMLElement).classList.contains('block-source-mode'),
    ).toBe(false)
    view.destroy()
  })

it('still hands an Alt+click on a real control to that control', () => {
    // The claim is not gone — it is the *interactively editable* things that keep
    // it. A link is the browser's: nothing about the block's mode happened.
    const view = createEditor('[a link](https://example.com)')
    const link = view.dom.querySelector<HTMLAnchorElement>('a[href]')!
    expect(link).not.toBeNull()
    altClick(link)
    expect(currentBlockMode(view.state)).toBeNull()

    // The cluster's own button is the block's, and a press on it is a press on
    // that button — so it does its own job rather than the gesture's, which is
    // the Source toggle and nothing to do with a cycle step.
    const button = view.dom.querySelector<HTMLButtonElement>('.block-control-representation')!
    expect(button).not.toBeNull()
    altClick(button)
    expect(modeFor(view.state, 0)?.representation).toBe('source')
    view.destroy()
  })

  it('still finishes whatever is open for a click that names no block at all', () => {
    // The gesture that turns a mode off need not land back on the block that
    // turned it on, and the page under a lone board is not even inside the
    // editor's own box — which is why the listener is on the scroller.
    const view = createEditor('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [board] = allBlockPositions(view)
    enterDiagramEditMode(view, board)

    const outside = view.dom.parentElement!
    expect(outside.contains(view.dom)).toBe(true)
    expect(view.dom.contains(outside)).toBe(false)
    outside.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, button: 0 }),
    )
    expect(modeFor(view.state, board)).toBeNull()
    view.destroy()
  })
})

describe('one non-visual block in the whole page', () => {
  // The rule is that at most one block anywhere is in a non-visual state, and it
  // spans editors: an unlocked encrypted block is a *whole nested* editor with its
  // own record, so "at most one" is a statement about the page. That needs
  // something the plugin state cannot hold — a pointer to the editor that has the
  // slot — so it is the one thing here that lives outside plugin state, and these
  // are the tests that say what it may and may not do.
  /**
   * Two editors that keep the page's one slot, built the way the app builds them.
   *
   * `keepOneNonVisualBlock` is called from `createBlockEditor`'s
   * `dispatchTransaction`, and an editor that does not call it opts *out* of the
   * rule — it never claims the slot, so nothing can release it. Calling the same
   * function here is therefore part of being a second editor, not a workaround:
   * it is the one requirement, and it is stated in one place.
   */
  function editor(md: string): EditorView {
    const view = createEditor(md)
    const dispatch = view.dispatch.bind(view)
    view.dispatch = (tr: Parameters<typeof dispatch>[0]) => {
      dispatch(tr)
      keepOneNonVisualBlock(view)
    }
    return view
  }

  function editors(): { a: EditorView; b: EditorView } {
    const md = '| A |\n| --- |\n| 1 |\n\n```mermaid\ngraph TD\n  A[Alpha]\n```'
    return { a: editor(md), b: editor(md) }
  }

  /** The table in `view`, which is the first top-level block of its document. */
  const tableOf = (view: EditorView): number => allBlockPositions(view)[0]!
  /** The diagram in `view`, which is the second. */
  const boardOf = (view: EditorView): number => allBlockPositions(view)[1]!

  it('releases the other editor when one takes a mode, whichever it is', () => {
    const { a, b } = editors()

    advanceBlockMode(a, tableOf(a))
    expect(blockFormMode(a.state, tableOf(a))).toBe('sheet')

    // The other editor wins, and the sheet it had is committed and put back.
    enterDiagramEditMode(b, boardOf(b))
    expect(modeFor(b.state, boardOf(b))?.interaction).toBe('editing')
    expect(blockFormMode(a.state, tableOf(a))).toBeUndefined()
    expect(a.dom.querySelector('.ss-plain')).not.toBeNull()

    // ...and symmetrically, because it is one slot and not two.
    enterSpreadsheetMode(b, tableOf(b))
    expect(modeFor(b.state, boardOf(b))?.interaction).toBeUndefined()
    expect(blockFormMode(b.state, tableOf(b))).toBe('sheet')
    a.destroy()
    b.destroy()
  })

  it('forgets an editor that has gone away, rather than being stuck behind it', () => {
    // A closed tab, or a re-locked encrypted block, takes its editor out of the
    // document. Holding a dead reference must not stop the page taking a mode —
    // and `dom.isConnected` is what says so, because a destroyed `EditorView`
    // keeps its `dom`.
    const { a, b } = editors()
    advanceBlockMode(a, tableOf(a))
    a.destroy()

    expect(() => enterDiagramEditMode(b, boardOf(b))).not.toThrow()
    expect(modeFor(b.state, boardOf(b))?.interaction).toBe('editing')
    b.destroy()
  })

  it('lets any number of blocks sit in their default rendering', () => {
    // Plain text is a table's rendering, not a mode, so it holds nothing. Without
    // this a document could not contain two tables.
    const view = createEditor('| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |')
    expect(allBlockPositions(view).length).toBe(2)
    expect(currentBlockMode(view.state)).toBeNull()
    expect(view.dom.querySelectorAll('.ss-plain').length).toBe(2)
    view.destroy()
  })

  it('does not let a sheet and an edit mode coexist in one document', () => {
    const view = createEditor('| A |\n| --- |\n| 1 |\n\n```mermaid\ngraph TD\n  A[Alpha]\n```')
    const [table, board] = allBlockPositions(view)
    advanceBlockMode(view, table)
    expect(blockFormMode(view.state, table)).toBe('sheet')

    // One block holds the record, so the diagram cannot also be being edited.
    enterDiagramEditMode(view, board)
    expect(blockFormMode(view.state, table)).toBeUndefined()
    expect(modeFor(view.state, board)?.interaction).toBe('editing')
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

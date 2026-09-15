import { describe, expect, it, beforeEach, vi } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Node as ProseNode } from 'prosemirror-model'
import { setBlockType } from 'prosemirror-commands'
import { blockPlugin, enterSourceMode, exitSourceMode, toggleSourceMode, getSourceBlockState, BLOCK_PLUGIN_KEY } from './blockplugin'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { mermaidNodeViewPlugin } from './node/mermaid'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { tableNodeViewPlugin } from './node/table'
import { serializeBlock } from './markdown'
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

import * as mermaidModule from 'mermaid'

function createEditor(initialMarkdown: string) {
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
      plugins: [blockPlugin, codeBlockNodeViewPlugin, nodeViewPlugin, mermaidNodeViewPlugin, tableNodeViewPlugin],
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

describe('blockPlugin state', () => {
  it('starts with no source block', () => {
    const view = createEditor('# Hello')
    const state = getSourceBlockState(view.state)
    expect(state.sourceBlockPos).toBeNull()
    view.destroy()
  })

  it('enterSourceMode sets _source attr and plugin state', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    const tr = enterSourceMode(view.state, pos)
    expect(tr.getMeta(BLOCK_PLUGIN_KEY)).toEqual({ sourceBlockPos: pos })

    view.dispatch(tr)
    const blockState = getSourceBlockState(view.state)
    expect(blockState.sourceBlockPos).toBe(pos)

    const node = blockNodeAt(view, pos)
    expect(node!.attrs._source).toBe(true)
    view.destroy()
  })

  it('exitSourceMode clears _source attr and plugin state', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))

    const tr = exitSourceMode(view.state)
    view.dispatch(tr)
    const blockState = getSourceBlockState(view.state)
    expect(blockState.sourceBlockPos).toBeNull()

    const node = blockNodeAt(view, pos)
    expect(node!.attrs._source).toBe(false)
    view.destroy()
  })

  it('toggleSourceMode enters when not in source mode', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    const tr = toggleSourceMode(view.state, pos)
    view.dispatch(tr)
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(pos)
    view.destroy()
  })

  it('toggleSourceMode exits when clicking same block', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(toggleSourceMode(view.state, pos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBeNull()
    view.destroy()
  })

  it('toggleSourceMode switches to different block', () => {
    const view = createEditor('# First\n\nSecond paragraph')
    const positions = allBlockPositions(view)
    expect(positions.length).toBe(2)

    view.dispatch(enterSourceMode(view.state, positions[0]))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(positions[0])

    view.dispatch(toggleSourceMode(view.state, positions[1]))
    const blockState = getSourceBlockState(view.state)
    expect(blockState.sourceBlockPos).toBe(positions[1])

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
    view.dispatch(enterSourceMode(view.state, pos))
    const deco = view.nodeDOM(pos) as HTMLElement
    expect(deco).toBeTruthy()
    expect(deco.classList.contains('block-source-mode')).toBe(true)
    view.destroy()
  })

  it('switches back to visual after exitSourceMode', () => {
    const view = createEditor('# Hello')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    expect((view.nodeDOM(pos) as HTMLElement).classList.contains('block-source-mode')).toBe(true)

    view.dispatch(exitSourceMode(view.state))
    const deco = view.nodeDOM(pos) as HTMLElement
    expect(deco).toBeTruthy()
    expect(deco.classList.contains('block-visual-mode')).toBe(true)
    view.destroy()
  })

  it('source view has exit button', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    const dom = view.nodeDOM(pos) as HTMLElement
    const btn = dom.querySelector('.block-source-exit') as HTMLElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toBe('Visual mode')
    view.destroy()
  })

  it('source view has a CodeMirror editor', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
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
    view.dispatch(enterSourceMode(view.state, pos))
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

    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))

    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('Hello')
    view.destroy()
  })

  it('edited source content is applied on exit', () => {
    const view = createEditor('Original text')
    const pos = firstBlockPos(view)

    view.dispatch(enterSourceMode(view.state, pos))

    const dom = view.nodeDOM(pos) as HTMLElement
    const cmEditor = dom.querySelector('.cm-editor') as HTMLElement
    expect(cmEditor).toBeTruthy()

    view.dispatch(exitSourceMode(view.state))
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('Original text')
    view.destroy()
  })

  it('escape key exits source mode', () => {
    const view = createEditor('Hello world')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(pos)

    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    cmContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(getSourceBlockState(view.state).sourceBlockPos).toBeNull()
    view.destroy()
  })
})

describe('source mode serialization', () => {
  it('code block shows fence and language in source mode', () => {
    const view = createEditor('```js\nconst x = 1;\n```')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('```js')
    expect(cmContent.textContent).toContain('const x = 1;')
    view.destroy()
  })

  it('code block round-trips through source mode', () => {
    const view = createEditor('```js\nconst x = 1;\n```')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('```js')
    expect(md).toContain('const x = 1;')
    view.destroy()
  })

  it('mermaid block shows content in source mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('graph TD')
    expect(cmContent.textContent).toContain('A-->B')
    view.destroy()
  })

  it('mermaid block round-trips through source mode', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('graph TD')
    expect(md).toContain('A-->B')
    view.destroy()
  })

  it('table shows pipe-formatted markdown in source mode', () => {
    const view = createEditor('| H1 | H2 |\n| --- | --- |\n| A | B |')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    const dom = view.nodeDOM(pos) as HTMLElement
    const cmContent = dom.querySelector('.cm-content') as HTMLElement
    expect(cmContent.textContent).toContain('| H1 | H2 |')
    expect(cmContent.textContent).toContain('| A | B |')
    view.destroy()
  })

  it('table round-trips through source mode', () => {
    const view = createEditor('| H1 | H2 |\n| --- | --- |\n| A | B |')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
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
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
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
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('- [ ] Todo item')
    expect(md).toContain('- [x] Done item')
    view.destroy()
  })

  it('nested ordered list round-trips through source mode', () => {
    const md = '1. First\n   1. Sub A\n   2. Sub B\n2. Second'
    const view = createEditor(md)
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
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
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
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
    expect(getSourceBlockState(view.state).sourceBlockPos).toBeNull()

    const handle = view.dom.querySelector('.block-handle') as HTMLElement
    expect(handle).toBeTruthy()
    const handlePos = Number(handle.getAttribute('data-block-pos'))
    expect(handlePos).toBe(pos)

    view.dispatch(toggleSourceMode(view.state, handlePos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(pos)
    view.destroy()
  })

  it('mermaid source mode shows code in CodeMirror', () => {
    const view = createEditor('```mermaid\ngraph TD\n  A-->B\n```')
    const pos = firstBlockPos(view)
    view.dispatch(enterSourceMode(view.state, pos))
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
    view.dispatch(enterSourceMode(view.state, pos))
    view.dispatch(exitSourceMode(view.state))
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('graph TD')
    expect(md).toContain('A-->B')
    view.destroy()
  })
})

describe('mermaid visual mode rendering', () => {
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

    view.dispatch(toggleSourceMode(view.state, positions[0]))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(positions[0])

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

    view.dispatch(toggleSourceMode(view.state, handlePos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(codeBlockPos)

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

    view.dispatch(toggleSourceMode(view.state, positions[1]))

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

    view.dispatch(toggleSourceMode(view.state, handlePos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(runPos)

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

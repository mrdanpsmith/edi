import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  detectDiagramType,
  moveKanbanCard,
  parseKanban,
  patchLabel,
  rebuildKanban,
  renderDiagram,
  type DiagramFamily,
} from './mermaid-edit'

const hoisted = vi.hoisted(() => ({ render: vi.fn(), bake: vi.fn(async () => false) }))

vi.mock('./mermaid', () => ({
  loadMermaid: vi.fn(async () => ({ render: hoisted.render })),
  errorBlock: vi.fn((message: string) => {
    const block = document.createElement('div')
    block.className = 'mermaid-error'
    block.textContent = `Mermaid render error\n${message}`
    return block
  }),
  responsifySvg: vi.fn(() => 800),
  adaptDiagramColors: vi.fn(),
  pinSvgTextColors: vi.fn(),
  attachMermaidToolbar: vi.fn(),
  bakeDiagram: hoisted.bake,
}))

const FLOWCHART_SVG = `<svg>
  <g class="nodes">
    <g class="node default" id="flowchart-A-0">
      <rect class="labelBkg" />
      <g class="label"><foreignObject width="60" height="22">
        <div class="labelBkg"><span class="nodeLabel markdown-node-label"><p id="flowchart-A-0" class="nodeLabel">Alpha</p></span></div>
      </foreignObject></g>
    </g>
    <g class="node default" id="flowchart-B-1">
      <rect class="labelBkg" />
      <g class="label"><foreignObject width="60" height="22">
        <div class="labelBkg"><span class="nodeLabel markdown-node-label"><p id="flowchart-B-1" class="nodeLabel">Beta</p></span></div>
      </foreignObject></g>
    </g>
  </g>
  <g class="edgePaths"><path d="M0,0" /></g>
  <g class="edgeLabels">
    <g class="edgeLabel"><foreignObject width="40" height="20">
      <div class="labelBkg"><span class="edgeLabel"><p class="edgeLabel">Yes</p></span></div>
    </foreignObject></g>
  </g>
</svg>`

const KANBAN_SVG = `<svg>
  <g class="sections">
    <g class="cluster section-0"><rect class="section0" /><g class="cluster-label"><foreignObject><div class="labelBkg"><span class="nodeLabel"><p>Todo</p></span></div></foreignObject></g></g>
    <g class="cluster section-1"><rect class="section1" /><g class="cluster-label"><foreignObject><div class="labelBkg"><span class="nodeLabel"><p>Doing</p></span></div></foreignObject></g></g>
  </g>
  <g class="items">
    <g class="node default" id="K1"><rect /><g class="label"><foreignObject><div class="labelBkg"><span class="nodeLabel"><p>One</p></span></div></foreignObject></g><foreignObject><div><span class="nodeLabel"></span></div></foreignObject></g>
    <g class="node default" id="K2"><rect /><g class="label"><foreignObject><div class="labelBkg"><span class="nodeLabel"><p>Two</p></span></div></foreignObject></g><foreignObject><div><span class="nodeLabel"></span></div></foreignObject></g>
    <g class="node default" id="K3"><rect /><g class="label"><foreignObject><div class="labelBkg"><span class="nodeLabel"><p>Three</p></span></div></foreignObject></g><foreignObject><div><span class="nodeLabel"></span></div></foreignObject></g>
  </g>
</svg>`

const SEQUENCE_SVG = `<svg>
  <g><text class="actor actor-box" x="10" y="20"><tspan>Alice</tspan></text></g>
  <g><text class="messageText" x="20" y="80"><tspan>Hello there</tspan></text></g>
</svg>`

function ok(text: string): { status: 'ok'; text: string } {
  return { status: 'ok', text }
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('detectDiagramType', () => {
  it('reads the first meaningful line', () => {
    expect(detectDiagramType('graph TD\n  A --> B')).toBe('graph')
    expect(detectDiagramType('  \nflowchart-elk LR\n  A --> B')).toBe('flowchart-elk')
    expect(detectDiagramType('%% a comment\nkanban\n  Todo\n    id1[Card]')).toBe('kanban')
  })

  it('skips a leading frontmatter block', () => {
    expect(detectDiagramType('---\ntitle: x\n---\nsequenceDiagram\n  A->>B: hi')).toBe('sequenceDiagram')
  })

  it('returns an empty string for an empty source', () => {
    expect(detectDiagramType('\n%% only a comment\n')).toBe('')
  })
})

describe('patchLabel: flowchart', () => {
  const family: DiagramFamily = 'graph'

  it('patches a node label inside its shape delimiters', () => {
    expect(patchLabel('graph TD\n  A[Alpha]', family, 'Alpha', 'A1')).toEqual(
      ok('graph TD\n  A[A1]'),
    )
    expect(patchLabel('graph TD\n  A((Alpha))', family, 'Alpha', 'A1')).toEqual(
      ok('graph TD\n  A((A1))'),
    )
    expect(patchLabel('graph TD\n  A{{Alpha}}', family, 'Alpha', 'A1')).toEqual(
      ok('graph TD\n  A{{A1}}'),
    )
    expect(patchLabel('graph TD\n  A[/Alpha/]', family, 'Alpha', 'A1')).toEqual(
      ok('graph TD\n  A[/A1/]'),
    )
    expect(patchLabel('graph TD\n  A"Alpha"', family, 'Alpha', 'A1')).toEqual(ok('graph TD\n  A"A1"'))
    expect(patchLabel('graph TD\n  A>Alpha]', family, 'Alpha', 'A1')).toEqual(ok('graph TD\n  A>A1]'))
  })

  it('patches edge labels in every arrow form', () => {
    expect(patchLabel('graph TD\n  A -->|Yes| B', family, 'Yes', 'No')).toEqual(
      ok('graph TD\n  A -->|No| B'),
    )
    expect(patchLabel('graph TD\n  A -- Yes --> B', family, 'Yes', 'No')).toEqual(
      ok('graph TD\n  A -- No --> B'),
    )
    expect(patchLabel('graph TD\n  A-. Yes .-> B', family, 'Yes', 'No')).toEqual(
      ok('graph TD\n  A-. No .-> B'),
    )
    expect(patchLabel('graph TD\n  A == Yes ==> B', family, 'Yes', 'No')).toEqual(
      ok('graph TD\n  A == No ==> B'),
    )
  })

  it('refuses when two nodes show the same label', () => {
    // Nothing in the source says which of the two the click meant.
    expect(patchLabel('graph TD\n  Alpha[Alpha]\n  B[Alpha]', family, 'Alpha', 'A1')).toEqual({
      status: 'ambiguous',
    })
  })

  it('refuses when the label occurs more than once with no shape to disambiguate', () => {
    expect(patchLabel('graph TD\n  A -->|Yes| B -->|Yes| C', family, 'Yes', 'No')).toEqual({
      status: 'ambiguous',
    })
  })

  it('does not read an edge endpoint as a shape delimiter', () => {
    const source = 'graph TD\n  A -- go --> Beta\n  Beta[Beta]'
    expect(patchLabel(source, family, 'Beta', 'Gamma')).toEqual(
      ok('graph TD\n  A -- go --> Beta\n  Beta[Gamma]'),
    )
  })
})

describe('patchLabel: sequence', () => {
  const family: DiagramFamily = 'sequence'
  const source = [
    'sequenceDiagram',
    '    participant S as Server',
    '    participant Alice',
    '    S->>Alice: Hello',
    '    Alice->>S: Hi Alice',
  ].join('\n')

  it('patches an aliased participant label', () => {
    expect(patchLabel(source, family, 'Server', 'Backend')).toEqual(
      ok(source.replace('as Server', 'as Backend')),
    )
  })

  it('renames a bare participant everywhere it is referenced, but not in message text', () => {
    expect(patchLabel(source, family, 'Alice', 'Alicia')).toEqual(
      ok([
        'sequenceDiagram',
        '    participant S as Server',
        '    participant Alicia',
        '    S->>Alicia: Hello',
        '    Alicia->>S: Hi Alice',
      ].join('\n')),
    )
  })

  it('patches message text', () => {
    expect(patchLabel(source, family, 'Hello', 'Hi')).toEqual(
      ok(source.replace(': Hello', ': Hi')),
    )
  })

  it('refuses an ambiguous message text', () => {
    const twice = 'sequenceDiagram\n  A->>B: Ping\n  C->>D: Ping'
    expect(patchLabel(twice, family, 'Ping', 'Pong')).toEqual({ status: 'ambiguous' })
  })
})

describe('patchLabel: kanban', () => {
  const family: DiagramFamily = 'kanban'
  const source = ['kanban', '  Todo', '    id1[First card]', '  Doing', '    id2[Second card]'].join(
    '\n',
  )

  it('patches a card label and leaves its metadata alone', () => {
    const withMeta = 'kanban\n  Todo\n    id1[First card]@{ priority: \'High\' }'
    expect(patchLabel(withMeta, family, 'First card', 'Renamed')).toEqual(
      ok('kanban\n  Todo\n    id1[Renamed]@{ priority: \'High\' }'),
    )
  })

  it('patches a column header', () => {
    expect(patchLabel(source, family, 'Doing', 'Done')).toEqual(ok(source.replace('Doing', 'Done')))
  })

  it('patches a card declared as a bare id', () => {
    expect(patchLabel('kanban\n  Todo\n    TICKET-1', family, 'TICKET-1', 'TICKET-2')).toEqual(
      ok('kanban\n  Todo\n    TICKET-2'),
    )
  })

  it('falls back to the rendered text for a shape mermaid renders verbatim', () => {
    // The mapper reports no label for `id6>Ang Label]`, so the edit goes
    // through the unique-substring rule rather than guessing a shape span.
    const source2 = 'kanban\n  Todo\n    id6>Ang Label]'
    expect(patchLabel(source2, family, 'Ang Label]', 'X')).toEqual(ok('kanban\n  Todo\n    id6>X'))
  })
})

describe('patchLabel: generic diagrams', () => {
  const family: DiagramFamily = 'generic'

  it('patches a label that occurs exactly once', () => {
    expect(patchLabel('pie title Pets\n  "Dogs" : 10\n  "Cats" : 20', family, 'Dogs', 'Hounds')).toEqual(
      ok('pie title Pets\n  "Hounds" : 10\n  "Cats" : 20'),
    )
  })

  it('refuses a label that occurs more than once', () => {
    expect(patchLabel('pie\n  "A" : 1\n  "B" : 2\n  "A" : 3', family, 'A', 'C')).toEqual({
      status: 'ambiguous',
    })
  })

  it('reports a label that is not in the source at all', () => {
    expect(patchLabel('pie\n  "A" : 1', family, 'Nope', 'X')).toEqual({ status: 'unmapped' })
    expect(patchLabel('pie\n  "A" : 1', family, '', 'X')).toEqual({ status: 'unmapped' })
  })
})

describe('parseKanban', () => {
  const source = [
    'kanban',
    '%% a comment',
    '  Todo',
    '    id1[First card]',
    '',
    '    id2((Second card))',
    '  Doing',
    '    id3[Third card]',
    '    id4[Fourth card]@{ shape: rect }',
  ].join('\n')

  it('classifies every line', () => {
    expect(parseKanban(source).lines.map((line) => line.kind)).toEqual([
      'header',
      'comment',
      'column',
      'card',
      'blank',
      'card',
      'column',
      'card',
      'card',
    ])
  })

  it('records column headers in source order', () => {
    expect(parseKanban(source).columns).toEqual([2, 6])
  })

  it('reads card labels out of every supported shape', () => {
    expect(parseKanban(source).cards.map((card) => card.label)).toEqual([
      'First card',
      'Second card',
      'Third card',
      'Fourth card',
    ])
  })

  it('tracks each card position within its column', () => {
    expect(parseKanban(source).cards.map((card) => [card.column, card.index])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ])
  })

  it('leaves a shape mermaid does not strip without a label', () => {
    const doc = parseKanban('kanban\n  Todo\n    id6>Ang Label]')
    expect(doc.cards[0]!.label).toBeNull()
  })

  it('is whitespace agnostic, like mermaid: level is the indent length', () => {
    const doc = parseKanban('kanban\n\tTodo\n\t\tid1[Card]\n\tDoing\n\t\tid2[Other]')
    expect(doc.lines.map((line) => line.kind)).toEqual([
      'header',
      'column',
      'card',
      'column',
      'card',
    ])
    expect(doc.cards.map((card) => [card.column, card.index])).toEqual([
      [0, 0],
      [1, 0],
    ])
  })

  it('treats a node at the first node\'s own indent as a column, not a card', () => {
    // `Todo` / `id1[Card]` at the same level is two columns with no cards at
    // all, which is why nothing is draggable there.
    const doc = parseKanban('kanban\nTodo\nid1[Card]')
    expect(doc.lines.map((line) => line.kind)).toEqual(['header', 'column', 'column'])
    expect(doc.cards).toEqual([])
  })
})

describe('rebuildKanban', () => {
  it('normalises card indentation and keeps every other line verbatim', () => {
    const source = 'kanban\n  Todo\n\tid1[Card]\n  %% indented comment'
    const doc = parseKanban(source)
    const lines = doc.lines.map((line) =>
      line.kind === 'card' ? { ...line, indent: '  ' } : line,
    )
    expect(rebuildKanban(lines)).toBe('kanban\n  Todo\n  id1[Card]\n  %% indented comment')
  })
})

describe('moveKanbanCard', () => {
  const source = [
    'kanban',
    '  Todo',
    '    id1[One]',
    '    id2[Two]',
    '  Doing',
    '    id3[Three]',
  ].join('\n')

  it('moves a card into another column', () => {
    expect(moveKanbanCard(source, 0, 1, 0)).toEqual(
      ['kanban', '  Todo', '    id2[Two]', '  Doing', '    id1[One]', '    id3[Three]'].join('\n'),
    )
  })

  it('moves a card within its own column', () => {
    expect(moveKanbanCard(source, 0, 0, 1)).toEqual(
      ['kanban', '  Todo', '    id2[Two]', '    id1[One]', '  Doing', '    id3[Three]'].join('\n'),
    )
  })

  it('moves a card back up to the top of a column', () => {
    expect(moveKanbanCard(source, 2, 0, 0)).toEqual(
      ['kanban', '  Todo', '    id3[Three]', '    id1[One]', '    id2[Two]', '  Doing'].join('\n'),
    )
  })

  it('keeps comments and blank lines in place', () => {
    const withExtras = ['kanban', '  Todo', '    id1[One]', '  %% note', '  Doing', '    id2[Two]'].join(
      '\n',
    )
    expect(moveKanbanCard(withExtras, 0, 1, 0)).toEqual(
      ['kanban', '  Todo', '  %% note', '  Doing', '    id1[One]', '    id2[Two]'].join('\n'),
    )
  })

  it('reports a no-op move as null', () => {
    expect(moveKanbanCard(source, 0, 0, 0)).toBeNull()
    expect(moveKanbanCard(source, 1, 0, 1)).toBeNull()
    expect(moveKanbanCard(source, 0, 1, 0)).not.toBeNull()
  })

  it('ignores an out-of-range card or column', () => {
    expect(moveKanbanCard(source, 9, 0, 0)).toBeNull()
    expect(moveKanbanCard(source, 0, 9, 0)).toBeNull()
  })
})

// ── DOM behaviour ───────────────────────────────────────────────────────────

interface Harness {
  host: HTMLElement
  preview: HTMLElement
}

function harness(): Harness {
  const host = document.createElement('div')
  host.className = 'mermaid'
  const preview = document.createElement('div')
  preview.className = 'mermaid-preview'
  host.appendChild(preview)
  document.body.appendChild(host)
  return { host, preview }
}

/** A stand-in for the layout jsdom does not compute. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
}

/** The label elements the editing layer marked, in document order. */
function editables(scope: ParentNode): Element[] {
  return Array.from(scope.querySelectorAll('.mermaid-editables'))
}

function input(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('.mermaid-edit-input')
  expect(found).not.toBeNull()
  return found!
}

function typeAndConfirm(value: string, key = 'Enter'): void {
  const field = input()
  field.value = value
  field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('renderDiagram', () => {
  it('renders, decorates and wires up visual editing', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()

    await renderDiagram(preview, 'graph TD\n  A[Alpha]', { host, commit: vi.fn() })

    expect(preview.querySelector('svg')).not.toBeNull()
    expect(preview.querySelectorAll('.mermaid-editables')).toHaveLength(3)
  })

  it('shows the raw source while the first render is in flight', async () => {
    let resolve!: (value: { svg: string }) => void
    hoisted.render.mockReturnValue(new Promise((r) => (resolve = r)) as never)
    const { host, preview } = harness()

    const pending = renderDiagram(preview, 'graph TD', { host })
    expect(preview.textContent).toBe('graph TD')
    resolve({ svg: FLOWCHART_SVG })
    await pending
  })

  it('shows an error block when there is no diagram to fall back to', async () => {
    hoisted.render.mockRejectedValue(new Error('syntax error'))
    const { host, preview } = harness()

    await renderDiagram(preview, 'graph bad', { host })

    expect(preview.querySelector('.mermaid-error')!.textContent).toContain('syntax error')
    expect(host.querySelector('.mermaid-edit-notice')).toBeNull()
  })

  it('keeps the last good diagram and shows a notice when a re-render fails', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, 'graph TD\n  A[Alpha]', { host })
    const rendered = preview.innerHTML

    hoisted.render.mockRejectedValue(new Error('parse error'))
    await renderDiagram(preview, 'graph TD\n  A[', { host })

    expect(preview.innerHTML).toBe(rendered)
    expect(preview.querySelector('.mermaid-error')).toBeNull()
    const notice = host.querySelector<HTMLElement>('.mermaid-edit-notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('keeping the previous version')
    expect(notice!.title).toContain('parse error')
  })

  it('previews without editing when no commit callback is given', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()

    await renderDiagram(preview, 'graph TD\n  A[Alpha]', { host })

    expect(preview.querySelectorAll('.mermaid-editables')).toHaveLength(0)
    // View mode keeps the baked bitmap; only vectors are editable.
    expect(hoisted.bake).toHaveBeenCalled()
  })

  it('keeps the vector unbaked in edit mode, so every label stays reachable', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()

    await renderDiagram(preview, 'graph TD\n  A[Alpha]', { host, commit: vi.fn() })

    expect(hoisted.bake).not.toHaveBeenCalled()
    expect(preview.querySelectorAll('.mermaid-editables').length).toBeGreaterThan(0)
  })
})

describe('label editing', () => {
  const source = 'graph TD\n  A[Alpha]\n  B[Beta]\n  A -->|Yes| B'

  async function renderFlowchart(commit: (next: string) => void): Promise<Harness> {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, source, { host, commit })
    return { host, preview }
  }

  it('edits a node label in place and commits the patched source', async () => {
    const commit = vi.fn()
    const { preview, host } = await renderFlowchart(commit)
    click(editables(preview)[0]!)

    const field = input()
    expect(field.value).toBe('Alpha')
    expect(field.parentElement).toBe(host)
    typeAndConfirm('A1')

    expect(commit).toHaveBeenCalledWith('graph TD\n  A[A1]\n  B[Beta]\n  A -->|Yes| B')
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('edits an edge label', async () => {
    const commit = vi.fn()
    const { preview } = await renderFlowchart(commit)

    click(editables(preview)[2]!)
    typeAndConfirm('No')

    expect(commit).toHaveBeenCalledWith('graph TD\n  A[Alpha]\n  B[Beta]\n  A -->|No| B')
  })

  it('cancels on Escape without committing', async () => {
    const commit = vi.fn()
    const { preview } = await renderFlowchart(commit)

    click(editables(preview)[0]!)
    typeAndConfirm('A1', 'Escape')

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('closes without committing when the text is unchanged', async () => {
    const commit = vi.fn()
    const { preview } = await renderFlowchart(commit)

    click(editables(preview)[0]!)
    typeAndConfirm('Alpha')

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('commits on blur', async () => {
    const commit = vi.fn()
    const { preview } = await renderFlowchart(commit)

    click(editables(preview)[0]!)
    const field = input()
    field.value = 'A1'
    field.dispatchEvent(new Event('blur'))

    expect(commit).toHaveBeenCalledWith('graph TD\n  A[A1]\n  B[Beta]\n  A -->|Yes| B')
  })

  it('keeps the editor up and flashes it red when the edit cannot be mapped', async () => {
    const commit = vi.fn()
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, 'graph TD\n  A -->|Yes| B -->|Yes| C', { host, commit })

    click(editables(preview)[2]!)
    const field = input()
    field.value = 'No'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(commit).not.toHaveBeenCalled()
    expect(field.classList.contains('mermaid-edit-invalid')).toBe(true)
    expect(document.querySelector('.mermaid-edit-input')).not.toBeNull()
  })

  it('opens only one editor at a time', async () => {
    const { preview } = await renderFlowchart(vi.fn())

    click(editables(preview)[0]!)
    click(editables(preview)[1]!)

    expect(document.querySelectorAll('.mermaid-edit-input')).toHaveLength(1)
    expect(input().value).toBe('Beta')
  })

  it('replaces the editing layer on a re-render instead of stacking listeners', async () => {
    const commit = vi.fn()
    const { host, preview } = await renderFlowchart(commit)

    await renderDiagram(preview, source, { host, commit })
    click(editables(preview)[1]!)
    typeAndConfirm('Delta')

    // One click, one commit: the previous render's layer was disposed.
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('graph TD\n  A[Alpha]\n  B[Delta]\n  A -->|Yes| B')
  })

  it('marks only labels that can be mapped back to source', async () => {
    await renderFlowchart(vi.fn())
    // Two node labels and one edge label, all mapped; the wrapper groups and
    // the background rects are not editable.
    expect(document.querySelectorAll('.mermaid-editables')).toHaveLength(3)
    expect(document.querySelectorAll('.mermaid-editables.text')).toHaveLength(0)
  })
})

describe('sequence editing', () => {
  const source = 'sequenceDiagram\n  participant Alice\n  Alice->>Alice: Hello there'

  it('edits a message label', async () => {
    const commit = vi.fn()
    hoisted.render.mockResolvedValue({ svg: SEQUENCE_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, source, { host, commit })

    const svg = preview.querySelector('svg')!
    const message = svg.querySelector('text.messageText')!
    message.getBoundingClientRect = () => rect(10, 70, 100, 20)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)
    click(message)

    typeAndConfirm('Hi there')
    expect(commit).toHaveBeenCalledWith('sequenceDiagram\n  participant Alice\n  Alice->>Alice: Hi there')
  })

  it('edits a participant name, which mermaid wraps in a tspan', async () => {
    const commit = vi.fn()
    hoisted.render.mockResolvedValue({ svg: SEQUENCE_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, source, { host, commit })

    // A native label whose text sits in a <tspan> must not be skipped just
    // because SVG tag names are lowercase.
    const actor = preview.querySelector('text.actor')!
    expect(actor.classList.contains('mermaid-editables')).toBe(true)
    actor.getBoundingClientRect = () => rect(10, 10, 60, 20)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)
    click(actor)

    typeAndConfirm('Bob')
    expect(commit).toHaveBeenCalledWith('sequenceDiagram\n  participant Bob\n  Bob->>Bob: Hello there')
  })

  it('finds the label by its box, so a click beside the text still works', async () => {
    const commit = vi.fn()
    hoisted.render.mockResolvedValue({ svg: SEQUENCE_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, source, { host, commit })

    const svg = preview.querySelector('svg')!
    svg.querySelector('text.actor')!.getBoundingClientRect = () => rect(10, 10, 60, 20)
    const message = svg.querySelector('text.messageText')!
    message.getBoundingClientRect = () => rect(10, 70, 100, 20)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)
    // The click lands on the diagram, not on the glyph: the label underneath
    // the pointer wins, which is also what makes a baked bitmap clickable.
    preview.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0, clientX: 80, clientY: 78 }),
    )

    typeAndConfirm('Hi there')
    expect(commit).toHaveBeenCalledWith('sequenceDiagram\n  participant Alice\n  Alice->>Alice: Hi there')
  })
})

describe('kanban drag', () => {
  const source = ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '    id3[Three]'].join(
    '\n',
  )

  async function renderKanban(
    commit: (next: string) => void,
  ): Promise<{ host: HTMLElement; preview: HTMLElement; svg: SVGSVGElement }> {
    hoisted.render.mockResolvedValue({ svg: KANBAN_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, source, { host, commit })
    const svg = preview.querySelector('svg')!
    const cards = svg.querySelectorAll<SVGElement>('.items > .node')
    cards[0]!.getBoundingClientRect = () => rect(10, 40, 120, 20)
    cards[1]!.getBoundingClientRect = () => rect(10, 70, 120, 20)
    cards[2]!.getBoundingClientRect = () => rect(210, 40, 120, 20)
    svg.querySelectorAll<SVGElement>('.sections > g').forEach((section, index) => {
      section.querySelector('rect')!.getBoundingClientRect = () =>
        index === 0 ? rect(0, 20, 140, 100) : rect(200, 20, 140, 100)
    })
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)
    return { host, preview, svg }
  }

  function pointer(type: string, x: number, y: number): Event {
    const event = new Event(type, { bubbles: true })
    Object.assign(event, { clientX: x, clientY: y, button: 0 })
    return event
  }

  it('moves a card into another column', async () => {
    const commit = vi.fn()
    const { preview, svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 260, 50))
    expect(document.querySelector('.mermaid-drag-card')).not.toBeNull()
    expect(svg.querySelectorAll('.sections > g')[1]!.classList.contains('kanban-drop-target')).toBe(true)
    window.dispatchEvent(pointer('pointerup', 240, 40))

    // Dropped above `id3`, so the card lands first in the column.
    expect(commit).toHaveBeenCalledWith(
      ['kanban', '  Todo', '    id2[Two]', '  Doing', '    id1[One]', '    id3[Three]'].join('\n'),
    )
    expect(document.querySelector('.mermaid-drag-card')).toBeNull()
    expect(preview.querySelectorAll('.mermaid-drag-source')).toHaveLength(0)
  })

  it('cancels the browser\'s own drag so it cannot swallow the pointer', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!

    const start = new Event('dragstart', { bubbles: true, cancelable: true })
    card.dispatchEvent(start)
    expect(start.defaultPrevented).toBe(true)

    // The label editor's own click must survive: preventing pointerdown
    // instead would suppress the click that opens it.
    const label = card.querySelector<SVGElement>('.mermaid-editables')!
    label.getBoundingClientRect = () => rect(10, 40, 120, 20)
    card.dispatchEvent(pointer('pointerdown', 20, 45))
    card.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0, clientX: 20, clientY: 45 }),
    )
    const input = document.querySelector<HTMLInputElement>('.mermaid-edit-input')
    expect(input?.value).toBe('One')
    expect(commit).not.toHaveBeenCalled()
  })

  it('reorders a card inside its own column', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 20, 100))
    window.dispatchEvent(pointer('pointerup', 20, 100))

    expect(commit).toHaveBeenCalledWith(
      ['kanban', '  Todo', '    id2[Two]', '    id1[One]', '  Doing', '    id3[Three]'].join('\n'),
    )
  })

  it('treats a press and release without movement as a click on the card label', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 21, 45))
    window.dispatchEvent(pointer('pointerup', 21, 45))

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-drag-card')).toBeNull()
  })

  it('ignores a drop outside every column', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 600, 400))
    window.dispatchEvent(pointer('pointerup', 600, 400))

    expect(commit).not.toHaveBeenCalled()
  })

  it('does not start a drag when the pointer is cancelled', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 300, 300))
    window.dispatchEvent(pointer('pointercancel', 300, 300))

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-drag-card')).toBeNull()
    expect(svg.querySelectorAll('.sections > g')[0]!.classList.contains('kanban-drop-target')).toBe(false)
  })

  it('edits a card label by clicking it', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    click(editables(svg)[2]!)
    typeAndConfirm('Renamed')

    expect(commit).toHaveBeenCalledWith(
      ['kanban', '  Todo', '    id1[Renamed]', '    id2[Two]', '  Doing', '    id3[Three]'].join('\n'),
    )
  })
})

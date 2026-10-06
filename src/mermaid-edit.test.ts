import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fireResizeCallbacks, flushFrames } from './test-setup'
import {
  addKanbanCard,
  attachMermaidEditing,
  buildKanbanSource,
  detectDiagramType,
  finishMermaidLabelEditing,
  KANBAN_CARD_SLOT,
  KANBAN_COLUMN_SLOT,
  kanbanAuthoringSource,
  kanbanColumnCardCount,
  kanbanRealSource,
  moveKanbanCard,
  moveKanbanColumn,
  parseKanban,
  patchLabel,
  rebuildKanban,
  removeKanbanCard,
  removeKanbanColumn,
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

/** Two edge labels that read the same, as a diagram with two `-->|Yes|` edges has. */
const REPEATED_EDGES_SVG = `<svg>
  <g class="edgeLabels">
    <g class="edgeLabel"><foreignObject width="40" height="20">
      <div class="labelBkg"><span class="edgeLabel"><p class="edgeLabel">Yes</p></span></div>
    </foreignObject></g>
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

  it('renames into a quoted label, and back out of one', () => {
    // The span is the whole quoted run, so a rename keeps the quoting the
    // source had and swaps only the text inside it.
    const plain = 'kanban\n  Todo\n    id1[Plain]'
    expect(patchLabel(plain, family, 'Plain', 'Fix (the bug)')).toEqual(
      ok('kanban\n  Todo\n    id1["Fix (the bug)"]'),
    )
    const quoted = 'kanban\n  Todo\n    id1["Fix (the bug)"]'
    expect(patchLabel(quoted, family, 'Fix (the bug)', 'Renamed')).toEqual(
      ok('kanban\n  Todo\n    id1["Renamed"]'),
    )
  })

  it('renames a hand-written quoted label, the one shape our own quoting writes', () => {
    // A quoted label is the only form mermaid reads a delimiter out of, and it
    // draws it without the quotes, so the label the user clicked is the text
    // inside them — which is what has to be replaced.
    const board = 'kanban\n  Todo\n    ["Ship (v1)"]\n  ["Doing (now)"]'
    expect(patchLabel(board, family, 'Ship (v1)', 'Ship it')).toEqual(
      ok('kanban\n  Todo\n    ["Ship it"]\n  ["Doing (now)"]'),
    )
    expect(patchLabel(board, family, 'Doing (now)', 'Doing (later)')).toEqual(
      ok('kanban\n  Todo\n    ["Ship (v1)"]\n  ["Doing (later)"]'),
    )
  })

  it('renames a quoted entity label, re-escaping the quote it already had', () => {
    // The quoted spelling is kept across a rename, so the replacement has to be
    // escaped on the way in or the quote would close the run it is sitting in.
    const quoted = 'kanban\n  Todo\n    id1["He said &quot;hi&quot;"]'
    expect(patchLabel(quoted, family, 'He said "hi"', 'Bye "now"')).toEqual(
      ok('kanban\n  Todo\n    id1["Bye &quot;now&quot;"]'),
    )
  })

  it('never invents a label for an unterminated quote', () => {
    // `["Half open` says nothing about where the label ends, so the model
    // withholds it rather than offering a rename it cannot place.
    const [card] = parseKanban('kanban\n  Todo\n    ["Half open').cards
    expect(card?.label).toBeNull()
  })

  it('renames a card whose label carries inline markdown', () => {
    // Mermaid draws `*italic*` as <em>, so the clicked text is `italic`;
    // the span to patch is the source's own spelling of it.
    const board = 'kanban\n  Todo\n    id1[*italic*]'
    expect(patchLabel(board, family, 'italic', 'plain')).toEqual(ok('kanban\n  Todo\n    id1[*plain*]'))
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

describe('patchLabel: named things', () => {
  it('renames a state everywhere its transitions refer to it', () => {
    const family: DiagramFamily = 'state'
    const source = ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Busy: start()'].join('\n')
    expect(
      patchLabel(source, family, 'Idle', 'Waiting', { role: 'entity' }),
    ).toEqual(ok(['stateDiagram-v2', '  [*] --> Waiting', '  Waiting --> Busy: start()'].join('\n')))
  })

  it('patches a transition label without touching the states it joins', () => {
    const family: DiagramFamily = 'state'
    const source = 'stateDiagram-v2\n  Idle --> Busy: start()'
    expect(patchLabel(source, family, 'start()', 'go()')).toEqual(
      ok('stateDiagram-v2\n  Idle --> Busy: go()'),
    )
  })

  it('renames an ER entity in its relationships and its own block', () => {
    const family: DiagramFamily = 'er'
    const source = ['erDiagram', '  CUSTOMER ||--o{ ORDER : places', '  CUSTOMER {', '    int id', '  }'].join('\n')
    expect(patchLabel(source, family, 'CUSTOMER', 'CLIENT', { role: 'entity' })).toEqual(
      ok(['erDiagram', '  CLIENT ||--o{ ORDER : places', '  CLIENT {', '    int id', '  }'].join('\n')),
    )
  })

  it('leaves an ER attribute name and its type to their own labels', () => {
    const family: DiagramFamily = 'er'
    const source = 'erDiagram\n  A {\n    int id\n    string name\n  }'
    expect(patchLabel(source, family, 'name', 'label')).toEqual(
      ok('erDiagram\n  A {\n    int id\n    string label\n  }'),
    )
    // `int` is a type shared by the whole diagram, not a label of its own.
    expect(
      patchLabel('erDiagram\n  A {\n    int id\n    int age\n  }', family, 'int', 'integer'),
    ).toEqual({ status: 'ambiguous' })
  })

  it('renames a class in its declaration and its relations', () => {
    const family: DiagramFamily = 'class'
    const source = ['classDiagram', '  class Animal {', '    +String name', '  }', '  Animal <|-- Dog'].join('\n')
    expect(patchLabel(source, family, 'Animal', 'Creature', { role: 'entity' })).toEqual(
      ok(['classDiagram', '  class Creature {', '    +String name', '  }', '  Creature <|-- Dog'].join('\n')),
    )
  })

  it('renames a git branch where it is declared and referenced', () => {
    const family: DiagramFamily = 'git'
    const source = ['gitGraph', '  branch develop', '  checkout develop', '  commit id: "work"'].join('\n')
    expect(patchLabel(source, family, 'develop', 'dev', { role: 'entity' })).toEqual(
      ok(['gitGraph', '  branch dev', '  checkout dev', '  commit id: "work"'].join('\n')),
    )
  })

  it('renames a requirement and the relations that point at it', () => {
    const family: DiagramFamily = 'requirement'
    const source = [
      'requirementDiagram',
      '  requirement api_performance {',
      '    id: 1',
      '  }',
      '  api_service - satisfies -> api_performance',
    ].join('\n')
    expect(patchLabel(source, family, 'api_performance', 'latency', { role: 'entity' })).toEqual(
      ok([
        'requirementDiagram',
        '  requirement latency {',
        '    id: 1',
        '  }',
        '  api_service - satisfies -> latency',
      ].join('\n')),
    )
  })

  it('rewrites a requirement row by its value, not by its drawn key', () => {
    const family: DiagramFamily = 'requirement'
    const source = 'requirementDiagram\n  requirement r {\n    verifymethod: test\n  }'
    // Mermaid draws `verifymethod` as "Verification", so the key on screen is
    // not the key in the source; the value is the only stable part.
    expect(patchLabel(source, family, 'Verification: Test', 'Verification: Review')).toEqual(
      ok('requirementDiagram\n  requirement r {\n    verifymethod: Review\n  }'),
    )
  })

  it('rewrites a requirement value mermaid shortened on screen', () => {
    const family: DiagramFamily = 'requirement'
    const source = 'requirementDiagram\n  requirement r {\n    text: API response time under 100ms\n  }'
    expect(patchLabel(source, family, 'Text: API response time', 'Text: Under 50ms')).toEqual(
      ok('requirementDiagram\n  requirement r {\n    text: Under 50ms\n  }'),
    )
  })

  it('renames a sankey node in every CSV field that names it', () => {
    const family: DiagramFamily = 'sankey'
    const source = ['sankey-beta', '  User,Company,30', '  User,Developer,20'].join('\n')
    expect(patchLabel(source, family, 'User', 'Visitor', { role: 'entity' })).toEqual(
      ok(['sankey-beta', '  Visitor,Company,30', '  Visitor,Developer,20'].join('\n')),
    )
  })

  it('renames a wardley node in its declaration and its links', () => {
    const family: DiagramFamily = 'wardley'
    const source = [
      'wardley-beta',
      'anchor Customer [0.95, 0.63]',
      'component Website [0.80, 0.65]',
      'Customer -> Website',
    ].join('\n')
    expect(patchLabel(source, family, 'Customer', 'Buyer', { role: 'entity' })).toEqual(
      ok([
        'wardley-beta',
        'anchor Buyer [0.95, 0.63]',
        'component Website [0.80, 0.65]',
        'Buyer -> Website',
      ].join('\n')),
    )
  })

  it('renames a venn set in its `set` line and the union', () => {
    const family: DiagramFamily = 'venn'
    const source = ['venn-beta', '  set Dogs', '  set Cats', '  union Dogs,Cats["Both"]'].join('\n')
    expect(patchLabel(source, family, 'Dogs', 'Hounds', { role: 'entity' })).toEqual(
      ok(['venn-beta', '  set Hounds', '  set Cats', '  union Hounds,Cats["Both"]'].join('\n')),
    )
  })

  it('renames the journey actor in every task but not in the title', () => {
    const family: DiagramFamily = 'journey'
    const source = [
      'journey',
      '  title User Onboarding',
      '  section Sign Up',
      '    Sign Up: 5: User',
    ].join('\n')
    expect(patchLabel(source, family, 'User', 'Me', { role: 'entity' })).toEqual(
      ok(['journey', '  title User Onboarding', '  section Sign Up', '    Sign Up: 5: Me'].join('\n')),
    )
  })
})

describe('patchLabel: labels mermaid renders differently', () => {
  const family: DiagramFamily = 'generic'

  it('prefers the quoted spelling of a label over a bare copy of the words', () => {
    // `System` is both the C4 keyword and the name it is drawn under.
    const source = 'C4Context\n  System(sys, "System", "The system")'
    expect(patchLabel(source, family, 'System', 'Core')).toEqual(
      ok('C4Context\n  System(sys, "Core", "The system")'),
    )
  })

  it('matches a label whose whitespace the renderer moved', () => {
    const source = 'timeline\n  section 2024\n    Q1: Initial concept'
    expect(patchLabel(source, family, 'Initial   concept', 'First idea')).toEqual(
      ok('timeline\n  section 2024\n    Q1: First idea'),
    )
  })

  it('matches a label mermaid split across tspans', () => {
    const source = 'ishikawa-beta\n  Root\n    Lack of Training'
    expect(patchLabel(source, family, 'Lack ofTraining', 'Training gaps')).toEqual(
      ok('ishikawa-beta\n  Root\n    Training gaps'),
    )
  })

  it('will not match a phrase that only spans two lines', () => {
    expect(patchLabel('graph TD\n  A[Alpha\n  Beta]', family, 'AlphaBeta', 'X')).toEqual({
      status: 'unmapped',
    })
  })

  it('takes the copy the click named when both sides agree on how many there are', () => {
    const source = 'timeline\n  section 2023\n    Q1: Alpha\n  section 2024\n    Q1: Beta'
    expect(patchLabel(source, family, 'Q1', 'Q4', { occurrence: 1, count: 2 })).toEqual(
      ok('timeline\n  section 2023\n    Q1: Alpha\n  section 2024\n    Q4: Beta'),
    )
  })

  it('refuses when the two sides disagree on how many copies there are', () => {
    const source = 'timeline\n  section 2023\n    Q1: Alpha\n  section 2024\n    Q1: Beta'
    expect(patchLabel(source, family, 'Q1', 'Q4', { occurrence: 0, count: 1 })).toEqual({
      status: 'ambiguous',
    })
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

describe('addKanbanCard', () => {
  const source = [
    'kanban',
    '  Todo',
    '    id1[One]',
    '    id2[Two]',
    '  Doing',
    '    id3[Three]',
  ].join('\n')

  it('appends to a populated column, at the end by default', () => {
    expect(addKanbanCard(source, 0, 99, 'Fresh')).toEqual(
      ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '    [Fresh]', '  Doing', '    id3[Three]'].join(
        '\n',
      ),
    )
  })

  it('inserts at the head and the middle of a column', () => {
    expect(addKanbanCard(source, 0, 0, 'First')).toEqual(
      ['kanban', '  Todo', '    [First]', '    id1[One]', '    id2[Two]', '  Doing', '    id3[Three]'].join(
        '\n',
      ),
    )
    expect(addKanbanCard(source, 0, 1, 'Middle')).toEqual(
      ['kanban', '  Todo', '    id1[One]', '    [Middle]', '    id2[Two]', '  Doing', '    id3[Three]'].join(
        '\n',
      ),
    )
  })

  it('clamps the index at both ends', () => {
    expect(addKanbanCard(source, 1, -5, 'Low')).toBe(addKanbanCard(source, 1, 0, 'Low'))
    expect(addKanbanCard(source, 1, 99, 'Low')).toBe(
      ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '    id3[Three]', '    [Low]'].join(
        '\n',
      ),
    )
  })

  it('puts the first card of an empty column directly under its header', () => {
    const board = ['kanban', '  Todo', '  Doing', '  Done'].join('\n')
    expect(addKanbanCard(board, 2, 0, 'Shipped')).toEqual(
      ['kanban', '  Todo', '  Doing', '  Done', '    [Shipped]'].join('\n'),
    )
  })

  it('reuses the indent the board already uses for cards', () => {
    const board = 'kanban\n\tTodo\n\t\tid1[One]\n\tDoing'
    // An empty column in a tab-indented board, so there is no sibling to copy.
    expect(addKanbanCard(board, 1, 0, 'Fresh')).toBe('kanban\n\tTodo\n\t\tid1[One]\n\tDoing\n\t\t[Fresh]')
    expect(addKanbanCard(board, 0, 99, 'More')).toBe('kanban\n\tTodo\n\t\tid1[One]\n\t\t[More]\n\tDoing')
  })

  it('keeps comments, blank lines and metadata where they were', () => {
    const board = ['kanban', '  Todo', '    id1[One]@{ shape: rect }', '  %% note', '  Doing'].join('\n')
    expect(addKanbanCard(board, 0, 0, 'Fresh')).toBe(
      ['kanban', '  Todo', '    [Fresh]', '    id1[One]@{ shape: rect }', '  %% note', '  Doing'].join('\n'),
    )
  })

  it('refuses an empty label', () => {
    expect(addKanbanCard(source, 0, 0, '')).toBeNull()
    expect(addKanbanCard(source, 0, 0, '   ')).toBeNull()
  })

  it('quotes a label the grammar cannot write bare, and reads it back unquoted', () => {
    // Mermaid reuses the flowchart *shape* delimiters inside a `[…]`, so these
    // have to be quoted — and it draws a quoted label without the quotes, which
    // is what makes the quoted spelling invisible to the user.
    const next = addKanbanCard(source, 0, 0, 'Fix (the bug)')!
    expect(next).toContain('    ["Fix (the bug)"]')
    // The model reads the label the user typed; the span brackets the quoted
    // run around it, which is what a rename replaces.
    const added = parseKanban(next).cards.find((card) => card.label === 'Fix (the bug)')!
    expect(next.slice(added.labelStart, added.labelEnd)).toBe('"Fix (the bug)"')
  })

  it('refuses a label no quoting can carry', () => {
    // A line break is not text at all, and there is no escape for one. Refused
    // before the source is touched, so a card can never be committed that
    // mermaid will not render.
    for (const label of ['one\ntwo', '   ']) {
      expect(addKanbanCard(source, 0, 0, label)).toBeNull()
    }
  })

  it('writes a double quote as an entity, and reads it back as the quote', () => {
    // Mermaid draws a quoted label as the text inside its quotes, so a raw `"`
    // would close the run and the rest of the title would be read as source.
    // `&quot;` is not a quote to the grammar and comes back out as one.
    const next = addKanbanCard(source, 0, 0, 'He said "hi" (loud)')!
    expect(next).toContain('    ["He said &quot;hi&quot; (loud)"]')
    const added = parseKanban(next).cards.find((card) => card.label === 'He said "hi" (loud)')!
    // The span is the whole quoted run, so a rename replaces the entity too.
    expect(next.slice(added.labelStart, added.labelEnd)).toBe('"He said &quot;hi&quot; (loud)"')
  })

  it('escapes an ampersand before the quote, so a literal &quot; stays literal', () => {
    // `&` first: a title holding the literal text `&quot;` must come back as
    // that text and not as a quote.
    const next = addKanbanCard(source, 0, 0, 'the tag &quot;x&quot;')!
    expect(next).toContain('["the tag &amp;quot;x&amp;quot;"]')
    const added = parseKanban(next).cards.find((card) => card.label === 'the tag &quot;x&quot;')!
    expect(added.label).toBe('the tag &quot;x&quot;')
  })


  it('reports an unknown column as null', () => {
    expect(addKanbanCard(source, 9, 0, 'Fresh')).toBeNull()
    expect(addKanbanCard(source, -1, 0, 'Fresh')).toBeNull()
  })

  it('round-trips: the model reports one more card, in the right place', () => {
    for (const [column, index] of [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
    ] as const) {
      const next = addKanbanCard(source, column, index, 'Fresh')!
      expect(next).not.toBeNull()
      const doc = parseKanban(next)
      const at = doc.cards.findIndex((card) => card.label === 'Fresh')
      expect(at).toBeGreaterThanOrEqual(0)
      const card = doc.cards[at]!
      expect([card.column, card.index]).toEqual([column, index])
      expect(doc.cards).toHaveLength(4)
    }
  })
})

describe('removeKanbanCard', () => {
  const source = ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '    id3[Three]'].join('\n')

  it('drops the card and only the card', () => {
    expect(removeKanbanCard(source, 0)).toBe(
      ['kanban', '  Todo', '    id2[Two]', '  Doing', '    id3[Three]'].join('\n'),
    )
    expect(removeKanbanCard(source, 2)).toBe(['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing'].join('\n'))
  })

  it('leaves the comments and blank lines around the card where they were', () => {
    const board = ['kanban', '  Todo', '    id1[One]@{ shape: rect }', '  %% note', '  Doing'].join('\n')
    expect(removeKanbanCard(board, 0)).toBe(
      ['kanban', '  Todo', '  %% note', '  Doing'].join('\n'),
    )
  })

  it('empties a column without touching its header', () => {
    const board = ['kanban', '  Todo', '    id1[One]', '  Doing', '    id2[Two]'].join('\n')
    expect(removeKanbanCard(board, 1)).toBe(['kanban', '  Todo', '    id1[One]', '  Doing'].join('\n'))
  })

  it('reports a card that is not there as null', () => {
    expect(removeKanbanCard(source, 9)).toBeNull()
    expect(removeKanbanCard(source, -1)).toBeNull()
  })
})

describe('removeKanbanColumn', () => {
  const source = [
    'kanban',
    '  Todo',
    '    id1[One]',
    '    id2[Two]',
    '  Doing',
    '    id3[Three]',
    '  Done',
  ].join('\n')

  it('takes the column and every card in it', () => {
    expect(removeKanbanColumn(source, 1)).toBe(
      ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Done'].join('\n'),
    )
    // An empty column goes on its own.
    expect(removeKanbanColumn(source, 2)).toBe(
      ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '    id3[Three]'].join('\n'),
    )
  })

  it('keeps a board with one column, which is the smallest there can be', () => {
    // Nothing to offer the user if this were allowed, so it is refused in the
    // same place the button is not drawn.
    expect(removeKanbanColumn('kanban\n  Todo\n    id1[One]', 0)).toBeNull()
  })

  it('reports a column that is not there as null', () => {
    expect(removeKanbanColumn(source, 9)).toBeNull()
    expect(removeKanbanColumn(source, -1)).toBeNull()
  })

  it('counts the cards a delete would take with it, for the prompt to say', () => {
    expect(kanbanColumnCardCount(source, 0)).toBe(2)
    expect(kanbanColumnCardCount(source, 2)).toBe(0)
  })
})

describe('moveKanbanColumn', () => {
  // Three columns, two cards in the first, an empty middle, a comment written
  // inside the last one and a blank line the user put between two cards.
  const board = [
    'kanban',
    '  col1[Todo]',
    '    id1[One]',
    '',
    '    id2[Two]',
    '  col2[Doing]',
    '  col3[Done]',
    '    id3[Three]',
    '    %% shipped',
  ].join('\n')

  it('takes a column and every card under it to the end of the board', () => {
    expect(moveKanbanColumn(board, 0, 2)).toBe(
      ['kanban', '  col2[Doing]', '  col3[Done]', '    id3[Three]', '    %% shipped', '  col1[Todo]', '    id1[One]', '', '    id2[Two]'].join('\n'),
    )
  })

  it('takes it to the front, the other way round', () => {
    expect(moveKanbanColumn(board, 2, 0)).toBe(
      ['kanban', '  col3[Done]', '    id3[Three]', '    %% shipped', '  col1[Todo]', '    id1[One]', '', '    id2[Two]', '  col2[Doing]'].join('\n'),
    )
  })

  it('inserts between two columns, which is the only way to reorder the middle', () => {
    expect(moveKanbanColumn(board, 2, 1)).toBe(
      ['kanban', '  col1[Todo]', '    id1[One]', '', '    id2[Two]', '  col3[Done]', '    id3[Three]', '    %% shipped', '  col2[Doing]'].join('\n'),
    )
  })

  it('keeps a blank line inside a column with the cards it separates', () => {
    // The grammar is indentation based, so leaving the blank behind would leave
    // `id2` at column level — a column of its own, with the board's shape changed.
    const moved = moveKanbanColumn(board, 0, 2)!
    const doc = parseKanban(moved)
    expect(doc.cards.map((card) => card.label)).toEqual(['Three', 'One', 'Two'])
    expect(doc.columns.length).toBe(3)
    // Both cards of the moved column are still cards, in the column that moved.
    expect(doc.cards.filter((card) => card.column === 2).map((card) => card.label)).toEqual(['One', 'Two'])
  })

  it('rewrites no line\'s text: the same board in a new order', () => {
    const before = parseKanban(board).lines.map((line) => line.indent + line.text).sort()
    const after = moveKanbanColumn(board, 0, 1)!
    expect(parseKanban(after).lines.map((line) => line.indent + line.text).sort()).toEqual(before)
  })

  it('clamps the target into the board, so a release past the end lands at the end', () => {
    expect(moveKanbanColumn(board, 0, 99)).toBe(moveKanbanColumn(board, 0, 2))
    expect(moveKanbanColumn(board, 2, -3)).toBe(moveKanbanColumn(board, 2, 0))
  })

  it('changes nothing when the column is already there, or is not there', () => {
    expect(moveKanbanColumn(board, 1, 1)).toBeNull()
    expect(moveKanbanColumn(board, 9, 0)).toBeNull()
    expect(moveKanbanColumn(board, -1, 0)).toBeNull()
    // A board of one has nowhere to move a column to.
    expect(moveKanbanColumn('kanban\n  Todo\n    id1[One]', 0, 0)).toBeNull()
  })
})

describe('buildKanbanSource', () => {
  it('builds a runnable board from the column names', () => {
    // The de-duplicated name holds parentheses, so it is quoted — mermaid draws
    // it as `Doing (2)` either way, and the quotes are a source detail.
    expect(buildKanbanSource(['Todo', 'Doing', 'Doing'])).toBe(
      'kanban\n  col1[Todo]\n  col2[Doing]\n  col3["Doing (2)"]',
    )
  })

  it('de-duplicates repeated names, since mermaid rejects a repeated node id', () => {
    const source = buildKanbanSource(['Doing', 'Doing', 'Doing', 'Done'])
    expect(source.split('\n').slice(1)).toEqual([
      '  col1[Doing]',
      '  col2["Doing (2)"]',
      '  col3["Doing (3)"]',
      '  col4[Done]',
    ])
  })

  it('emits the id[Name] shape every generated column can be renamed in', () => {
    // A bare word renders, but a name holding `]` does not — and `id[Name]` is
    // the shape `kanbanLabelSpan` maps.
    expect(buildKanbanSource(['In Progress', 'Done'])).toBe(
      'kanban\n  col1[In Progress]\n  col2[Done]',
    )
    expect(parseKanban(buildKanbanSource(['In Progress', 'Done'])).columns).toHaveLength(2)
  })

  it('quotes the names the grammar cannot write bare, and drops what it cannot carry', () => {
    // A column may be called almost anything: a double quote is carried as an
    // entity, and only a line break is dropped so the board still renders.
    expect(buildKanbanSource(['Todo', 'Q3 (launch)', 'x@{ y }', 'Done'])).toBe(
      'kanban\n  col1[Todo]\n  col2["Q3 (launch)"]\n  col3["x@{ y }"]\n  col4[Done]',
    )
    expect(buildKanbanSource(['Todo', 'a"b', 'one\ntwo', 'Done'])).toBe(
      'kanban\n  col1[Todo]\n  col2["a&quot;b"]\n  col3[Done]',
    )
  })

  it('seeds the first column with a card when asked', () => {
    expect(buildKanbanSource(['Todo', 'Done'], { firstCard: 'Write the spec' })).toBe(
      'kanban\n  col1[Todo]\n    [Write the spec]\n  col2[Done]',
    )
    expect(buildKanbanSource(['Todo'], { firstCard: 'a]b' })).toBe(
      'kanban\n  col1[Todo]\n    ["a]b"]',
    )
    expect(buildKanbanSource(['Todo'], { firstCard: 'a"b' })).toBe(
      'kanban\n  col1[Todo]\n    ["a&quot;b"]',
    )
  })

  it('ignores blank lines and surrounding space', () => {
    expect(buildKanbanSource(['  Todo ', '', '   ', 'Done'])).toBe('kanban\n  col1[Todo]\n  col2[Done]')
  })

  it('returns nothing when no column name is usable', () => {
    expect(buildKanbanSource([])).toBe('')
    expect(buildKanbanSource(['', '  '])).toBe('')
    expect(buildKanbanSource(['one\ntwo'])).toBe('')
  })

  it('round-trips through the model: one column per name, labels intact', () => {
    const names = ['Todo', 'In Progress', 'Doing', 'Doing', 'Done']
    const doc = parseKanban(buildKanbanSource(names))
    expect(doc.columns).toHaveLength(names.length)
    expect(doc.lines.filter((line) => line.kind === 'column').map((line) => line.label)).toEqual([
      'Todo',
      'In Progress',
      'Doing',
      'Doing (2)',
      'Done',
    ])
    expect(doc.cards).toEqual([])
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

/**
 * A click *at* something, carrying the coordinates a real one has: a drawn slot
 * is part of the diagram rather than a button on top of it, so it is hit-tested
 * by where the pointer is instead of pressed.
 */
function clickAt(el: Element): void {
  const at = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      button: 0,
      clientX: at.left + at.width / 2,
      clientY: at.top + at.height / 2,
    }),
  )
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

    await renderDiagram(
      preview,
      'graph TD\n  A[Alpha]\n  B[Beta]\n  A -->|Yes| B',
      { host, commit: vi.fn() },
    )

    expect(preview.querySelector('svg')).not.toBeNull()
    expect(preview.querySelectorAll('.mermaid-editables')).toHaveLength(3)
  })

  it('offers no label it could not map back to the source', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()

    // The rendered diagram still shows `Beta` and `Yes`, but this source says
    // nothing about either, so neither may look editable.
    await renderDiagram(preview, 'graph TD\n  A[Alpha]', { host, commit: vi.fn() })

    expect(editables(preview).map((el) => el.textContent?.trim())).toEqual(['Alpha'])
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
    expect(field.parentElement).toBe(host.querySelector('.mermaid-edit-field'))
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

  it('commits a label edit in progress when the diagram stops being edited', async () => {
    const commit = vi.fn()
    const { host, preview } = await renderFlowchart(commit)

    click(editables(preview)[0]!)
    input().value = 'A1'
    // Leaving edit mode resolves the editor rather than walking away from it:
    // the input is a child of the block, so a re-render alone would leave it
    // floating over a diagram that is no longer editable.
    finishMermaidLabelEditing(host)

    expect(commit).toHaveBeenCalledWith('graph TD\n  A[A1]\n  B[Beta]\n  A -->|Yes| B')
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
    expect(editables(preview)).toHaveLength(0)
    // The layer is gone, not merely marked: a second finish is a no-op.
    finishMermaidLabelEditing(host)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('discards a label edit in progress when told to', async () => {
    const commit = vi.fn()
    const { host, preview } = await renderFlowchart(commit)

    click(editables(preview)[0]!)
    input().value = 'A1'
    finishMermaidLabelEditing(host, false)

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
    expect(editables(preview)).toHaveLength(0)
  })

  it('cancels an open editor when a re-render replaces the layer', async () => {
    const commit = vi.fn()
    const { host, preview } = await renderFlowchart(commit)

    click(editables(preview)[0]!)
    input().value = 'A1'
    // The re-render was not asked for by the editor holding a source snapshot
    // that has since moved on, so its value is dropped rather than committed.
    await renderDiagram(preview, source, { host, commit })

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('ignores a finish for a block that has no editing layer', () => {
    const host = document.createElement('div')
    expect(() => finishMermaidLabelEditing(host)).not.toThrow()
    expect(() => finishMermaidLabelEditing(null)).not.toThrow()
    expect(() => finishMermaidLabelEditing(document.createTextNode('x'))).not.toThrow()
  })

  it('withholds a label the source could name in more than one way', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()
    // `Yes` labels two transitions while the diagram shows one edge label, so
    // nothing says which copy the click meant: it is not offered at all.
    await renderDiagram(preview, 'graph TD\n  A -->|Yes| B -->|Yes| C', { host, commit: vi.fn() })

    expect(editables(preview)).toHaveLength(0)
  })

  it('picks the copy a repeated label was clicked for', async () => {
    const commit = vi.fn()
    hoisted.render.mockResolvedValue({ svg: REPEATED_EDGES_SVG })
    const { host, preview } = harness()
    // Two `Yes` transitions and two `Yes` edge labels: the second label on
    // screen is the second transition in the source.
    await renderDiagram(preview, 'graph TD\n  A -->|Yes| B\n  B -->|Yes| C', { host, commit })

    click(editables(preview)[1]!)
    typeAndConfirm('No')

    expect(commit).toHaveBeenCalledWith('graph TD\n  A -->|Yes| B\n  B -->|No| C')
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

/** A node label as mermaid draws HTML labels by default. */
function nodeLabel(
  text: string,
  labelClass = 'label',
  groupClass = 'node default',
): string {
  return (
    `<g class="${groupClass}"><g class="${labelClass}"><foreignObject>` +
    `<div class="labelBkg"><span class="nodeLabel"><p>${text}</p></span></div>` +
    `</foreignObject></g></g>`
  )
}

/** A label mermaid draws as native SVG text. */
function svgLabel(text: string, cls: string, groupClass = ''): string {
  return `<g${groupClass ? ` class="${groupClass}"` : ''}><text class="${cls}">${text}</text></g>`
}

/** The label texts the editing layer offers for a diagram, in document order. */
function offered(inner: string, source: string): string[] {
  const preview = document.createElement('div')
  preview.className = 'mermaid-preview'
  preview.innerHTML = `<svg>${inner}</svg>`
  document.body.appendChild(preview)
  attachMermaidEditing(preview, preview.querySelector('svg')!, source, () => {})
  return editables(preview).map((el) => el.textContent?.trim() ?? '')
}

describe('offered labels', () => {
  it('offers every treemap name but none of its computed totals', () => {
    const source = ['treemap-beta', '"Budget"', '    "Salaries": 500'].join('\n')
    const offeredLabels = offered(
      svgLabel('500', 'treemapSectionValue', 'treemapSection') +
        svgLabel('Budget', 'treemapSectionLabel', 'treemapSection') +
        svgLabel('Salaries', 'treemapLabel', 'treemapNode treemapLeafGroup') +
        svgLabel('500', 'treemapValue', 'treemapNode treemapLeafGroup'),
      source,
    )
    expect(offeredLabels).toEqual(['Budget', 'Salaries'])
  })

  it('offers xy chart categories and the axis title, but not its tick numbers', () => {
    const source = ['xychart-beta', '  x-axis [jan, feb]', '  y-axis "Visitors" 0 --> 100'].join('\n')
    const offeredLabels = offered(
      svgLabel('Visitors', 'title', 'left-axis') +
        svgLabel('0', 'label', 'left-axis') +
        svgLabel('100', 'label', 'left-axis') +
        svgLabel('jan', 'label', 'bottom-axis') +
        svgLabel('feb', 'label', 'bottom-axis'),
      source,
    )
    expect(offeredLabels).toEqual(['Visitors', 'jan', 'feb'])
  })

  it('offers a packet field name but not its bit range', () => {
    const source = 'packet-beta\n  0-15: "Source Port"'
    const offeredLabels = offered(
      svgLabel('0-15', 'packetByte', 'packet') + svgLabel('Source Port', 'packetLabel', 'packet'),
      source,
    )
    expect(offeredLabels).toEqual(['Source Port'])
  })

  it('offers a wardley note and a node, but not the default axes or stages', () => {
    const source = [
      'wardley-beta',
      'title Shop',
      'anchor Customer [0.9, 0.6]',
      'note "Caching helps" [0.4, 0.3]',
    ].join('\n')
    const offeredLabels = offered(
      svgLabel('Evolution', 'wardley-axis-label wardley-axis-label-x', 'wardley-axes') +
        svgLabel('Genesis', 'wardley-stage-label', 'wardley-stages') +
        svgLabel('Customer', 'wardley-node-label', 'wardley-node wardley-node--anchor') +
        svgLabel('Caching helps', '', 'wardley-notes'),
      source,
    )
    expect(offeredLabels).toEqual(['Customer', 'Caching helps'])
  })

  it('offers a requirement name and its rows, but not the stereotype', () => {
    const source = 'requirementDiagram\n  requirement r {\n    risk: high\n  }'
    const offeredLabels = offered(
      nodeLabel('&lt;&lt;Requirement&gt;&gt;') +
        nodeLabel('r') +
        nodeLabel('Risk: High') +
        nodeLabel('&lt;&lt;satisfies&gt;&gt;', 'label', 'edgeLabel'),
      source,
    )
    expect(offeredLabels).toEqual(['r', 'Risk: High'])
  })

  it('seeds a requirement row with the value it replaces, not the drawn row', () => {
    const commit = vi.fn()
    const { host, preview } = harness()
    preview.innerHTML = `<svg>${nodeLabel('Verification: Test')}</svg>`
    const svg = preview.querySelector('svg')!
    const source = 'requirementDiagram\n  requirement r {\n    verifymethod: test\n  }'
    attachMermaidEditing(preview, svg, source, commit)
    const row = editables(svg)[0]!
    row.getBoundingClientRect = () => rect(0, 0, 40, 30)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)

    // The patch replaces the value alone, so the input holds the value: an
    // edit to mermaid's own idea of the key could not be committed.
    click(row)
    expect(input().value).toBe('test')
    typeAndConfirm('review')

    expect(commit).toHaveBeenCalledWith(
      'requirementDiagram\n  requirement r {\n    verifymethod: review\n  }',
    )
  })

  it('offers a C4 label, but not its stereotype', () => {
    const source = 'C4Context\n  System(sys, "System", "The system")'
    const offeredLabels = offered(
      svgLabel('&lt;&lt;system&gt;&gt;', '', 'person-man') +
        svgLabel('System', '', 'person-man') +
        svgLabel('The system', '', 'person-man'),
      source,
    )
    expect(offeredLabels).toEqual(['System', 'The system'])
  })

  it('edits a sankey node by its name, not by the total drawn under it', () => {
    const commit = vi.fn()
    const { host, preview } = harness()
    preview.innerHTML = `<svg>${svgLabel('User\n50', '', 'node-labels')}</svg>`
    const svg = preview.querySelector('svg')!
    const source = 'sankey-beta\n  User,Company,30'
    attachMermaidEditing(preview, svg, source, commit)
    editables(svg)[0]!.getBoundingClientRect = () => rect(0, 0, 40, 30)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)

    // The name and the generated total share one text element; only the name
    // is the label, so only the name goes in the editor.
    click(editables(svg)[0]!)
    expect(input().value).toBe('User')
    typeAndConfirm('Visitor')

    expect(commit).toHaveBeenCalledWith('sankey-beta\n  Visitor,Company,30')
  })

  it('withholds a label the source does not contain at all', () => {
    expect(offered(svgLabel('100', 'label', 'tick'), 'pie\n  "A" : 100')).toEqual([])
    // Not in the source at all: nothing to patch, so nothing to offer.
    expect(offered(svgLabel('Nope', 'label'), 'pie\n  "A" : 1')).toEqual([])
  })

  it('offers an ER entity by name even though the source repeats it', () => {
    const source = [
      'erDiagram',
      '    CUSTOMER ||--o{ ORDER : places',
      '    CUSTOMER {',
      '        int customer_id',
      '    }',
    ].join('\n')
    const offeredLabels = offered(
      nodeLabel('CUSTOMER', 'label name', 'node default') +
        nodeLabel('int', 'label attribute-type', 'node default') +
        nodeLabel('customer_id', 'label attribute-name', 'node default') +
        nodeLabel('places', 'label', 'edgeLabel'),
      source,
    )
    expect(offeredLabels).toEqual(['CUSTOMER', 'int', 'customer_id', 'places'])
  })

  it('offers an ER attribute type that also appears inside another name', () => {
    // `date` is a substring of `order_date`, so a search anywhere in the source
    // would find two copies and withhold the label.
    const source = 'erDiagram\n    ORDER {\n        date order_date\n    }'
    const offeredLabels = offered(
      nodeLabel('date', 'label attribute-type', 'node default') +
        nodeLabel('order_date', 'label attribute-name', 'node default'),
      source,
    )
    expect(offeredLabels).toEqual(['date', 'order_date'])
  })

  it('renames an ER entity everywhere the source names it', () => {
    const commit = vi.fn()
    const source = [
      'erDiagram',
      '    CUSTOMER ||--o{ ORDER : places',
      '    CUSTOMER {',
      '        int customer_id',
      '    }',
    ].join('\n')
    const { host, preview } = harness()
    preview.innerHTML = `<svg>${nodeLabel('CUSTOMER', 'label name', 'node default')}</svg>`
    const svg = preview.querySelector('svg')!
    attachMermaidEditing(preview, svg, source, commit)
    editables(svg)[0]!.getBoundingClientRect = () => rect(0, 0, 60, 20)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)

    click(editables(svg)[0]!)
    typeAndConfirm('BUYER')

    // Both the relationship and the attribute block name the entity.
    expect(commit).toHaveBeenCalledWith(
      source.replace('CUSTOMER ||--o{ ORDER', 'BUYER ||--o{ ORDER').replace('CUSTOMER {', 'BUYER {'),
    )
  })

  it('edits a wrapped label as the source spells it', () => {
    const commit = vi.fn()
    const source = ['ishikawa-beta', '    People', '        Lack of Training'].join('\n')
    const { host, preview } = harness()
    // Mermaid wraps a long label across tspans, so the DOM reads the two words
    // with the space dropped where the source has one.
    preview.innerHTML =
      '<svg><g class="ishikawa-sub-group">' +
      '<text class="ishikawa-label align"><tspan>Lack of</tspan><tspan>Training</tspan></text>' +
      '</g></svg>'
    const svg = preview.querySelector('svg')!
    attachMermaidEditing(preview, svg, source, commit)
    editables(svg)[0]!.getBoundingClientRect = () => rect(0, 0, 90, 20)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)

    // The editor offers the source's own spelling, not the rendering's.
    click(editables(svg)[0]!)
    expect(input().value).toBe('Lack of Training')
    typeAndConfirm('Skill gap')

    expect(commit).toHaveBeenCalledWith(
      'ishikawa-beta\n    People\n        Skill gap',
    )
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
    stubSvgFrame(svg)
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

  function dropLine(): SVGLineElement | null {
    return document.querySelector('.mermaid .kanban-drop-line')
  }

  /** The line's ends in the drawing's own units, which at 1:1 are its pixels. */
  function lineSpan(): { from: number; to: number; y: number } {
    const line = dropLine()!
    return {
      from: Number(line.getAttribute('x1')),
      to: Number(line.getAttribute('x2')),
      y: Number(line.getAttribute('y1')),
    }
  }

  /** The svg is drawn at 1:1 in this fixture, so its frame is the origin. */
  function stubSvgFrame(svg: SVGSVGElement): void {
    svg.getBoundingClientRect = () => rect(0, 0, 800, 600)
  }

  it('moves the real card under the pointer, with no second copy on screen', async () => {
    const commit = vi.fn()
    const { preview, svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!
    const base = card.getAttribute('transform')

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 260, 50))

    // The card that is under the pointer *is* the card, moved: no clone, and
    // the drag is on the original element rather than on a copy of its text.
    expect(document.querySelectorAll('.mermaid-drag-card')).toHaveLength(0)
    expect(card.classList.contains('kanban-dragging-card')).toBe(true)
    expect(card.getAttribute('transform')).toBe('translate(240, 5) scale(1.04)')
    expect(card.querySelector('.mermaid-editables')?.textContent).toBe('One')
    // It paints last, so it is on top of the board it is passing over.
    expect(card.parentElement?.lastElementChild).toBe(card)

    // The release acts on the pointer's column, which is the one that is marked,
    // and the line is inside the svg ahead of the cards, so the dragged card
    // paints over the indicator rather than the other way round.
    expect(svg.querySelectorAll('.sections > g')[1]!.classList.contains('kanban-drop-target')).toBe(true)
    expect(dropLine()!.parentElement).toBe(svg)
    expect(dropLine()!.nextElementSibling?.classList.contains('items')).toBe(true)

    window.dispatchEvent(pointer('pointerup', 240, 40))

    // Dropped above `id3`, so the card lands first in the column.
    expect(commit).toHaveBeenCalledWith(
      ['kanban', '  Todo', '    id2[Two]', '  Doing', '    id1[One]', '    id3[Three]'].join('\n'),
    )
    // Nothing of the drag survives it: the line, the lift, the class on the
    // preview that un-clips the board, and the card's own transform and order.
    expect(dropLine()).toBeNull()
    expect(card.classList.contains('kanban-dragging-card')).toBe(false)
    expect(card.getAttribute('transform')).toBe(base)
    expect(preview.classList.contains('kanban-dragging')).toBe(false)
    expect(svg.querySelectorAll('.items > .node')[0]).toBe(card)
    expect(svg.querySelectorAll('.sections > g')[1]!.classList.contains('kanban-drop-target')).toBe(false)
  })

  it('scales the card offset back into the viewBox so it tracks the pointer', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    // Mermaid scales the board down to fit its container, so the svg is drawn
    // smaller than the viewBox it was laid out in.
    svg.setAttribute('viewBox', '0 0 200 120')
    svg.getBoundingClientRect = () => rect(0, 0, 400, 240)
    const card = svg.querySelectorAll('.items > .node')[0]!

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 140, 65))

    // 120 screen pixels is 60 user units, not 120: the card lands under the
    // pointer instead of running off twice as far.
    expect(card.getAttribute('transform')).toBe('translate(60, 10) scale(1.04)')
  })

  it('draws the line in the gap the card will drop into', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!
    // Cards 0 and 1 sit at y 40..60 and 70..90, and their column's band is
    // y 20..120, x 0..140. The line overhangs the band by a little on each side,
    // so it still shows either side of the card that covers it.
    const band = { from: -4, to: 144 }

    card.dispatchEvent(pointer('pointerdown', 20, 45))

    // Over the top of the column: the first gap, above the card left behind.
    window.dispatchEvent(pointer('pointermove', 20, 30))
    expect(lineSpan()).toEqual({ ...band, y: 65 })
    expect(dropLine()!.style.display).not.toBe('none')

    // Past the middle of the other card: the gap below it.
    window.dispatchEvent(pointer('pointermove', 20, 95))
    expect(lineSpan().y).toBe(95)

    // Into the other column, above its single card: that column's own first gap,
    // so the line moves across with the target rather than stretching to fit.
    window.dispatchEvent(pointer('pointermove', 260, 35))
    expect(lineSpan()).toEqual({ from: 196, to: 344, y: 35 })

    // Off the board entirely there is nowhere to land, so nothing is promised.
    window.dispatchEvent(pointer('pointermove', 700, 500))
    expect(dropLine()!.style.display).toBe('none')
  })

  it('centres the line in an empty column, which has no gap to slot into', async () => {
    const commit = vi.fn()
    // An empty column is drawn as a band sized to its header alone, which is
    // what leaves it with no card to measure a gap against.
    const emptyColumnSource = ['kanban', '  Todo', '    id1[One]', '  Done'].join('\n')
    const card = '<g class="node default"><rect /><g class="label"></g></g>'
    const section = '<g class="cluster section-x"><rect /><g class="cluster-label"></g></g>'
    hoisted.render.mockResolvedValue({ svg: `<svg><g class="sections">${section}${section}</g>` +
      `<g class="items">${card}</g></svg>` })
    const { host, preview } = harness()
    await renderDiagram(preview, emptyColumnSource, { host, commit })
    const svg = preview.querySelector('svg')!
    stubSvgFrame(svg)
    svg.querySelectorAll<SVGElement>('.sections > g').forEach((band, index) => {
      band.querySelector('rect')!.getBoundingClientRect = () => (index === 0 ? rect(0, 20, 140, 100) : rect(400, 20, 140, 50))
    })
    const dragged = svg.querySelector('.items > .node')!
    dragged.getBoundingClientRect = () => rect(10, 40, 120, 20)
    host.getBoundingClientRect = () => rect(0, 0, 800, 600)

    dragged.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 460, 45))

    // The middle of the band is where a card dropped here would appear.
    expect(lineSpan()).toEqual({ from: 396, to: 544, y: 45 })
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
    expect(dropLine()).toBeNull()
    expect(card.classList.contains('kanban-dragging-card')).toBe(false)
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
    const { preview, svg } = await renderKanban(commit)
    const card = svg.querySelectorAll('.items > .node')[0]!
    const base = card.getAttribute('transform')

    card.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 300, 300))
    window.dispatchEvent(pointer('pointercancel', 300, 300))

    expect(commit).not.toHaveBeenCalled()
    expect(dropLine()).toBeNull()
    expect(card.classList.contains('kanban-dragging-card')).toBe(false)
    expect(card.getAttribute('transform')).toBe(base)
    expect(preview.classList.contains('kanban-dragging')).toBe(false)
    // Its place in the sibling list is back too: a card left painted last would
    // be the wrong one for the next drag, whose index→element mapping is a walk.
    expect(svg.querySelectorAll('.items > .node')[0]).toBe(card)
    expect(svg.querySelectorAll('.sections > g')[0]!.classList.contains('kanban-drop-target')).toBe(false)
  })

  it('lifts a column whole, without growing it', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    // The frame and the two cards standing in it are the column, and they are
    // three elements in two sibling lists, so all three lift together.
    const section = svg.querySelectorAll('.sections > g')[0]!
    const base = section.getAttribute('transform')

    section.dispatchEvent(pointer('pointerdown', 70, 110))
    window.dispatchEvent(pointer('pointermove', 400, 150))

    // A card is one `g` and grows a little to say it is in the air. A column is
    // a *frame with a padding and cards inside it*: scaling the frame about its
    // own origin — SVG transforms scale there, not about the board — pushed the
    // cards out of it, and a column that is a different size while it is held is
    // a column being moved somewhere other than where it was dropped.
    expect(section.getAttribute('transform')).toBe('translate(330, 40)')
    expect(base).toBeNull()
    // The two cards standing in it, addressed by the ids the fixture gave them:
    // a lift re-appends what it lifted (to paint it last), so the sibling list is
    // in a different order now than the model's, and an index into it is only
    // still an index because the lift is the thing that moved.
    for (const id of ['#K1', '#K2']) {
      const card = svg.querySelector(id)!
      expect(card.getAttribute('transform')).toContain('translate(330, 40)')
      expect(card.getAttribute('transform')).not.toContain('scale')
    }
    // The card in the other column is not part of this lift and stays where it was.
    expect(svg.querySelector('#K3')!.getAttribute('transform')).toBeNull()
  })

  it('holds a column in a group of its own, above every card on the board', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const section = svg.querySelectorAll('.sections > g')[0]!

    section.dispatchEvent(pointer('pointerdown', 70, 110))
    window.dispatchEvent(pointer('pointermove', 400, 150))

    // The board is two sibling lists — frames in `.sections`, cards in `.items`,
    // the frames first — and svg paints in document order, so a frame re-appended
    // to the end of `.sections` is over the other *frames* and under every card
    // in `.items`. That is a column in flight drawn with its neighbours' cards
    // lying across it, which is also how a neighbour's cards come to look like
    // cards the held column picked up. A thing that is not one element cannot be
    // put on top by where one element sits, so the whole set is held in a group
    // of its own, appended last: frame first, then the cards it carries.
    const layer = svg.querySelector('.kanban-drag-layer')!
    expect(layer).not.toBeNull()
    expect(layer.parentElement).toBe(svg)
    expect(svg.lastElementChild).toBe(layer)
    expect([...layer.children]).toEqual([section, svg.querySelector('#K1'), svg.querySelector('#K2')])
    // The card that stays on the board is not in there, and neither is the other
    // column's frame: the group is this column, not the front of the board.
    expect(layer.querySelector('#K3')).toBeNull()
    expect(svg.querySelector('#K3')!.parentElement!.classList.contains('items')).toBe(true)
    // The indicator is still under the held column, the way a card's is: it is
    // inserted before `.sections`, and the group is appended after it.
    expect(dropLine()!.parentElement).toBe(svg)
    expect(
      dropLine()!.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    window.dispatchEvent(pointer('pointerup', 400, 150))

    // Nothing of it survives: every element is back in its own list, in its own
    // place, and the group is gone rather than left empty on the board.
    for (const selector of ['#K1', '#K2']) {
      expect(svg.querySelector(selector)!.parentElement!.classList.contains('items')).toBe(true)
    }
    expect(svg.querySelector('.sections > g')!.parentElement!.classList.contains('sections')).toBe(true)
    expect(svg.querySelector('.kanban-drag-layer')).toBeNull()
    expect(svg.querySelectorAll('.items > .node')[0]).toBe(svg.querySelector('#K1'))
  })

  it('holds an empty column with its own slot and nothing else', async () => {
    // The shape that read as a column collecting other columns' cards: the last
    // column is empty, so the only thing standing in it is the drawn card slot,
    // and a lift that took the cards *near* it rather than the ones the model
    // says are in it would carry a neighbour's card across the board.
    const commit = vi.fn()
    const source = ['kanban', '  Todo', '    [One]', '  Doing', '  Done'].join('\n')
    const { svg } = await renderKanbanBoard(
      commit,
      source,
      boardSvg(
        ['Todo', 'Doing', 'Done', KANBAN_COLUMN_SLOT],
        ['One', KANBAN_CARD_SLOT, KANBAN_CARD_SLOT, KANBAN_CARD_SLOT, KANBAN_CARD_SLOT],
      ),
      [
        rect(0, 20, 140, 110),
        rect(200, 20, 140, 80),
        rect(400, 20, 140, 80),
        rect(600, 20, 140, 80),
      ],
      [
        rect(10, 40, 120, 24),
        rect(10, 68, 120, 24),
        rect(210, 40, 120, 24),
        rect(410, 40, 120, 24),
        rect(610, 40, 120, 24),
      ],
    )
    // The elements are taken by hand *before* the lift: the lift moves them out
    // of the lists it is found by, which is the point of it.
    const done = svg.querySelectorAll('.sections > g')[2]!
    const [, , itsSlot] = cardSlots(svg)

    done.dispatchEvent(pointer('pointerdown', 470, 110))
    window.dispatchEvent(pointer('pointermove', 200, 200))

    // The empty column is a frame and one slot, and the slot is its own.
    const layer = svg.querySelector('.kanban-drag-layer')!
    expect([...layer.children]).toEqual([done, itsSlot])
    expect(layer.querySelector('.mermaid-kanban-card-remove')).toBeNull()
    // Everything else is still in `.items`, where it belongs: the rest of the
    // board's cards under the held column's own slot, which is in the air above
    // them — and the drawn column at the end, whose own slot is in a column this
    // drag is not holding.
    const left = [...svg.querySelectorAll('.items > g.node')]
    expect(left).toHaveLength(4)
    expect(left).not.toContain(itsSlot)
    expect(layer.textContent).not.toContain('One')
  })

  it('draws the column line under the frames, not over them', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const section = svg.querySelectorAll('.sections > g')[0]!

    section.dispatchEvent(pointer('pointerdown', 70, 110))
    window.dispatchEvent(pointer('pointermove', 400, 150))

    // SVG paints in document order and `.sections` comes before `.items`, so a
    // line in front of both draws straight across the column it is previewing —
    // and across every card still in it. It belongs behind the frames: a rule
    // the column is *next to* is one the column does not hide.
    const line = dropLine()!
    const sections = svg.querySelector('.sections')!
    expect(line.nextElementSibling).toBe(sections)
    expect(line.compareDocumentPosition(sections)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps the column line the height of the board, whatever the pointer does', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanban(commit)
    const section = svg.querySelectorAll('.sections > g')[0]!

    section.dispatchEvent(pointer('pointerdown', 70, 110))
    window.dispatchEvent(pointer('pointermove', 400, 150))
    const bottom = Number(dropLine()!.getAttribute('y2'))

    // Dragged up over the toolbar, then back down. The rule's length is the
    // board's, measured off the columns that are *not* moving — taking it from
    // the lifted one made the line grow with the pointer, off the top of the
    // board and out over the toolbar, which the drag's un-clipped overflow lets
    // it do. A rule that changes length as you move means nothing by its ends.
    window.dispatchEvent(pointer('pointermove', 400, -40))
    expect(Number(dropLine()!.getAttribute('y2'))).toBe(bottom)
    window.dispatchEvent(pointer('pointermove', 400, 150))
    expect(Number(dropLine()!.getAttribute('y2'))).toBe(bottom)
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

// A board with an empty middle column: mermaid still draws one, as a shorter
// band, which is what makes a per-column ＋ work for it — and its cards are laid
// out inside their own column's band, narrower than it.
const BOARD_SOURCE = [
  'kanban',
  '  Todo',
  '    id1[One]',
  '    id2[Two]',
  '  Doing',
  '  Done',
  '    id3[Three]',
].join('\n')

const BOARD_BANDS = [
  rect(0, 20, 140, 110),
  rect(200, 20, 140, 80),
  rect(400, 20, 140, 80),
  rect(600, 20, 140, 80),
]
const BOARD_CARD_RECTS = [
  rect(10, 40, 120, 24),
  rect(10, 68, 120, 24),
  rect(10, 96, 120, 24),
  rect(210, 50, 120, 24),
  rect(410, 40, 120, 24),
  rect(410, 68, 120, 24),
  rect(610, 50, 120, 24),
]

function kanbanCard(label: string): string {
  return `<g class="node default"><rect /><g class="label"><foreignObject><div class="labelBkg">` +
    `<span class="nodeLabel"><p>${label}</p></span></div></foreignObject></g></g>`
}

function kanbanSection(name: string): string {
  return `<g class="cluster section-x"><rect /><g class="cluster-label"><foreignObject><div class="labelBkg">` +
    `<span class="nodeLabel"><p>${name}</p></span></div></foreignObject></g></g>`
}

/** A board as mermaid draws it: one band per column, then one node per card. */
function boardSvg(columns: string[], cards: string[]): string {
  return `<svg><g class="sections">${columns.map(kanbanSection).join('')}</g>` +
    `<g class="items">${cards.map(kanbanCard).join('')}</g></svg>`
}

/** The three cards, then the drawn slot of each column, in the order mermaid
 *  walks them: column by column, top to bottom, with the new column last — and
 *  the new column is a column like any other, so it has a card slot of its own
 *  (which is the bin a card is dropped on to be deleted). */
const BOARD_SVG = boardSvg(
  ['Todo', 'Doing', 'Done', KANBAN_COLUMN_SLOT],
  ['One', 'Two', KANBAN_CARD_SLOT, KANBAN_CARD_SLOT, 'Three', KANBAN_CARD_SLOT, KANBAN_CARD_SLOT],
)

/**
 * Render a board in edit mode with its geometry filled in, which jsdom will not
 * compute: every band and card gets the rect it would have on screen, and the
 * layer is attached a second time now that the layer knows them. A real render
 * already has them in that order.
 *
 * A real edit-mode render is the board *drawn with its slots* and every patch is
 * made against that, so this does the same and hands the commit the real source
 * back, exactly as the node view does — the document never holds a slot.
 */
async function renderKanbanBoard(
  commit: (next: string) => void,
  source = BOARD_SOURCE,
  svgSource = BOARD_SVG,
  bands = BOARD_BANDS,
  cardRects = BOARD_CARD_RECTS,
): Promise<{ host: HTMLElement; preview: HTMLElement; svg: SVGSVGElement }> {
  hoisted.render.mockResolvedValue({ svg: svgSource })
  const { host, preview } = harness()
  const drawn = kanbanAuthoringSource(source)
  const real = (patched: string): void => commit(kanbanRealSource(patched))
  await renderDiagram(preview, drawn, { host, commit: real })
  const svg = preview.querySelector('svg')!
  svg.querySelectorAll<SVGElement>('.sections > g').forEach((band, index) => {
    band.querySelector('rect')!.getBoundingClientRect = () => bands[index]!
    // The band itself reports the same box, which is what a press anywhere in it
    // and the field that stands in it are both measured against.
    band.getBoundingClientRect = () => bands[index]!
  })
  svg.querySelectorAll<SVGElement>('.items > g.node').forEach((node, index) => {
    node.getBoundingClientRect = () => cardRects[index]!
  })
  preview.getBoundingClientRect = () => rect(0, 10, 800, 600)
  attachMermaidEditing(preview, svg, drawn, real)
  return { host, preview, svg }
}

/** The drawn card slots, in the order the board's columns hold them. */
function cardSlots(svg: SVGSVGElement): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('.items > g.node.mermaid-kanban-slot'))
}

function columnSlot(svg: SVGSVGElement): SVGElement {
  return svg.querySelector<SVGElement>('.sections > g.mermaid-kanban-column-slot')!
}

describe('kanban drawn slots', () => {
  it('draws a card slot in every column and a column at the end of the board', async () => {
    const { svg } = await renderKanbanBoard(vi.fn())

    // The slots are the board as it is drawn in edit mode, and nothing else: the
    // same board with a card slot at the end of each column and a new column
    // after the last one. They are part of what mermaid lays out, so a card slot
    // is in the next card's own place and the new column is as tall and as wide
    // as a real one.
    expect(kanbanAuthoringSource(BOARD_SOURCE)).toBe(
      [
        'kanban',
        '  Todo',
        '    id1[One]',
        '    id2[Two]',
        '    slotc0[+ Add a card]',
        '  Doing',
        '    slotc1[+ Add a card]',
        '  Done',
        '    id3[Three]',
        '    slotc2[+ Add a card]',
        '  slotn[+ Add a column]',
        '    slotc3[+ Add a card]',
      ].join('\n'),
    )
    expect(cardSlots(svg)).toHaveLength(4)
    expect(columnSlot(svg)).not.toBeNull()
  })

  it('never holds a slot in the document, however the board is edited', () => {
    // The source the document keeps is the board, exactly as it was written.
    expect(kanbanRealSource(kanbanAuthoringSource(BOARD_SOURCE))).toBe(BOARD_SOURCE)
    // A card typed into a slot is content, and its slot id is not committed.
    expect(
      kanbanRealSource(kanbanAuthoringSource(BOARD_SOURCE).replace('slotc1[+ Add a card]', '[Fresh]')),
    ).toBe(['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '    [Fresh]', '  Done', '    id3[Three]'].join('\n'))
    // And a column named where the new one was drawn becomes a real column.
    expect(
      kanbanRealSource(kanbanAuthoringSource(BOARD_SOURCE).replace('slotn[+ Add a column]', 'slotn[Archive]')),
    ).toBe(['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '  Done', '    id3[Three]', '  col1[Archive]'].join('\n'))
  })

  it('gives a column named in a slot an id nothing on the board already uses', () => {
    // The new column is a header like any other, and an id is what ties a card to
    // the column above it, so a duplicate is not a cosmetic slip. `col3` is a card
    // on this board and `col1` a column: the new column has to step over both.
    const board = ['kanban', '  col1[Todo]', '    col3[One]', '  Doing'].join('\n')
    const next = kanbanRealSource(kanbanAuthoringSource(board).replace('slotn[+ Add a column]', 'slotn[Review]'))
    expect(next).toBe(['kanban', '  col1[Todo]', '    col3[One]', '  Doing', '  col2[Review]'].join('\n'))
  })

  it('quotes a column name the grammar cannot write bare, and reads it back', () => {
    // The label editor holds the quoting rule for every path that writes a title,
    // a named slot included: `Q3 (launch)` is a name the user can type, and
    // `Q3 (launch)` is what the board has to draw afterwards.
    const next = kanbanRealSource(
      kanbanAuthoringSource(BOARD_SOURCE).replace('slotn[+ Add a column]', 'slotn[Q3 (launch)]'),
    )
    expect(next).toContain('  col1["Q3 (launch)"]')
    expect(parseKanban(next).lines[parseKanban(next).columns[3]!]!.label).toBe('Q3 (launch)')
  })

  it('types a title in the slot that was pressed, in the slot own place', async () => {
    const { svg } = await renderKanbanBoard(vi.fn())

    clickAt(cardSlots(svg)[1]!)
    const field = input()
    expect(field.placeholder).toBe('Card title')
    // The field stands exactly where the slot is, which is what makes the slot
    // read as turning into a card rather than as opening a field elsewhere. The
    // preview sits 10px down the block, so a slot at y=50 is y=40 in it.
    const box = document.querySelector<HTMLElement>('.mermaid-edit-field')!
    expect(box.style.left).toBe('210px')
    expect(box.style.top).toBe('40px')
    // Nothing is said above the field: the slot it fills already says what it is,
    // and a heading that repeated it was a caption explaining the obvious. The
    // field is the input and nothing else, so a second child would be a caption.
    expect(box.children.length).toBe(1)
    // A field that is about to *add* is drawn as one, not as a rename.
    expect(box.className).toContain('mermaid-edit-field-new')
  })

  it('creates the card in the column its slot is in, and the board keeps its slots', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)

    clickAt(cardSlots(svg)[1]!)
    typeAndConfirm('Fresh')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(
      ['kanban', '  Todo', '    id1[One]', '    id2[Two]', '  Doing', '    [Fresh]', '  Done', '    id3[Three]'].join(
        '\n',
      ),
    )
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('leaves the board alone on Esc', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)

    clickAt(cardSlots(svg)[0]!)
    typeAndConfirm('Discarded', 'Escape')

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('accepts a title holding a delimiter, quoting it in the source', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)

    clickAt(cardSlots(svg)[0]!)
    typeAndConfirm('Fix (the bug)')

    // The card lands; the quotes are how the source spells it, not what the
    // user typed, and mermaid draws it without them.
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![0]).toContain('    ["Fix (the bug)"]')
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('refuses a title no quoting can carry, and says so', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)

    clickAt(cardSlots(svg)[0]!)
    typeAndConfirm('one\ntwo')

    // Flashed, not silently dropped — and the board is untouched.
    expect(input().classList.contains('mermaid-edit-invalid')).toBe(true)
    expect(commit).not.toHaveBeenCalled()
  })

  it('is not a label, so a card slot is never offered for renaming', async () => {
    const { svg } = await renderKanbanBoard(vi.fn())
    // A card slot is a place to add a card rather than a card to re-title, so it
    // is not one of the diagram's editable labels...
    expect(editables(svg).map((el) => el.textContent?.trim())).toEqual([
      'Todo',
      'Doing',
      'Done',
      KANBAN_COLUMN_SLOT,
      'One',
      'Two',
      'Three',
    ])
    // ...while the new column is a header like any other, and is named by
    // renaming it, which is the same editor editing any other label.
    expect(columnSlot(svg).querySelector(`.${'mermaid-editables'}`)).not.toBeNull()
  })

  it('names the new column through its own header, and the board keeps it', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)
    const header = columnSlot(svg).querySelector<HTMLElement>('.mermaid-editables')!

    // The name is typed where the board is drawn, and the field is *empty*: the
    // label on a drawn slot is a place to put a name, not a name to retype, so
    // seeding the field with it would make typing one a matter of selecting what
    // is already there first. A card's composer has always started this way.
    click(header)
    const field = document.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Column name')
    // Drawn as a field that *adds*, rather than one that overwrites a name the
    // user did not write.
    expect(document.querySelector('.mermaid-edit-field')!.className).toContain('mermaid-edit-field-new')
    typeAndConfirm('Archive')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(
      [
        'kanban',
        '  Todo',
        '    id1[One]',
        '    id2[Two]',
        '  Doing',
        '  Done',
        '    id3[Three]',
        '  col1[Archive]',
      ].join('\n'),
    )
  })

  it('opens the same empty field from anywhere in the drawn column', async () => {
    const { svg } = await renderKanbanBoard(vi.fn())
    const band = columnSlot(svg)

    // The label on the slot is where the eye goes, and the empty band around it
    // is where the pointer usually lands. One field for both: empty, one line,
    // standing in the band.
    clickAt(band)
    const fromBand = document.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    expect(fromBand.value).toBe('')
    expect(fromBand.placeholder).toBe('Column name')
    // Standing in the band: the slot column is the fourth, at x 600, and the
    // preview the field is placed from sits 10px down (the block's own inset), so
    // the band's y 20 is 10 in it.
    const box = document.querySelector<HTMLElement>('.mermaid-edit-field')!
    expect(box.style.left).toBe('600px')
    expect(box.style.top).toBe('10px')

    // Esc, so the second press starts from a closed field rather than replacing
    // the one the first opened.
    document.querySelector<HTMLInputElement>('.mermaid-edit-input')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    clickAt(columnSlot(svg).querySelector<HTMLElement>('.mermaid-editables')!)
    expect(document.querySelector<HTMLInputElement>('.mermaid-edit-input')!.value).toBe('')

    // And the card slot it is drawn with, which is a place to add a card in every
    // other column and is *not* one here: this column does not exist yet, so it
    // has no list to put a card in and the press is the column's name to answer.
    document.querySelector<HTMLInputElement>('.mermaid-edit-input')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    const slots = cardSlots(svg)
    clickAt(slots[slots.length - 1]!)
    const fromCard = document.querySelector<HTMLInputElement>('.mermaid-edit-input')!
    expect(fromCard.value).toBe('')
    expect(fromCard.placeholder).toBe('Column name')
  })

  it('refuses a new column with no name, and says so', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)

    clickAt(columnSlot(svg))
    // Enter on an empty field: there is no name to write down, and a column with
    // none is not a column — so it is refused with the reason, exactly as an
    // empty card title is, rather than committed as a header with nothing in it.
    typeAndConfirm('')
    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')!.classList.contains('mermaid-edit-invalid')).toBe(true)
  })

  it('never arms the card drag on a press in a slot', async () => {
    const { svg } = await renderKanbanBoard(vi.fn())
    const slot = cardSlots(svg)[0]!
    const at = slot.getBoundingClientRect()
    slot.dispatchEvent(
      Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
        clientX: at.left + 10,
        clientY: at.top + 10,
        button: 0,
      }),
    )
    window.dispatchEvent(
      Object.assign(new Event('pointermove', { bubbles: true }), {
        clientX: at.left - 40,
        clientY: at.top - 10,
        button: 0,
      }),
    )

    // A slot is a place, not a card: the press asks for a title and lifts
    // nothing — and it does not fall through to the column drag either.
    expect(document.querySelector('.kanban-drop-line')).toBeNull()
    expect(document.querySelector(`.${'kanban-dragging'}`)).toBeNull()
  })

  it('goes away with the layer, and comes back with the next render', async () => {
    const { host, preview, svg } = await renderKanbanBoard(vi.fn())
    expect(cardSlots(svg)).toHaveLength(4)

    finishMermaidLabelEditing(host, false)
    expect(preview.querySelectorAll('.mermaid-edit-field')).toHaveLength(0)
    expect(preview.querySelectorAll('.mermaid-kanban-btn')).toHaveLength(0)

    await renderDiagram(preview, kanbanAuthoringSource(BOARD_SOURCE), { host, commit: vi.fn() })
    expect(cardSlots(preview.querySelector('svg')!)).toHaveLength(4)
  })

  it('draws no slots on a diagram that is not a board', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, 'graph TD\n  A[Alpha]\n  B[Beta]', { host, commit: vi.fn() })

    expect(preview.querySelectorAll('.mermaid-kanban-slot')).toHaveLength(0)
    expect(kanbanAuthoringSource('graph TD\n  A[Alpha]\n  B[Beta]')).toBe('graph TD\n  A[Alpha]\n  B[Beta]')
  })
})

describe('kanban bin', () => {
  function pointer(type: string, x: number, y: number): Event {
    const event = new Event(type, { bubbles: true })
    Object.assign(event, { clientX: x, clientY: y, button: 0 })
    return event
  }

  /** The bin: the card slot drawn in the column at the end of the board. */
  function binCard(svg: SVGSVGElement): SVGElement {
    const slots = cardSlots(svg)
    return slots[slots.length - 1]!
  }

  /** What a card on the board says, read off its own label. */
  function words(el: Element): string {
    return (el.querySelector('.nodeLabel')?.textContent ?? '').trim()
  }

  /** The band's own name, which is what stays readable under a card in the air. */
  function binName(svg: SVGSVGElement): string {
    return words(columnSlot(svg))
  }

  /** The band's own background, which is what a bin tints. */
  function binFrame(svg: SVGSVGElement): CSSStyleDeclaration {
    return columnSlot(svg).querySelector('rect')!.style
  }

  /** The bin card's own background, which is the other half of the tint. */
  function binCardFrame(svg: SVGSVGElement): CSSStyleDeclaration {
    return binCard(svg).querySelector('rect')!.style
  }

  /** Card 0, from where it sits, onto the drawn slot column at the board's end. */
  function dragToTheBin(svg: SVGSVGElement): void {
    svg.querySelectorAll<SVGElement>('.items > g.node')[0]!.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 650, 60))
  }

  it("is the board's own card slot for the length of a card drag", async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)

    // Nothing there to begin with: a board nobody is dragging on is a board to
    // add a column to, and that column is drawn with a card slot like any other.
    expect(binName(svg)).toBe(KANBAN_COLUMN_SLOT)
    expect(words(binCard(svg))).toBe(KANBAN_CARD_SLOT)
    expect(binFrame(svg).fill).toBe('')
    expect(binCardFrame(svg).fill).toBe('')
    // …and the slot itself is blank. A card captioned `+ Add a card` standing in a
    // column captioned `+ Add a column` is the one place on the board that offers
    // a card to a place, and the press it invites is answered with a *column*. The
    // space is still drawn — mermaid laid the band out around it, and a drag may
    // not re-render the drawing out from under the card it is holding — so it is
    // emptied rather than removed, and this class is the emptying. It is the drawn
    // column's slot and no other column's: the others are where a card really goes.
    expect(binCard(svg).classList.contains('mermaid-kanban-bin-slot')).toBe(true)
    expect(cardSlots(svg).slice(0, -1).some((el) => el.classList.contains('mermaid-kanban-bin-slot'))).toBe(false)

    dragToTheBin(svg)

    // It is a card, and the card is the bin: it says what it is for, it is the
    // board's own card slot in the board's own list, and it is red — the card and
    // the column it stands in, because a card in the air covers the card slot it
    // is aimed at and the band is what is left to read. The card says the one word
    // its own label box has room for beside the mark, and the band, which mermaid
    // sized for a longer name, says both.
    expect(words(binCard(svg))).toBe('Delete')
    expect(binCard(svg).querySelector('.mermaid-kanban-bin-mark')).not.toBeNull()
    // Revealed, and revealed by the same turn that writes on it: there is no frame
    // in which the slot is visible and still says what it says at rest.
    expect(binCard(svg).classList.contains('mermaid-kanban-bin-slot')).toBe(false)
    expect(binCardFrame(svg).fill).toBe('var(--danger)')
    expect(binCardFrame(svg).fillOpacity).toBe('0.28')
    expect(binName(svg)).toBe('Delete card')
    expect(binFrame(svg).fill).toBe('var(--danger)')
    expect(columnSlot(svg).querySelector('.mermaid-kanban-bin-mark')).not.toBeNull()
    // And it is *of* the drawing, so the card on its way to it paints over the
    // bin: a frame is in `.sections` and a card is in `.items`, and a lift puts
    // the held card last in that list.
    expect(columnSlot(svg).parentElement!.classList.contains('sections')).toBe(true)
    expect(binCard(svg).parentElement!.classList.contains('items')).toBe(true)
    // Nothing is promised where a card cannot land otherwise: the line is gone,
    // and the slot column is not marked as a target either — it is a place to name.
    expect(document.querySelector<SVGLineElement>('.mermaid .kanban-drop-line')!.style.display).toBe('none')
    expect(columnSlot(svg).classList.contains('kanban-drop-target')).toBe(false)

    // The release asks, before it takes anything: a drag is a decision with two
    // answers.
    window.dispatchEvent(pointer('pointerup', 650, 60))
    const dialog = document.querySelector<HTMLElement>('.edi-dialog')!
    expect(dialog.querySelector('.edi-dialog-title')!.textContent).toContain('One')
    click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Delete')!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(commit).toHaveBeenCalledWith(['kanban', '  Todo', '    id2[Two]', '  Doing', '  Done', '    id3[Three]'].join('\n'))
    // The bin went with the drag, whichever way the release went: the column is
    // the column it was before, in every part of itself.
    expect(binName(svg)).toBe(KANBAN_COLUMN_SLOT)
    expect(words(binCard(svg))).toBe(KANBAN_CARD_SLOT)
    expect(binCard(svg).querySelector('.mermaid-kanban-bin-mark')).toBeNull()
    expect(binCard(svg).classList.contains('mermaid-kanban-bin-slot')).toBe(true)
    expect(binFrame(svg).fill).toBe('')
    expect(binFrame(svg).fillOpacity).toBe('')
    expect(binCardFrame(svg).fill).toBe('')
    expect(binCardFrame(svg).fillOpacity).toBe('')
  })

  it('paints the mark where no rule of the diagram can take its colour back', async () => {
    const { svg } = await renderKanbanBoard(vi.fn())
    dragToTheBin(svg)

    // Mermaid styles `path` inside a board with its own palette, and such a rule
    // beats both an inherited value and a presentation attribute — so the mark
    // came out in the diagram's colours, filled as well as stroked, while the
    // words beside it were the danger colour. An inline style is the only thing
    // that wins, and this is the mark on *both* halves.
    for (const part of [binCard(svg), columnSlot(svg)]) {
      const paths = Array.from(part.querySelectorAll<SVGPathElement>('.mermaid-kanban-bin-mark path'))
      expect(paths).toHaveLength(5)
      expect(paths.map((path) => path.style.stroke)).toEqual(Array<string>(5).fill('var(--danger, currentColor)'))
      expect(paths.map((path) => path.style.fill)).toEqual(Array<string>(5).fill('none'))
    }
  })

  it('is the bin for a pointer on it, and a quieter one for a pointer off it', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)
    svg.querySelectorAll<SVGElement>('.items > g.node')[0]!.dispatchEvent(pointer('pointerdown', 20, 45))
    window.dispatchEvent(pointer('pointermove', 60, 60))

    // A card in the air and the pointer over its own column: the board's last
    // column says what it is for, without being the answer to this drag.
    expect(words(binCard(svg))).toBe('Delete')
    expect(binFrame(svg).fillOpacity).toBe('0.14')
    expect(binFrame(svg).strokeWidth).toBe('1.5px')
    expect(binCardFrame(svg).fillOpacity).toBe('0.14')

    window.dispatchEvent(pointer('pointermove', 650, 60))

    // On it. Lit, and nothing else: there is no second border round a bin.
    expect(binFrame(svg).fillOpacity).toBe('0.28')
    expect(binFrame(svg).strokeWidth).toBe('2.5px')
    expect(binCardFrame(svg).fillOpacity).toBe('0.28')
    expect(columnSlot(svg).classList.contains('kanban-drop-target')).toBe(false)
  })

  it('cancels a delete like any other, and keeps the card', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)
    dragToTheBin(svg)
    window.dispatchEvent(pointer('pointerup', 650, 60))

    const dialog = document.querySelector<HTMLElement>('.edi-dialog')!
    expect(dialog.querySelector('.edi-dialog-note')!.textContent).toContain('removed from the Todo column')
    click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Cancel')!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(commit).not.toHaveBeenCalled()
    expect(binName(svg)).toBe(KANBAN_COLUMN_SLOT)
    expect(words(binCard(svg))).toBe(KANBAN_CARD_SLOT)
    expect(binFrame(svg).fill).toBe('')
    expect(binCardFrame(svg).fill).toBe('')
  })

  it('is not the bin while the pointer is on a column that takes cards', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)
    svg.querySelectorAll<SVGElement>('.items > g.node')[0]!.dispatchEvent(pointer('pointerdown', 20, 45))
    // The foot of its own column, below the last real card and inside the band.
    window.dispatchEvent(pointer('pointermove', 60, 125))

    // That is a place a card can go, so the line is back to promising the drop.
    // The bin is still the bin — the drag is still a card's — but it is not lit.
    expect(document.querySelector<SVGLineElement>('.mermaid .kanban-drop-line')!.style.display).toBe('')
    expect(binFrame(svg).fillOpacity).toBe('0.14')
    expect(binCardFrame(svg).fillOpacity).toBe('0.14')
  })

  it('leaves a column drag alone: its end is a gap, not a bin', async () => {
    const commit = vi.fn()
    const { svg } = await renderKanbanBoard(commit)
    const band = svg.querySelectorAll<SVGElement>('.sections > g')[0]!
    // A press on the frame rather than on one of its cards, which is the column
    // it belongs to: the left strip of the band is the column's own.
    band.dispatchEvent(pointer('pointerdown', 4, 100))
    window.dispatchEvent(pointer('pointermove', 300, 100))

    // A column dropped at the end of the board goes before the drawn slot, and
    // that is a move: nothing is being deleted, so nothing is a bin.
    expect(binName(svg)).toBe(KANBAN_COLUMN_SLOT)
    expect(words(binCard(svg))).toBe(KANBAN_CARD_SLOT)
    expect(binFrame(svg).fill).toBe('')
    expect(binCardFrame(svg).fill).toBe('')
  })
})

describe('kanban delete buttons', () => {
  function renderBoard(commit: (next: string) => void): Promise<HTMLElement> {
    return renderKanbanBoard(commit).then((board) => board.preview)
  }

  function menus(scope: ParentNode): HTMLButtonElement[] {
    return Array.from(scope.querySelectorAll<HTMLButtonElement>('.mermaid-kanban-menu'))
  }

  /** Open a column's `⋯` and return the items of the menu it opened. */
  function openMenu(preview: HTMLElement, column: number): string[] {
    click(menus(preview)[column]!)
    return menuItems(preview)
  }

  function menuItems(scope: ParentNode): string[] {
    return Array.from(scope.querySelectorAll<HTMLElement>('.mermaid-kanban-menu-item')).map(
      (item) => item.textContent ?? '',
    )
  }

  /** Open a column's menu and press one of its items. */
  function choose(scope: ParentNode, column: number, text: string): void {
    click(menus(scope)[column]!)
    const item = Array.from(scope.querySelectorAll<HTMLButtonElement>('.mermaid-kanban-menu-item')).find(
      (candidate) => candidate.textContent === text,
    )
    expect(item).not.toBeUndefined()
    click(item!)
  }

  function dialog(): HTMLElement {
    const found = document.querySelector<HTMLElement>('.edi-dialog')
    expect(found).not.toBeNull()
    return found!
  }

  function dialogButton(text: string): HTMLButtonElement {
    const found = Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === text,
    )
    expect(found).not.toBeNull()
    return found!
  }

  /** The confirm is a promise, so its answer is applied a microtask later. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('offers a ⋯ on every column, and nothing at all on a card', async () => {
    const preview = await renderBoard(vi.fn())

    expect(menus(preview).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Todo column actions',
      'Doing column actions',
      'Done column actions',
    ])
    // A card is not covered by a control: a title long enough to fill its card
    // runs up against the card's own edge, so anything laid over one is laid over
    // the words. A card is deleted by being picked up and dropped on the column
    // the board is drawn with, which is a bin only while it is in the air.
    expect(preview.querySelectorAll('.mermaid-kanban-btn')).toHaveLength(3)
    // A slot is a place rather than content, so it is not deletable — and the new
    // column is not a column yet, so it has no actions either.
    expect(preview.querySelector('.mermaid-kanban-column-slot .mermaid-kanban-btn')).toBeNull()
  })

  it('follows the diagram when it is resized, as a zoom makes it', async () => {
    const { preview, svg } = await renderKanbanBoard(vi.fn())
    const menu = menus(preview)[0]!
    // What the zoom toolbar does: the whole diagram gets wider, so the first
    // column's band grows with it and the `⋯` has to move.
    const section = svg.querySelectorAll<SVGElement>('.sections > g')[0]!
    section.querySelector('rect')!.getBoundingClientRect = () => rect(0, 20, 260, 110)
    fireResizeCallbacks()
    // The chrome repositions in a frame, and again while the board is still
    // settling, rather than inside the observer callback.
    await flushFrames()

    // The band's own right edge (260) less the 18px button and its 8px inset,
    // against a preview that sits 10px down the block.
    expect(menu.style.left).toBe('234px')
    expect(menu.style.top).toBe('18px')
  })

  it('puts the column own ⋯ in the header, on its name rather than the band', async () => {
    const preview = await renderBoard(vi.fn())
    // The `⋯` is 18px, 8px in from the band's own top-right corner, and centred on
    // the name it is the menu of: the band is padded, so the name is not at its
    // own top edge.
    const column = menus(preview)[0]!
    expect(column.style.left).toBe('114px')
    expect(column.style.top).toBe('18px')
  })

  it('opens a column menu beside its own ⋯, and not beside the board', async () => {
    const preview = await renderBoard(vi.fn())

    expect(openMenu(preview, 1)).toEqual(['Rename column', 'Delete column'])
    // The list hangs off the `⋯` it belongs to: right-aligned to it, and flush
    // with its bottom edge (18 + 18), so there is no gap between the two.
    const list = preview.querySelector<HTMLElement>('.mermaid-kanban-menu-list')!
    expect(list.style.left).toBe('142px')
    expect(list.style.top).toBe('36px')
    expect(list.style.width).toBe('190px')
    // One at a time: a second `⋯` takes the first menu away.
    click(menus(preview)[2]!)
    expect(preview.querySelectorAll('.mermaid-kanban-menu-list')).toHaveLength(1)
    expect(menuItems(preview)).toEqual(['Rename column', 'Delete column'])
  })

  it('deletes a column with its cards, and says how many go with it', async () => {
    const commit = vi.fn()
    const preview = await renderBoard(commit)

    choose(preview, 0, 'Delete column')
    // Which column is the dialog's to say, not the item's: the item belongs to the
    // `⋯` it hangs off, and the prompt is the one place the name is worth saying.
    expect(dialog().querySelector('.edi-dialog-title')!.textContent).toBe('Delete the Todo column?')
    // The consequence is in the prompt, not discovered afterwards.
    expect(dialog().querySelector('.edi-dialog-note')!.textContent).toContain('Its 2 cards go with it.')

    click(dialogButton('Delete'))
    await settle()
    expect(commit).toHaveBeenCalledWith(['kanban', '  Doing', '  Done', '    id3[Three]'].join('\n'))
    // The menu took itself away, so it is not left hanging over the board.
    expect(preview.querySelector('.mermaid-kanban-menu-list')).toBeNull()
  })

  it('offers no column delete on a board of one, which would leave no board', async () => {
    const { preview } = await renderKanbanBoard(
      vi.fn(),
      'kanban\n  Todo\n    id1[One]',
      boardSvg(['Todo', KANBAN_COLUMN_SLOT], ['One', KANBAN_CARD_SLOT, KANBAN_CARD_SLOT]),
      [BOARD_BANDS[0]!, BOARD_BANDS[3]!],
      [BOARD_CARD_RECTS[0]!, BOARD_CARD_RECTS[2]!, BOARD_CARD_RECTS[6]!],
    )

    // The one column still has its own actions, and the delete is not one of them.
    expect(openMenu(preview, 0)).toEqual(['Rename column'])
    // Its card can still go — on the bin, which is the column this board is drawn
    // with — so the board is editable without emptying it.
    expect(preview.querySelectorAll('.mermaid-kanban-btn')).toHaveLength(1)
    // And the board is still drawn with the column it would need to get back to
    // two, which is the whole answer to a board of one.
    expect(preview.querySelector('.mermaid-kanban-column-slot')).not.toBeNull()
  })

  it('does not offer to add a column, because the board is drawn with somewhere to', async () => {
    const preview = await renderBoard(vi.fn())

    // A way to add a column that is *only* in the menu is a way to add one a
    // board drawn without a slot column would not have. The place to add is the
    // board itself, and the menu is for the two things that are not places.
    const items = openMenu(preview, 0)
    expect(items).not.toContain('Add a column after Todo')
    expect(items).toHaveLength(2)
  })

  it('holds itself open when the press lands on it rather than on an item', async () => {
    const preview = await renderBoard(vi.fn())
    click(menus(preview)[0]!)
    const list = preview.querySelector<HTMLElement>('.mermaid-kanban-menu-list')!

    // The list has padding, 1px gaps between its items, and the bridge it draws
    // over the gap under its own `⋯`; every one of those is the popover, so a
    // press on any of them must not reach the board and dismiss it.
    for (const type of ['pointerdown', 'mousedown']) {
      list.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
    }
    expect(preview.querySelector('.mermaid-kanban-menu-list')).toBe(list)

    // A press on the board still is one, so the menu is dismissible at all.
    list.parentElement!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(preview.querySelector('.mermaid-kanban-menu-list')).toBeNull()
  })

  it('goes away with the layer, all of them', async () => {
    const { host, preview } = await renderKanbanBoard(vi.fn())
    expect(preview.querySelectorAll('.mermaid-kanban-btn').length).toBeGreaterThan(0)

    finishMermaidLabelEditing(host, false)
    expect(preview.querySelectorAll('.mermaid-kanban-btn')).toHaveLength(0)
  })
})

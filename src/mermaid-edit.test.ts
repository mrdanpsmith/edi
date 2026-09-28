import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fireResizeCallbacks } from './test-setup'
import {
  addKanbanCard,
  attachMermaidEditing,
  buildKanbanSource,
  detectDiagramType,
  finishMermaidLabelEditing,
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

  it('never invents a label for an unterminated quote', () => {
    // `["Half open` says nothing about where the label ends, so the model
    // withholds it rather than offering a rename it cannot place.
    const [card] = parseKanban('kanban\n  Todo\n    ["Half open').cards
    expect(card?.label).toBeNull()
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
    // A `"` would close the label its own quote opened, and a line break is not
    // text at all. Refused before the source is touched, so a card can never be
    // committed that mermaid will not render.
    for (const label of ['a"b', 'one\ntwo', '   ']) {
      expect(addKanbanCard(source, 0, 0, label)).toBeNull()
    }
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
    // A column may be called almost anything: what it cannot hold is a double
    // quote or a line break, and those are dropped so the board still renders.
    expect(buildKanbanSource(['Todo', 'Q3 (launch)', 'x@{ y }', 'Done'])).toBe(
      'kanban\n  col1[Todo]\n  col2["Q3 (launch)"]\n  col3["x@{ y }"]\n  col4[Done]',
    )
    expect(buildKanbanSource(['Todo', 'a"b', 'one\ntwo', 'Done'])).toBe(
      'kanban\n  col1[Todo]\n  col2[Done]',
    )
  })

  it('seeds the first column with a card when asked', () => {
    expect(buildKanbanSource(['Todo', 'Done'], { firstCard: 'Write the spec' })).toBe(
      'kanban\n  col1[Todo]\n    [Write the spec]\n  col2[Done]',
    )
    expect(buildKanbanSource(['Todo'], { firstCard: 'a]b' })).toBe(
      'kanban\n  col1[Todo]\n    ["a]b"]',
    )
    expect(buildKanbanSource(['Todo'], { firstCard: 'a"b' })).toBe('kanban\n  col1[Todo]')
  })

  it('ignores blank lines and surrounding space', () => {
    expect(buildKanbanSource(['  Todo ', '', '   ', 'Done'])).toBe('kanban\n  col1[Todo]\n  col2[Done]')
  })

  it('returns nothing when no column name is usable', () => {
    expect(buildKanbanSource([])).toBe('')
    expect(buildKanbanSource(['', '  '])).toBe('')
    expect(buildKanbanSource(['a"b'])).toBe('')
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

describe('kanban add buttons', () => {
  // A board with an empty middle column: mermaid still draws one, as a shorter
  // band, which is what makes a per-column ＋ work for it.
  const source = [
    'kanban',
    '  Todo',
    '    id1[One]',
    '    id2[Two]',
    '  Doing',
    '  Done',
    '    id3[Three]',
  ].join('\n')

  const bands: DOMRect[] = [
    rect(0, 20, 140, 100),
    rect(200, 20, 140, 50),
    rect(400, 20, 140, 50),
  ]

  function card(label: string): string {
    return `<g class="node default"><rect /><g class="label"><foreignObject><div class="labelBkg">` +
      `<span class="nodeLabel"><p>${label}</p></span></div></foreignObject></g></g>`
  }

  function section(name: string): string {
    return `<g class="cluster section-x"><rect /><g class="cluster-label"><foreignObject><div class="labelBkg">` +
      `<span class="nodeLabel"><p>${name}</p></span></div></foreignObject></g></g>`
  }

  const BOARD_SVG = `<svg><g class="sections">${section('Todo')}${section('Doing')}${section('Done')}</g>` +
    `<g class="items">${card('One')}${card('Two')}${card('Three')}</g></svg>`

  async function renderBoard(commit: (next: string) => void): Promise<{
    host: HTMLElement
    preview: HTMLElement
    svg: SVGSVGElement
  }> {
    hoisted.render.mockResolvedValue({ svg: BOARD_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, source, { host, commit })
    const svg = preview.querySelector('svg')!
    svg.querySelectorAll<SVGElement>('.sections > g').forEach((band, index) => {
      const bounds = bands[index]!
      band.querySelector('rect')!.getBoundingClientRect = () => bounds
      ;(band as unknown as { _bounds: DOMRect })._bounds = bounds
    })
    preview.getBoundingClientRect = () => rect(0, 10, 800, 600)
    // jsdom computes no layout, so the layer is attached again once the section
    // rects are known — which is the order a real render already has them in.
    attachMermaidEditing(preview, svg, source, commit)
    return { host, preview, svg }
  }

  function addButtons(scope: ParentNode): HTMLButtonElement[] {
    return Array.from(scope.querySelectorAll<HTMLButtonElement>('.mermaid-kanban-add'))
  }

  it('offers a ＋ for every column, the empty one included', async () => {
    const { preview } = await renderBoard(vi.fn())
    const buttons = addButtons(preview)

    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Add a card to Todo',
      'Add a card to Doing',
      'Add a card to Done',
    ])
  })

  it('centres each ＋ in the bottom of its own column band', async () => {
    const { preview } = await renderBoard(vi.fn())
    const [todo, doing] = addButtons(preview)
    // The preview sits 10px down the block, so a band at y=20 is y=10 in it.
    expect(todo!.style.left).toBe('70px')
    expect(todo!.style.top).toBe('99px')
    // The empty column's band is half as tall, and its ＋ follows it up.
    expect(doing!.style.left).toBe('270px')
    expect(doing!.style.top).toBe('49px')
  })

  it('follows the diagram when it is resized, as a zoom makes it', async () => {
    const { preview, svg } = await renderBoard(vi.fn())
    const button = addButtons(preview)[0]!
    // What the zoom toolbar does: the whole diagram gets wider, so the first
    // column's band grows with it and the ＋ has to move.
    const band = svg.querySelectorAll<SVGElement>('.sections > g')[0]!
    band.querySelector('rect')!.getBoundingClientRect = () => rect(0, 20, 280, 200)
    fireResizeCallbacks()

    expect(button.style.left).toBe('140px')
    expect(button.style.top).toBe('199px')
  })

  it('creates a card in the column that was pressed, as one source patch', async () => {
    const commit = vi.fn()
    const { preview } = await renderBoard(commit)

    click(addButtons(preview)[1]!)
    const field = input()
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('New card in Doing')
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
    const { preview } = await renderBoard(commit)

    click(addButtons(preview)[0]!)
    typeAndConfirm('Discarded', 'Escape')

    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('accepts a title holding a delimiter, quoting it in the source', async () => {
    const commit = vi.fn()
    const { preview } = await renderBoard(commit)

    click(addButtons(preview)[0]!)
    typeAndConfirm('Fix (the bug)')

    // The card lands; the quotes are how the source spells it, not what the
    // user typed, and mermaid draws it without them.
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![0]).toContain('    ["Fix (the bug)"]')
    expect(document.querySelector('.mermaid-edit-input')).toBeNull()
  })

  it('refuses a title no quoting can carry, and says so', async () => {
    const commit = vi.fn()
    const { preview } = await renderBoard(commit)

    click(addButtons(preview)[0]!)
    typeAndConfirm('a"b')

    // Flashed, not silently dropped — and the board is untouched.
    expect(input().classList.contains('mermaid-edit-invalid')).toBe(true)
    expect(commit).not.toHaveBeenCalled()
  })

  it('never arms the card drag on a press', async () => {
    const commit = vi.fn()
    const { preview } = await renderBoard(commit)
    const button = addButtons(preview)[0]!
    const down = new Event('pointerdown', { bubbles: true, cancelable: true })
    Object.assign(down, { clientX: 70, clientY: 99, button: 0 })

    button.dispatchEvent(down)
    window.dispatchEvent(
      Object.assign(new Event('pointermove', { bubbles: true }), { clientX: 20, clientY: 45, button: 0 }),
    )

    // The ＋ sits over a card, and the drag hit-tests by coordinate.
    expect(document.querySelector('.kanban-drop-line')).toBeNull()
  })

  it('is not a label, so it is never offered for renaming', async () => {
    const { preview, svg } = await renderBoard(vi.fn())
    // It is HTML in the preview, not an SVG label: nothing walks it.
    expect(editables(svg).map((el) => el.textContent?.trim())).toEqual(['Todo', 'Doing', 'Done', 'One', 'Two', 'Three'])
    expect(addButtons(preview).some((button) => button.classList.contains('mermaid-editables'))).toBe(false)
  })

  it('goes away with the layer, and comes back with the next render', async () => {
    const commit = vi.fn()
    const { host, preview } = await renderBoard(commit)
    expect(addButtons(preview)).toHaveLength(3)

    finishMermaidLabelEditing(host, false)
    expect(addButtons(preview)).toHaveLength(0)

    await renderDiagram(preview, source, { host, commit })
    expect(addButtons(preview)).toHaveLength(3)
  })

  it('offers none on a diagram that is not a board', async () => {
    hoisted.render.mockResolvedValue({ svg: FLOWCHART_SVG })
    const { host, preview } = harness()
    await renderDiagram(preview, 'graph TD\n  A[Alpha]\n  B[Beta]', { host, commit: vi.fn() })

    expect(addButtons(preview)).toHaveLength(0)
  })
})

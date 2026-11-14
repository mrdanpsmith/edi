import { describe, it, expect, vi, afterEach } from 'vitest'
import { createBlockEditor } from './editor'
import {
  documentFormat,
  fileTextForDisplay,
  fileTextToMarkdown,
  markdownToFileText,
  singleDiagramSource,
} from './documentFormat'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 10 10"></svg>', diagramType: 'flowchart-v2' }),
    parse: vi.fn().mockResolvedValue(true),
  },
}))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('documentFormat', () => {
  it('is mermaid for .mmd and .mermaid, in any case, and markdown otherwise', () => {
    expect(documentFormat('/d/a.mmd')).toBe('mermaid')
    expect(documentFormat('/d/a.MERMAID')).toBe('mermaid')
    expect(documentFormat('/d/a.md')).toBe('markdown')
    expect(documentFormat('/d/a.txt')).toBe('markdown')
    expect(documentFormat(null)).toBe('markdown')
  })
})

describe('Mermaid file text', () => {
  const cases: Array<[string, string]> = [
    ['ending in a newline', 'graph TD\n  A --> B\n'],
    ['without a final newline', 'graph TD\n  A --> B'],
    ['ending in a blank line', 'graph TD\n  A --> B\n\n'],
    ['empty', ''],
    ['a lone newline', '\n'],
    ['holding a backtick fence', 'graph TD\n  A["```"] --> B\n'],
    ['with front matter', '---\ntitle: Flow\n---\nflowchart LR\n  a --> b\n'],
  ]

  it.each(cases)('round-trips a file %s', (_name, text) => {
    const markdown = fileTextToMarkdown('/d/a.mmd', text)
    expect(markdown).toMatch(/^`{3,}mermaid\n/)
    expect(markdownToFileText('/d/a.mmd', markdown)).toBe(text)
  })

  it.each(cases)('saves an unedited file %s byte for byte through the editor', (_name, text) => {
    const editor = createBlockEditor(document.body, fileTextToMarkdown('/d/a.mmd', text))
    const doc = editor.getView().state.doc
    expect(doc.firstChild?.type.name).toBe('mermaid_block')
    expect(markdownToFileText('/d/a.mmd', editor.getMarkdown())).toBe(text)
    editor.getView().destroy()
  })

  it('leaves markdown files alone in both directions', () => {
    const text = '# Title\n\n```mermaid\ngraph TD\n```\n'
    expect(fileTextToMarkdown('/d/a.md', text)).toBe(text)
    expect(markdownToFileText('/d/a.md', text)).toBe(text)
  })

  it('writes a single-diagram markdown document saved as .mmd as bare source', () => {
    expect(markdownToFileText('/d/a.mmd', '```mermaid\ngraph TD\n```\n')).toBe('graph TD\n')
    expect(markdownToFileText('/d/a.mmd', '~~~~ mermaid\ngraph TD\n~~~~\n')).toBe('graph TD\n')
  })

  it('allows blank lines around the diagram', () => {
    expect(singleDiagramSource('\n\n```mermaid\ngraph TD\n```\n\n\n')).toBe('graph TD\n')
  })

  it('has no Mermaid file text for anything more or less than one diagram', () => {
    expect(markdownToFileText('/d/a.mmd', '```mermaid\ngraph TD\n```\n\nA note.\n')).toBeNull()
    expect(markdownToFileText('/d/a.mmd', 'Intro\n\n```mermaid\ngraph TD\n```\n')).toBeNull()
    expect(markdownToFileText('/d/a.mmd', '```mermaid\na\n```\n\n```mermaid\nb\n```\n')).toBeNull()
    expect(markdownToFileText('/d/a.mmd', '```python\nprint(1)\n```\n')).toBeNull()
    expect(markdownToFileText('/d/a.mmd', '```mermaid\nunclosed\n')).toBeNull()
    expect(markdownToFileText('/d/a.mmd', '')).toBeNull()
  })

  it('does not take a shorter fence inside the diagram for its close', () => {
    expect(singleDiagramSource('````mermaid\na\n```\nb\n````\n')).toBe('a\n```\nb\n')
  })

  it('shows the markdown itself where a Mermaid file has no spelling for it', () => {
    expect(fileTextForDisplay('/d/a.mmd', 'Just text\n')).toBe('Just text\n')
    expect(fileTextForDisplay('/d/a.mmd', '```mermaid\ngraph TD\n```\n')).toBe('graph TD\n')
  })
})

describe('an edited Mermaid file', () => {
  it('writes the edited diagram as bare source', () => {
    const editor = createBlockEditor(document.body, fileTextToMarkdown('/d/a.mmd', 'graph TD\n  A --> B\n'))
    const view = editor.getView()
    const block = view.state.doc.firstChild!
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { ...block.attrs, value: 'graph TD\n  A --> C' }))
    expect(markdownToFileText('/d/a.mmd', editor.getMarkdown())).toBe('graph TD\n  A --> C\n')
    view.destroy()
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { schema } from './schema'
import { parseMarkdown, proseToMarkdown } from './markdown'
import { createBlockEditor } from './editor'

/** Open and save with the record of the text, as the editor does. */
function save(md: string): string {
  const { doc, source } = parseMarkdown(md, schema)
  return proseToMarkdown(doc, undefined, source)
}

/** Files in styles Edi does not write itself. Opening and saving them, with no
 * edit, must still not change a byte. */
const OTHER_STYLES = [
  '- [ ] A task whose text wraps\n      onto a line aligned under the text\n- [ ] two\n',
  '* star bullets\n* stay stars\n',
  '- loose\n\n- list items\n\n- keep their blank lines\n',
  '1) paren\n2) ordered\n',
  '_em_ and __strong__\n',
  'Setext\n======\n\nAnd a paragraph.\n',
  '# Heading\nParagraph straight under it.\n',
  'One\n\n\n\nFour newlines above.\n',
  '    indented code\n    stays indented\n',
  '~~~\ntilde fence\n~~~\n',
  'No final newline',
  '\n\nLeading blank lines\n',
  'Trailing blank lines\n\n\n',
  '---\ntitle: x\n---\n\n* front matter, then a star list\n',
  '| a | b |\n|---|:-:|\n|1|2|\n',
  '> quote\ncontinued lazily\n',
  '***\n',
]

describe('opening and saving keeps the file as written', () => {
  it.each(OTHER_STYLES)('preserves %j exactly', (md) => {
    expect(save(md)).toBe(md)
  })

  it('reads a kept file back as the same document', () => {
    for (const md of OTHER_STYLES) {
      expect(parseMarkdown(save(md), schema).doc.eq(parseMarkdown(md, schema).doc)).toBe(true)
    }
  })

  it('writes CRLF input with one line ending (the shell restores the file’s own)', () => {
    expect(save('* a\r\n* b\r\n')).toBe('* a\n* b\n')
  })

  it('without the record writes Edi’s own style, as before', () => {
    const md = '* star\n'
    expect(proseToMarkdown(parseMarkdown(md, schema).doc)).toBe('- star\n')
  })
})

describe('an edit rewrites only the block it touched', () => {
  const md = '* kept star\n\n\nA paragraph to edit.\n\n1) kept paren\n'

  function editSecondBlock(text: string): string {
    const { doc, source } = parseMarkdown(md, schema)
    const edited = doc.copy(doc.content.replaceChild(1, schema.node('paragraph', null, [schema.text(text)])))
    return proseToMarkdown(edited, undefined, source)
  }

  it('keeps its unedited neighbours and the gaps between them', () => {
    expect(editSecondBlock('An edited paragraph.')).toBe('* kept star\n\n\nAn edited paragraph.\n\n1) kept paren\n')
  })

  it('keeps the gaps around a block edited in place, down to a single newline', () => {
    const defs = '[a]: one.md\n[b]: two.md\n[c]: three.md\n'
    const { doc, source } = parseMarkdown(defs, schema)
    const edited = doc.copy(doc.content.replaceChild(1, schema.node('source_block', { markdown: '[b]: moved.md' })))
    expect(proseToMarkdown(edited, undefined, source)).toBe('[a]: one.md\n[b]: moved.md\n[c]: three.md\n')
  })

  it('writes an image read from a reference back as that reference', () => {
    const { doc, source } = parseMarkdown('See ![logo][] and ![x][logo].\n\n[logo]: logo.png\n', schema)
    const paragraph = doc.child(0)
    const edited = doc.copy(
      doc.content.replaceChild(0, paragraph.copy(paragraph.content.addToStart(schema.text('Now: ')))),
    )
    expect(proseToMarkdown(edited, undefined, source)).toBe('Now: See ![logo][] and ![x][logo].\n\n[logo]: logo.png\n')
  })

  it('keeps the end of the file when the last block is edited', () => {
    const { doc, source } = parseMarkdown('First.\n\nLast.', schema)
    const edited = doc.copy(doc.content.replaceChild(1, schema.node('paragraph', null, [schema.text('Changed.')])))
    expect(proseToMarkdown(edited, undefined, source)).toBe('First.\n\nChanged.')
  })

  // A paragraph straight under a heading is fine; straight under another
  // paragraph it would join it. The gap is kept only for the same kind of block.
  it('does not keep a gap for a block that changed kind', () => {
    const { doc, source } = parseMarkdown('# Heading\nParagraph straight under it.\n', schema)
    const edited = doc.copy(doc.content.replaceChild(0, schema.node('paragraph', null, [schema.text('Now a paragraph.')])))
    expect(proseToMarkdown(edited, undefined, source)).toBe('Now a paragraph.\n\nParagraph straight under it.\n')
  })

  it('keeps the blocks around an inserted one', () => {
    const { doc, source } = parseMarkdown(md, schema)
    const inserted = doc.copy(
      doc.content.addToStart(schema.node('heading', { level: 1 }, [schema.text('New')])),
    )
    expect(proseToMarkdown(inserted, undefined, source)).toBe(
      '# New\n\n* kept star\n\n\nA paragraph to edit.\n\n1) kept paren\n',
    )
  })

  it('keeps the blocks around a deleted one', () => {
    const { doc, source } = parseMarkdown(md, schema)
    const removed = doc.copy(doc.content.cut(doc.child(0).nodeSize))
    expect(proseToMarkdown(removed, undefined, source)).toBe('A paragraph to edit.\n\n1) kept paren\n')
  })
})

describe('formula tables', () => {
  it('are always written fresh, so a stale computed value is recomputed', () => {
    // C2 says 99, but its formula makes it 3.
    const md = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 99 |\n\n<!-- edi-fml {"C2":"=A2+B2"} -->\n'
    expect(save(md)).not.toContain('99')
    expect(save(md)).toContain('| 3')
  })
})

describe('the editor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('getMarkdown is the opened file until something is edited', () => {
    const md = '- [ ] wrapped\n      under the text\n\n* stars\n'
    const editor = createBlockEditor(document.body, md)
    expect(editor.getMarkdown()).toBe(md)
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText('!', 3))
    expect(editor.getMarkdown()).toBe('- [ ] !wrapped\n  under the text\n\n* stars\n')
    editor.destroy()
  })

  it('a state swapped back in brings its own record', () => {
    const editor = createBlockEditor(document.body, '* first tab\n')
    const first = editor.getState()
    editor.applyState(editor.createState('+ second tab\n'))
    expect(editor.getMarkdown()).toBe('+ second tab\n')
    editor.applyState(first)
    expect(editor.getMarkdown()).toBe('* first tab\n')
    editor.destroy()
  })

  it('replaceMarkdown adopts the new layout even when the document is the same', () => {
    const editor = createBlockEditor(document.body, '* item\n')
    editor.replaceMarkdown('+ item\n')
    expect(editor.getMarkdown()).toBe('+ item\n')
    editor.destroy()
  })

  it('replaceMarkdown keeps the new text’s layout for the blocks it did not change', () => {
    const editor = createBlockEditor(document.body, 'Para one.\n\n* list\n')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    editor.replaceMarkdown('Para one, edited.\n\n\n+ list\n')
    expect(editor.getMarkdown()).toBe('Para one, edited.\n\n\n+ list\n')
    editor.destroy()
  })
})

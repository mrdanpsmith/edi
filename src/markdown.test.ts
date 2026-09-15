import { describe, it, expect } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown, buildBlockOffsets, extractBlockMarkdown } from './markdown'
import { encryptField } from './crypto'

function serialize(markdown: string): string {
  return proseToMarkdown(markdownToProse(markdown, schema))
}

describe('image round-trip', () => {
  it('preserves a block image src and alt', () => {
    expect(serialize('Hello\n\n![A cat](./images/cat.png)\n\nWorld')).toBe(
      'Hello\n\n![A cat](./images/cat.png)\n\nWorld\n',
    )
  })

  it('preserves an inline image with an absolute path', () => {
    expect(serialize('Inline ![x](/abs/img.png) here')).toBe(
      'Inline ![x](/abs/img.png) here\n',
    )
  })

  it('preserves a remote image URL', () => {
    expect(serialize('![remote](https://example.com/i.png)')).toBe(
      '![remote](https://example.com/i.png)\n',
    )
  })
})

describe('emphasis round-trip', () => {
  it('preserves italic text', () => {
    expect(serialize('Hello *world* test')).toBe('Hello *world* test\n')
  })

  it('preserves a standalone italic line', () => {
    expect(serialize('*emphasized*')).toBe('*emphasized*\n')
  })

  it('preserves italic next to bold', () => {
    expect(serialize('**bold** and *italic*')).toBe('**bold** and *italic*\n')
  })

  it('preserves GFM strikethrough alongside italics', () => {
    expect(serialize('~~strike~~ and *em*')).toBe('~~strike~~ and *em*\n')
  })
})

describe('proseToMarkdown save round-trip', () => {
  it('keeps separate paragraphs separated by a blank line', () => {
    const md = 'first paragraph\n\nsecond paragraph'
    expect(serialize(md)).toBe('first paragraph\n\nsecond paragraph\n')
  })

  it('keeps a heading separate from the following paragraph', () => {
    const md = '# Title\n\ntext'
    expect(serialize(md)).toBe('# Title\n\ntext\n')
  })

  it('keeps mixed blocks (para, list, para) separated', () => {
    const md = 'intro\n\n- one\n- two\n\noutro'
    const out = serialize(md)
    expect(out).toBe('intro\n\n- one\n- two\n\noutro\n')
  })

  it('does not mangle a list when the doc has only one list', () => {
    const md = '- one\n- two\n- three'
    expect(serialize(md)).toBe('- one\n- two\n- three\n')
  })

  it('keeps a blockquote with multiple paragraphs intact', () => {
    const md = '> para one\n>\n> para two'
    const out = serialize(md)
    expect(out).toContain('> para one')
    expect(out).toContain('> para two')
    const re = markdownToProse(out, schema)
    const quote = re.content.firstChild
    expect(quote?.type.name).toBe('blockquote')
    expect(quote?.childCount).toBe(2)
    expect(quote?.firstChild?.type.name).toBe('paragraph')
    expect(quote?.lastChild?.type.name).toBe('paragraph')
  })

  it('preserves an external link destination', () => {
    expect(serialize('[foo](https://example.com)')).toBe('[foo](https://example.com)\n')
  })

  it('preserves a relative markdown link destination', () => {
    expect(serialize('[foo](notes/readme.md)')).toBe('[foo](notes/readme.md)\n')
  })

  it('preserves a link title', () => {
    expect(serialize('[foo](https://example.com "The Title")')).toBe(
      '[foo](https://example.com "The Title")\n',
    )
  })

  it('preserves a URL containing parentheses', () => {
    expect(serialize('[foo](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
      '[foo](https://en.wikipedia.org/wiki/Foo_(bar))\n',
    )
  })
})

describe('table round-trip', () => {
  it('parses the first GFM row as header cells and emits a delimiter row', () => {
    const markdown = '| Item | Q1 |\n| --- | --- |\n| Widget | 120 |'
    const doc = markdownToProse(markdown, schema)
    const table = doc.firstChild!
    expect(table.type.name).toBe('table')
    expect(table.attrs.value).toBe('| Item | Q1 |\n| --- | --- |\n| Widget | 120 |')
    expect(table.childCount).toBe(0)
    expect(proseToMarkdown(doc)).toBe(markdown + '\n')
  })

  it('round-trips a table through the delimiter-less, pipe-safe path', () => {
    const doc = markdownToProse('| a\\|b |\n| --- |\n| c | d |', schema)
    expect(proseToMarkdown(doc)).toBe('| a\\|b |  |\n| --- | --- |\n| c | d |\n')
  })

  it('keeps bold inline markdown inside cells', () => {
    const doc = markdownToProse('| **A** | B |\n| --- | --- |', schema)
    expect(proseToMarkdown(doc)).toBe('| **A** | B |\n')
  })
})

describe('further parse paths', () => {
  it('records a non-default list start value', () => {
    const doc = markdownToProse('2. b\n3. c', schema)
    const list = doc.firstChild!
    expect(list.type.name).toBe('ordered_list')
    expect(list.attrs.order).toBe(2)
    expect(serialize('2. b\n3. c')).toBe('2. b\n3. c\n')
  })

  it('turns raw html into a paragraph', () => {
    const doc = markdownToProse('<div>hi</div>', schema)
    expect(doc.firstChild?.type.name).toBe('paragraph')
    expect(doc.firstChild?.textContent).toBe('<div>hi</div>')
    expect(serialize('<div>hi</div>')).toBe('<div>hi</div>\n')
  })

  it('keeps a hard break inline', () => {
    const doc = markdownToProse('a  \nb', schema)
    const para = doc.firstChild!
    expect(para.child(1).type.name).toBe('hard_break')
    expect(serialize('a  \nb')).toBe('a  \nb\n')
  })

  it('keeps a single newline as a soft break inside one paragraph', () => {
    // Claude-style manually wrapped lines: single \n is NOT a paragraph or hard
    // break — it stays in one paragraph text node and renders as a plain space.
    const doc = markdownToProse('line one\nline two\nline three', schema)
    expect(doc.childCount).toBe(1)
    const para = doc.firstChild!
    expect(para.type.name).toBe('paragraph')
    expect(para.childCount).toBe(1)
    const text = para.firstChild!
    expect(text.isText).toBe(true)
    expect(text.text).toBe('line one\nline two\nline three')
    expect(serialize('line one\nline two\nline three')).toBe(
      'line one\nline two\nline three\n',
    )
  })

  it('round-trips subscript, superscript, and highlight marks', () => {
    expect(serialize('x~s~y')).toBe('x~s~y\n')
    expect(serialize('x^p^y')).toBe('x^p^y\n')
    expect(serialize('x==h==y')).toBe('x==h==y\n')
  })

  it('round-trips a code span', () => {
    expect(serialize('a `code` b')).toBe('a `code` b\n')
  })

  it('round-trips a multi-paragraph list item', () => {
    const md = '- a\n\n  b'
    const doc = markdownToProse(md, schema)
    expect(doc.firstChild?.type.name).toBe('bullet_list')
    expect(doc.firstChild?.firstChild?.childCount).toBe(2)
    expect(serialize(md)).toBe('- a\n  b\n')
  })

  it('keeps a shebang inside a bare code fence', () => {
    const doc = markdownToProse('```#!python\nprint(1)\n```', schema)
    const block = doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.textContent.startsWith('#!python')).toBe(true)
    expect(serialize('```#!python\nprint(1)\n```')).toBe('```\n#!python\nprint(1)\n```\n')
  })

  it('parses an empty document into an empty paragraph', () => {
    const doc = markdownToProse('', schema)
    expect(doc.childCount).toBeGreaterThan(0)
    expect(doc.firstChild?.type.name).toBe('paragraph')
  })
})

describe('code fence robustness', () => {
  it('does not crash parsing an empty fenced code block', () => {
    const doc = markdownToProse('intro\n\n```markdown\n```\n\noutro', schema)
    const blocks = doc.content
    expect(blocks.child(1).type.name).toBe('code_block')
    expect(blocks.child(1).childCount).toBe(0)
    expect(blocks.child(1).textContent).toBe('')
    expect(proseToMarkdown(doc)).toBe('intro\n\n```markdown\n\n```\n\noutro\n')
  })

  it('does not crash re-parsing the mangled nested-fence output', () => {
    const broken = '```markdown\n```#!sh\necho "Hello from a code block!"\n```\n```'
    // The mangled fences parse as two code blocks (the trailing one empty) —
    // the crash was schema.text('') on that empty block. Re-serializing must
    // stay parseable and stable instead of throwing.
    const out = proseToMarkdown(markdownToProse(broken, schema))
    expect(proseToMarkdown(markdownToProse(out, schema))).toBe(out)
  })

  it('round-trips a 4-backtick outer fence holding a ```example``` inner fence', () => {
    const md = '````markdown\n```#!sh\necho "Hello from a code block!"\n```\n````'
    expect(serialize(md)).toBe(md + '\n')
  })

  it('uses a longer fence when the content itself contains a long backtick run', () => {
    const md = '`````\na ````` b\n`````'
    const doc = markdownToProse(md, schema)
    const block = doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.textContent).toBe('a ````` b')
    // 5 backticks inside ⇒ 6-backtick fence outside.
    expect(proseToMarkdown(doc)).toBe('``````\na ````` b\n``````\n')
  })

  it('round-trips a mermaid block containing a backtick run', () => {
    const md = '```mermaid\ngraph TD\n  a --> b\n```'
    expect(serialize(md)).toBe(md + '\n')
    const withTicks = '````mermaid\n``` something\n````'
    const out = proseToMarkdown(markdownToProse(withTicks, schema))
    expect(out).toBe('````mermaid\n``` something\n````\n')
    // Longer inner run ⇒ longer outer fence: a 4-backtick run needs 5.
    expect(serialize('`````mermaid\n```` x ````\n`````')).toBe(
      '`````mermaid\n```` x ````\n`````\n',
    )
  })
})

describe('block offsets', () => {
  it('builds one offset per top-level block', () => {
    const doc = markdownToProse('aa\n\n```js\nb\n```', schema)
    const offsets = buildBlockOffsets(doc)
    expect(offsets.length).toBe(2)
    expect(offsets[0].nodePos).toBe(1)
    expect(offsets[0].id).toBeTruthy()
  })

  it('extracts the markdown for a single block', () => {
    const doc = markdownToProse('# title\n\ntext', schema)
    const offsets = buildBlockOffsets(doc)
    expect(extractBlockMarkdown(doc, offsets, offsets[0].id)).toBe('# title')
    expect(extractBlockMarkdown(doc, offsets, offsets[1].id)).toBe('text')
    expect(extractBlockMarkdown(doc, offsets, 'nope')).toBe('')
  })

  it('extracts a nested list item directly', () => {
    const doc = markdownToProse('- one\n- two', schema)
    const offsets = buildBlockOffsets(doc)
    expect(extractBlockMarkdown(doc, offsets, offsets[0].id)).toBe('- one\n- two')
  })
})

describe('masked field round-trip', () => {
  it('survives a ProseMirror round-trip with a real ciphertext envelope', async () => {
    const envelope = await encryptField('hunter2-secret', 'a password')
    const mdTable = `token: !masked[${envelope}]`
    const out = serialize(mdTable)
    expect(out).toContain(envelope)
    expect(out).not.toContain('hunter2-secret')
    const reparsed = markdownToProse(out, schema)
    const node = reparsed.firstChild!.child(1)
    expect(node.type.name).toBe('masked_field')
    expect(node.attrs.content).toBe(envelope)
    expect(node.attrs.label).toBe('')
  })

  it('survives a ProseMirror round-trip with a label', () => {
    const md = 'key: !masked[AQIDBA==]{label="Recovery"}'
    const out = serialize(md)
    expect(out).toBe('key: !masked[AQIDBA==]{label="Recovery"}\n')
    const reparsed = markdownToProse(out, schema)
    const node = reparsed.firstChild!.child(1)
    expect(node.type.name).toBe('masked_field')
    expect(node.attrs.content).toBe('AQIDBA==')
    expect(node.attrs.label).toBe('Recovery')
  })

  it('never serializes any reveal state — the node model only holds content and label', () => {
    const field = schema.nodes.masked_field.create({ content: 'ct', label: 'L' })
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [field])])
    expect(Object.keys(field.attrs).sort()).toEqual(['content', 'label'])
    const out = proseToMarkdown(doc)
    expect(out).toBe('!masked[ct]{label="L"}\n')
    expect(out).not.toContain('revealed')
  })

  it('strips rejected label characters during serialization', () => {
    const field = schema.nodes.masked_field.create({ content: 'ct', label: 'a]b' })
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [field])])
    expect(proseToMarkdown(doc)).toBe('!masked[ct]{label="ab"}\n')
  })
})

describe('nested inline mark round-trip (bold wrapping code spans)', () => {
  // Regression: ProseMirror sorts marks by type rank, and Markdown code spans
  // are literal, so a code mark nested inside bold must be emitted *innermost*
  // (``**`x`**``), never outermost (`` `**x**` ``).

  it('keeps bold wrapping a code span', () => {
    expect(serialize('**`fieldName`**')).toBe('**`fieldName`**\n')
  })

  it('keeps bold code spans in a list item', () => {
    const md =
      '- **`fieldName`** is deliberately populated from **`sourceName`**'
    expect(serialize(md)).toBe('- **`fieldName`** is deliberately populated from **`sourceName`**\n')
  })

  it('keeps bold code minimal repro stable', () => {
    expect(serialize('**`inline_code`** and more text.')).toBe('**`inline_code`** and more text.\n')
  })

  it('keeps a code span inside em/italic', () => {
    expect(serialize("*`em code`*")).toBe("*`em code`*\n")
  })

  it('keeps a code span inside a link', () => {
    expect(serialize('[`code`](https://example.com/a)')).toBe(
      '[`code`](https://example.com/a)\n',
    )
  })

  it('keeps a code span inside strikethrough', () => {
    expect(serialize('~~`struck code`~~')).toBe('~~`struck code`~~\n')
  })

  it('keeps bold + italic wrapping code', () => {
    expect(serialize('***`bold italic code`***')).toBe('***`bold italic code`***\n')
  })

  it('leaves literal asterisks inside a plain code span alone', () => {
    expect(serialize('`**was literal**`')).toBe('`**was literal**`\n')
  })
})

describe('inline mark runs across multiple text nodes', () => {
  // A mark that wraps several inline parts (e.g. bold around plain text *and* a
  // nested code span) spans multiple ProseMirror text nodes; the serializer
  // must keep the shared outer mark open across the run instead of emitting a
  // fresh delimiter pair per node (`**`code`**** words**`).

  it('keeps bold spanning a leading code span and text', () => {
    expect(serialize('**`fieldName` some text**')).toBe('**`fieldName` some text**\n')
  })

  it('keeps bold spanning text, a code span, and trailing text', () => {
    expect(serialize('**prefix `code` suffix**')).toBe('**prefix `code` suffix**\n')
  })

  it('keeps a link spanning text and a code span', () => {
    expect(serialize('[foo `bar` baz](https://example.com/a)')).toBe(
      '[foo `bar` baz](https://example.com/a)\n',
    )
  })

  it('keeps bold wrapping a link and surrounding text', () => {
    expect(serialize('**foo [bar](https://example.com/a) baz**')).toBe(
      '**foo [bar](https://example.com/a) baz**\n',
    )
  })

  it('keeps italic wrapping a bold span and surrounding text', () => {
    expect(serialize('*a **b** c*')).toBe('*a **b** c*\n')
  })

  it('keeps bold-italic wrapping a code span and text', () => {
    expect(serialize('***`x` y***')).toBe('***`x` y***\n')
  })
})

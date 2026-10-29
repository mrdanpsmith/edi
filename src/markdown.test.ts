import { describe, it, expect } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown, sliceMarkdown, buildBlockOffsets, extractBlockMarkdown } from './markdown'
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

  it('preserves column alignment from the delimiter row through a round-trip', () => {
    const markdown = '| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'
    const doc = markdownToProse(markdown, schema)
    expect(doc.firstChild!.attrs.value).toBe(markdown)
    expect(proseToMarkdown(doc)).toBe(markdown + '\n')
  })
})

describe('resolved tables', () => {
  // Mark every top-level table `_resolved` and serialize, mirroring what a user
  // toggling "Resolve formulas?" on a document would save.
  function resolveTables(markdown: string): string {
    const doc = markdownToProse(markdown, schema)
    const children: import('prosemirror-model').Node[] = []
    doc.forEach((c) => children.push(c))
    const resolved = children.map((c) =>
      c.type.name === 'table'
        ? schema.node('table', { value: c.attrs.value, _resolved: true })
        : c,
    )
    return proseToMarkdown(schema.node('doc', {}, resolved))
  }

  it('serializes a resolved table with a carrier comment', () => {
    const out = resolveTables('| A | B |\n| --- | --- |\n| 10 | =A2*2 |')
    expect(out).toBe(
      '| A | B |\n| --- | --- |\n| 10 | 20 |\n\n<!-- edi-fml {"B2":"=A2*2"} -->\n',
    )
  })

  it('round-trips a resolved table back into editable formulas', () => {
    const baked = resolveTables('| A | B |\n| --- | --- |\n| 10 | =A2*2 |')
    const doc = markdownToProse(baked, schema)
    const table = doc.firstChild!
    expect(table.type.name).toBe('table')
    expect(table.attrs._resolved).toBe(true)
    expect(table.attrs.value).toBe('| A | B |\n| --- | --- |\n| 10 | =A2*2 |')
    expect(proseToMarkdown(doc)).toBe(baked)
  })

  it('leaves a dynamic table byte-identical (no carrier comment)', () => {
    const markdown = '| A | B |\n| --- | --- |\n| 10 | =A2*2 |'
    expect(serialize(markdown)).toBe(markdown + '\n')
  })

  it('resolves two tables independently without crossing comments', () => {
    const out = resolveTables('first\n\n| A |\n| --- |\n| =1+1 |\n\nsecond\n\n| B |\n| --- |\n| =2*3 |')
    const doc = markdownToProse(out, schema)
    expect(doc.childCount).toBe(4)
    const tables: import('prosemirror-model').Node[] = []
    doc.forEach((n) => {
      if (n.type.name === 'table') tables.push(n)
    })
    expect(tables.length).toBe(2)
    for (const t of tables) expect(t.attrs._resolved).toBe(true)
    expect(tables[0]!.attrs.value).toBe('| A |\n| --- |\n| =1+1 |')
    expect(tables[1]!.attrs.value).toBe('| B |\n| --- |\n| =2*3 |')
  })

  it('keeps alignment on the resolved round trip', () => {
    const out = resolveTables('| A | B |\n| :--- | ---: |\n| 1 | =A2*2 |')
    expect(out).toBe(
      '| A | B |\n| :--- | ---: |\n| 1 | 2 |\n\n<!-- edi-fml {"B2":"=A2*2"} -->\n',
    )
    const doc = markdownToProse(out, schema)
    expect(doc.firstChild!.attrs.value).toBe('| A | B |\n| :--- | ---: |\n| 1 | =A2*2 |')
  })

  it('resolves a table nested inside a blockquote', () => {
    const table = schema.node('table', {
      value: '| A |\n| --- |\n| =1+1 |',
      _resolved: true,
    })
    const md = proseToMarkdown(schema.node('doc', {}, [
      schema.node('blockquote', {}, [table]),
    ]))
    expect(md).toBe(
      '> | A |\n> | --- |\n> | 2 |\n>\n> <!-- edi-fml {"A2":"=1+1"} -->\n',
    )
    const doc = markdownToProse(md, schema)
    const quote = doc.firstChild!
    expect(quote.type.name).toBe('blockquote')
    const roundTripped = quote.firstChild!
    expect(roundTripped.type.name).toBe('table')
    expect(roundTripped.attrs._resolved).toBe(true)
    expect(roundTripped.attrs.value).toBe('| A |\n| --- |\n| =1+1 |')
    expect(proseToMarkdown(doc)).toBe(md)
  })

  it('leaves a foreign comment after a table as raw source', () => {
    const doc = markdownToProse('| A |\n| --- |\n| 1 |\n\n<!-- hello -->', schema)
    expect(doc.firstChild!.type.name).toBe('table')
    expect(doc.firstChild!.attrs._resolved).toBe(false)
    const last = doc.content.child(doc.childCount - 1)
    expect(last.type.name).toBe('source_block')
    expect(last.attrs.markdown).toBe('<!-- hello -->')
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

  it('keeps raw html as a source block', () => {
    const doc = markdownToProse('<div>hi</div>', schema)
    expect(doc.firstChild?.type.name).toBe('source_block')
    expect(doc.firstChild?.attrs.markdown).toBe('<div>hi</div>')
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
    // **The blank line is the item's own second block boundary**, not decoration:
    // written directly under the first, `b` is a lazy continuation of the same
    // paragraph and the item comes back holding one block instead of two.
    expect(serialize(md)).toBe('- a\n\n  b\n')
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

describe('blocks inside a list item', () => {
  /** Parse, save, reopen: the pair that turns a saved file back into a document. */
  function reopen(markdown: string): { saved: string; doc: unknown } {
    const saved = serialize(markdown)
    return { saved, doc: markdownToProse(saved, schema).toJSON() }
  }

  it('keeps a fenced code block inside a numbered step', () => {
    const md = '1. Install:\n\n   ```bash\n   npm install thing\n   ```\n2. Run:\n\n   ```bash\n   npm run thing\n   ```\n'
    // **The content lines carry the item's indent, not just the fence lines.**
    // Written at column 0 the closing fence ends the *list*, and the next parse
    // reads the code as prose and everything after it as a document of its own —
    // so one save is enough to lose the steps, and the next one loses the rest.
    expect(serialize(md)).toBe(md)
    expect(reopen(md).doc).toEqual(markdownToProse(md, schema).toJSON())
  })

  it('does not turn a step’s fence into an indented code block', () => {
    // The task marker is `- [ ]` — five characters — but the item's content
    // starts after `- `, at column 2. Measuring the content indent off the whole
    // marker put the fence four columns past that, which is exactly what makes
    // an *indented* code block: the ``` stopped being a fence and became the
    // item's own prose, and the block came back holding the fence text.
    const md = '- [ ] Step:\n\n  ```bash\n  npm i\n  ```\n'
    expect(serialize(md)).toBe(md)
    const doc = markdownToProse(serialize(md), schema)
    const item = doc.firstChild!.firstChild!
    expect(item.attrs.checked).toBe(false)
    expect(item.child(1).type.name).toBe('code_block')
    expect(item.child(1).textContent).toBe('npm i')
  })

  it('keeps a task step whose first block is a fence', () => {
    // GFM only reads a checkbox as a task marker when inline content follows it,
    // so this item has no spelling of its own: the marker stands alone on its
    // line, with **no blank line** under it (a blank line there ends the item),
    // and reading it back is what `listItem`'s checkbox-token case is for.
    const md = '- [x]\n  ```bash\n  npm i\n  ```\n'
    expect(serialize(md)).toBe(md)
    const item = markdownToProse(serialize(md), schema).firstChild!.firstChild!
    expect(item.attrs.checked).toBe(true)
    expect(item.childCount).toBe(1)
    expect(item.child(0).type.name).toBe('code_block')
    expect(item.child(0).textContent).toBe('npm i')
  })

  it('keeps two paragraphs in one item as two paragraphs', () => {
    // Directly under the first, `b` is a lazy continuation of the same
    // paragraph, so the item loses a block on every save.
    expect(serialize('- a\n\n  b')).toBe('- a\n\n  b\n')
  })

  it.each([
    ['a fence in a nested step', '1. a\n\n   1. b\n\n      ```bash\n      npm i\n      ```\n'],
    ['a fence in a task step nested under a step', '- [ ] a\n\n  1. b\n\n     ```bash\n     npm i\n     ```\n'],
    ['a two-digit marker', '10. a\n\n    ```bash\n    npm i\n    ```\n'],
    ['a blank line inside the fence', '1. a\n\n   ```bash\n   x\n\n   y\n   ```\n'],
    ['a mermaid diagram', '1. a\n\n   ```mermaid\n   graph TD\n     A --> B\n   ```\n'],
    ['a table', '1. a\n\n   | A | B |\n   | --- | --- |\n   | 1 | 2 |\n'],
    ['a rule', '1. a\n\n   ---\n'],
    ['a heading', '1. a\n\n   ## Sub\n'],
    ['a hard break', '1. a\n\n   one  \n   two\n'],
    ['a deeply nested fence', '1. a\n\n   - b\n\n     - c\n\n       ```bash\n       npm i\n       ```\n'],
    ['an empty item holding a fence', '1.\n   ```bash\n   npm i\n   ```\n'],
  ])('round-trips %s in a list item', (_name, md) => {
    const { saved, doc } = reopen(md)
    expect(saved).toBe(md)
    expect(doc).toEqual(markdownToProse(md, schema).toJSON())
  })

  it('opens a file that holds an empty list item', () => {
    // `list_item` is `block+`, so an empty fragment is not a legal one and
    // `schema.node` throws — taking the *whole document* down with it, so a
    // single bare `-` anywhere in a file means the file will not open at all.
    expect(serialize('- a\n-\n- c')).toBe('- a\n-\n- c\n')
    expect(markdownToProse('1.\n', schema).firstChild!.firstChild!.childCount).toBe(1)
  })

  it('leaves a checkbox that is written as words alone', () => {
    // A marker with content after it is not a task marker, so it is text.
    expect(markdownToProse('- [x] literally\n', schema)
      .firstChild!.firstChild!.firstChild!.textContent).toBe('literally')
    // And a marker with *nothing* after it is the one shape the checkbox-token
    // case claims — which is the reading GFM declines, since a task marker needs
    // content after it to be one.
    const bare = markdownToProse('- [ ]\n', schema).firstChild!.firstChild!
    expect(bare.attrs.checked).toBe(false)
    expect(bare.childCount).toBe(1)
    expect(bare.child(0).type.name).toBe('paragraph')
    expect(bare.child(0).childCount).toBe(0)
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

describe('heading custom ids', () => {
  function docMarkdown(markdown: string): import('prosemirror-model').Node {
    return markdownToProse(markdown, schema)
  }

  it('parses a trailing {#id} into the heading id attr and strips it from text', () => {
    const doc = docMarkdown('### My Great Heading {#custom-id}\n')
    const h = doc.firstChild!
    expect(h.type.name).toBe('heading')
    expect(h.attrs.id).toBe('custom-id')
    expect(h.textContent).toBe('My Great Heading')
  })

  it('round-trips a custom id', () => {
    expect(serialize('### My Great Heading {#custom-id}\n')).toBe(
      '### My Great Heading {#custom-id}\n',
    )
  })

  it('leaves a heading without a marker without an id', () => {
    const doc = docMarkdown('# Just a Heading\n')
    expect(doc.firstChild!.attrs.id).toBeNull()
    expect(doc.firstChild!.textContent).toBe('Just a Heading')
  })

  it('does not treat a marker mid-word as an id', () => {
    const doc = docMarkdown('# C#{#not-an-id} code\n')
    expect(doc.firstChild!.attrs.id).toBeNull()
  })
})

it('round-trips an encrypted_block fence', () => {
  const md = '```encrypted type="paragraph" label="Secret"\nYWJjMTIz\n```\n\nafter\n'
  expect(serialize(md)).toBe(md)
})

describe('sliceMarkdown', () => {
  it('serializes exactly the blocks a slice covers', () => {
    const doc = markdownToProse('# Title\n\npara **bold**\n\n- a\n- b', schema)
    const slice = doc.slice(0, doc.child(0).nodeSize + doc.child(1).nodeSize)
    expect(sliceMarkdown(slice.content, schema)).toBe('# Title\n\npara **bold**')
  })

  it('serializes a partial paragraph', () => {
    const doc = markdownToProse('hello world', schema)
    expect(sliceMarkdown(doc.slice(1, 6).content, schema)).toBe('hello')
  })
})

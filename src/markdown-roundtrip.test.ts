import { describe, expect, it } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'

const parse = (md: string) => markdownToProse(md, schema)
const save = (md: string) => proseToMarkdown(parse(md))

/** Files the serializer writes in its own style: opening and saving them must
 * not change a byte. */
const CANONICAL = [
  'Escaped \\*not emphasis\\* stays text\n',
  '\\# not a heading\n',
  '1\\. not a list\n',
  '\\- not a bullet\n',
  '\\> not a quote\n',
  'a \\&lt;script\\&gt; b\n',
  'an \\<b> tag that is text\n',
  '\\[not a link](x)\n',
  'snake_case and AT&T and a < b and 5 * 3 and ~5 min\n',
  'about ~9px and ~48px, 2 * 3 * 4\n',
  'a <b>bold</b> c\n',
  'text[^1]\n\n[^1]: The note.\n',
  'See [the docs][d] and [d] and [d][].\n\n[d]: https://example.com "Docs"\n',
  '---\ntitle: x\ntags: [a, b]\n---\n\n# Body\n',
  '```js title="a.js"\nconst a = 1\n```\n',
  '![alt](i.png "A title")\n',
  '[![badge](https://img/b.svg)](https://ci)\n',
  '``a`b``\n',
  '` ``fenced`` `\n',
  '[a](<x y>)\n',
  '[q](u "say \\"hi\\"")\n',
  '# Issue \\#\n',
  '<div>\n  <p>html block</p>\n</div>\n',
  '<!-- a comment -->\n',
  '- item\n\n  [^n]: inside a list\n',
  '> [r]: https://quoted.example\n',
  '**bold** *em* ~~strike~~ ==mark== ~sub~ ^sup^ `code`\n',
  'a  \nb\n',
  '| Item | Total |\n| --- | --- |\n| \\*not em\\* and 5 * 3 | =2*3 |\n',
  // Edi's own constructs, as docs/format.md specifies them.
  '## Setup {#install}\n',
  // Left out of every HTML copy (`isScriptUrl`), but the file keeps it.
  '[run](javascript:alert(1))\n',
  'H~2~O and x^2^\n',
  'Key: !masked[AgABAg==] and !masked[AgABAg==]{label="say \\"hi\\""}\n',
  '```encrypted label="Credentials"\nAgABAg==\n```\n',
  '| Item | Q1 | Total |\n| --- | --- | --- |\n| Widget | 120 | 120 |\n\n<!-- edi-fml {"C2":"=SUM(B2)"} -->\n',
  '```edi-formula\nTAX(amount) = ROUND(amount * 0.2, 2)\n```\n',
  '```\n#!/usr/bin/env python3 -u\nprint(1)\n```\n',
  '```mermaid\nkanban\n  todo[To do]\n    a[Write the spec]\n```\n',
]

/** Input in other styles: the saved form may differ, but must read back as the
 * same document, and saving that is a fixed point. */
const NON_CANONICAL = [
  '_em_ and __strong__\n',
  '`` a`b ``\n',
  '* star bullet\n* two\n',
  'Setext\n======\n',
  'line one\r\nline two\r\n\r\n```\r\ncode\r\n```\r\n',
  '[ref]: https://x.example\n\n[ref]\n',
  'Trailing ## closed ##\n',
  '<span>inline</span> html and **<i>marked</i>**\n',
  'a\\\\b and C:\\path\\x\n',
  '```#!python3 -u\nprint(1)\n```\n',
]

describe('markdown round trip', () => {
  it.each(CANONICAL)('preserves %j exactly', (md) => {
    expect(save(md)).toBe(md)
  })

  it.each([...CANONICAL, ...NON_CANONICAL])('re-reads %j as the same document', (md) => {
    const once = save(md)
    expect(parse(once).eq(parse(md))).toBe(true)
    expect(save(once)).toBe(once)
  })

  it('writes an info-string shebang as the first line of a bare fence', () => {
    expect(save('```#!python3 -u\nprint(1)\n```\n')).toBe('```\n#!python3 -u\nprint(1)\n```\n')
  })

  it('writes CRLF input with one line ending', () => {
    expect(save('a\r\nb\r\n\r\n```\r\nx\r\n```\r\n')).toBe('a\nb\n\n```\nx\n```\n')
  })
})

describe('typed text survives a save', () => {
  const typed = [
    '*not em*',
    '**not strong**',
    '# hash',
    '1. one',
    '- dash',
    '> quote',
    '[x](y)',
    '![i](p)',
    '&amp;',
    '<b>',
    '`tick`',
    '==hl== and ~s~ and ^u^',
    'back\\slash \\* \\',
    '---',
    '```',
    '[ ] box',
    '__dunder__',
    'x~y~z',
    'a*b*c',
    'see ^1^ note',
  ]

  it.each(typed)('%j reads back as the same text', (text) => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
    const reread = parse(proseToMarkdown(doc))
    expect(reread.childCount).toBe(1)
    expect(reread.firstChild!.type.name).toBe('paragraph')
    expect(reread.firstChild!.textContent).toBe(text)
    expect(reread.firstChild!.firstChild!.marks).toEqual([])
  })

  it('keeps a link whose reference target was edited as an inline link', () => {
    const doc = parse('[d][r]\n\n[r]: https://old.example\n')
    let pos = -1
    doc.descendants((node, p) => {
      if (pos < 0 && node.isText) pos = p
    })
    const link = doc.nodeAt(pos)!.marks[0]!
    const edited = doc.type.schema.marks.link.create({ ...link.attrs, href: 'https://new.example' })
    const tr = doc.type.schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('d', [edited])]),
      doc.child(1),
    ])
    expect(proseToMarkdown(tr)).toBe('[d](https://new.example)\n\n[r]: https://old.example\n')
  })
})

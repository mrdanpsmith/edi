# File format

## What this document promises

This is the specification of what Edi reads from and writes to a document:
every construct beyond CommonMark and GFM, and the bytes around the text. From
1.0 it is Edi's compatibility surface. A document that this page describes
opens in every later 1.x release with the same meaning, and a 1.x release
writes nothing that an earlier 1.x release reads differently.

Everything here is plain text that other markdown tools show as something
sensible: a comment, a fenced block, or literal characters. No construct needs
a sidecar file. How the editor keeps a file unchanged across open and save is
in [architecture.md](architecture.md), "The document is the file".

## Base dialect

Edi parses CommonMark with the GFM extensions (tables, task lists,
strikethrough, autolinks, footnotes) through `remark-parse` and `remark-gfm`
(`src/markdown.ts`). What the editor has no model for is kept as the markdown
it was written as: HTML blocks, link and footnote definitions and YAML front
matter become a `source_block`, inline HTML and footnote references an
`inline_source` atom.

A heading may end in a Pandoc-style explicit id, `## Setup {#install}`. Edi
writes the suffix only when the id differs from the heading's own slug.

## Inline extensions

| Syntax | Meaning | Defined in |
| --- | --- | --- |
| `==text==` | Highlight (`<mark>`) | `src/remark/highlight.ts` |
| `^text^` | Superscript | `src/remark/sup.ts` |
| `~text~` | Subscript (GFM's `~~text~~` stays strikethrough) | `src/remark/sub.ts` |
| `!masked[…]{label="…"}` | Encrypted field, see [Encrypted fields and blocks](#encrypted-fields-and-blocks) | `src/node/masked.ts` |
| `:name:` shortcodes | None. The emoji picker inserts the Unicode character, so a file never holds a shortcode Edi has to expand. | `src/emoji.ts` |

A paired mark closes on a run of the same length as the one that opened it.
Whether a run can open or close depends on the characters on either side, as
with `*` emphasis (`src/remark/pairedDelimiter.ts`).

A single tilde is subscript in Edi; GitHub renders it as strikethrough.
`H~2~O` is the usual case and reads correctly in Edi; a document meant for
GitHub too should write strikethrough as `~~text~~`.

## Spreadsheet tables

A GFM pipe table is a spreadsheet. A cell whose trimmed text starts with `=`
is a formula and is written raw, without markdown escaping, because it is the
formula's source. Cells are addressed A1-style: the header row is row 1, so
the first body row is row 2. The functions, operators and their results are
listed in [`src/docs/formula-reference.md`](../src/docs/formula-reference.md);
for format purposes a function's **name, arity and result** are part of this
specification.

**Resolved tables.** Resolve formulas replaces each formula cell with its
computed display text and writes the formulas in an HTML comment on the line
after the table, separated by one blank line:

```markdown
| Item | Q1 | Q2 | Total |
| --- | --- | --- | --- |
| Widget | 120 | 180 | 300 |

<!-- edi-fml {"D2":"=SUM(B2:C2)"} -->
```

The payload is a JSON object from cell reference to formula
(`formatTableCarrier` in `src/spreadsheet-util.ts`). On load, a table
followed by such a comment gets its formulas back; a reference outside the
table is skipped, so a resolved table edited elsewhere still opens. Other
tools show the computed values and hide the comment.

## Document-local functions

A fenced block tagged `edi-formula` holds one definition per line, callable
from any table in the same document:

```edi-formula
MYAVG(a, b) = (a + b) / 2
TAX(amount) = ROUND(amount * 0.2, 2)  # a comment
```

A definition is `NAME(params) = expression`, where names and parameters match
`[A-Za-z_][A-Za-z0-9_]*` and names are case-insensitive. `#` starts a comment
outside a string literal. Every block in the document contributes to one set
(`src/formulaDsl.ts`), validated together:

- A name that is also a built-in is rejected.
- A repeated name keeps its first definition.
- A definition in, or depending on, a cycle is dropped.

A rejected definition marks its block invalid and the cells that call it show
an error; the file itself is unchanged.

Because a built-in wins over a definition, **adding a built-in can break a
document** that already defines that name. See
[Changing the format](#changing-the-format).

## Encrypted fields and blocks

**A field** is inline: `!masked[ENVELOPE]{label="LABEL"}`. The label is
optional; without one the token is `!masked[ENVELOPE]`. A `"` in the label is
written as `\"`, and a label may not hold `]`, `}`, `\` or a line break
(`src/node/masked.ts`).

**A block** is a fence tagged `encrypted` holding the envelope of one or more
top-level blocks' markdown:

````markdown
```encrypted label="Credentials"
ENVELOPE
```
````

The label drops `"` and backticks, so it fits a fence info string. A `type="…"`
attribute is still read but no longer written.

**The envelope** is base64 of (`src/crypto.ts`):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Format version, 1 or 2 |
| 1 | 16 | PBKDF2 salt |
| 17 | 12 | AES-GCM IV |
| 29 | n | Ciphertext |
| 29+n | 16 | GCM tag |

The key is PBKDF2-HMAC-SHA-256 over the password, 600,000 iterations, 256
bits. Version 2 binds the envelope to its place: GCM's additional data is
`"<version>\0<kind>\0<label>"`, kind being `field` or `block`, so a relabelled
or moved envelope does not open. Version 1 has no additional data. Edi reads
both and writes version 2. A version this build does not know is reported as
"newer", never as a wrong password.

The plaintext of a block is markdown in this format; a block never contains
another encrypted block.

## Runnable code blocks

A fenced block is runnable when its first line starts with `#!`, or its info
string does:

````markdown
```#!/usr/bin/env python3 -u
print("hi")
```
````

An info-string shebang is moved into the content as the first line on load,
so the two forms mean the same thing; an edited block is written back as a
bare fence with the shebang as line one (`src/exec.ts`, `src/markdown.ts`).

The shebang is split on whitespace, with no quoting (`parse_shebang` in
`backend/exec.py`). For `env`, leading flags are skipped and the next word is
the interpreter. Only the interpreter's basename counts, and it must be one of
`python`, `python3`, `py`, `sh`, `shell`, `bash`, `node`, `js`, `javascript`,
`ruby`, `rb`, `perl` or `pl`; the remaining words are passed as flags and the
block body arrives on stdin. Removing a name from that list breaks the
documents that use it.

Output is never saved: a result cell lives only in the open editor.

## Mermaid blocks and files

A fence tagged `mermaid` is a diagram. Its content is Mermaid source,
unchanged by Edi beyond the edits the user makes; kanban boards are ordinary
Mermaid `kanban` source. Which Mermaid syntax a block accepts follows the
bundled Mermaid version, so a Mermaid upgrade is a format change to check.

A `.mmd` or `.mermaid` file holds bare diagram source, with no fence. Edi
opens it as one diagram block and writes the source back without a fence
(`src/documentFormat.ts`; [mermaid.md](mermaid.md), "Mermaid files").

## Bytes on disk

A document is UTF-8, read with `utf-8-sig` and universal newlines
(`backend/files.py`), so the editor only ever sees `\n` and no byte-order mark.
A save keeps the line ending and BOM of the file it replaces; a new file gets
the platform's line ending. Opening and saving without an edit writes the
same bytes; `src/markdown-roundtrip.test.ts` holds the files that must survive
that.

Edi writes nothing beside a document. Version history lives in Edi's app-data
folder ([history.md](history.md)).

## Changing the format

Within 1.x a change may only add, and what it adds must degrade in an older
1.x release to something that release keeps intact:

- **New syntax** goes in a fenced block with a new tag, or an HTML comment
  with an `edi-` prefix. An older release keeps both as source and saves them
  back unchanged, so a document round-trips through it. New inline punctuation
  does not qualify: an older release would read it as text and escape it on
  the next edit.
- **New built-in functions** are additive for cells but collide with a
  document function of the same name, which then stops working. The commit
  that adds one names it in its subject, so the changelog does too
  ([releasing.md](releasing.md)).
- **Removing or renaming** a built-in, an interpreter name, an attribute or a
  marker is a 2.0 change.
- **The envelope** changes only by a new version byte. An older release
  reports the envelope as newer and leaves it untouched.
- **A Mermaid upgrade** is checked against the diagram fixtures before it
  ships, since it can change what a `mermaid` block accepts.

Every change to this page comes with a fixture in
`src/markdown-roundtrip.test.ts` that opens and saves the construct byte for
byte.

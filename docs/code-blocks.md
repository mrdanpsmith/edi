# Code blocks

A fenced code block is one `code_block` node: a textblock with `code: true`,
plain text only, and a `language` attr. What the reader sees, and therefore how
every key, paste and press behaves in it, depends on which of two renderers
draws it. Block modes (Visual/Source) are separate and covered in
[block-modes.md](block-modes.md); this is the Visual form.

## Raw blocks

Markdown the editor has no model for (an HTML block, YAML front matter, a link
or footnote definition) is a `code_block` with `raw: true`, so it is shown,
selected and edited exactly as a fenced block is, keys and mouse included. It
stays that until Edi renders HTML.

- **On disk it is its text.** `rawCodeBlock` (`src/markdown.ts`) builds it from
  the parse, and the serializer writes a raw block's text with no fences, so a
  file saves byte for byte (`src/markdown-roundtrip.test.ts`).
- **It is highlighted by what it holds**: `language` is `html`, `yaml` (front
  matter) or `markdown` (definitions), from `rawBlockLanguage` in
  `src/schema.ts`. The badge names it instead of the grammar (`rawBlockLabel`:
  "HTML", "Front matter", "Link definition", "Footnote", else "Markdown").
- **It has one state**: no Source form (it would be the same text), so no Source
  button and Alt+click does nothing (`isSourceOnly` in `src/block-modes.ts`). It
  is never run, whatever its first line.
- Backspace at its start turns it into paragraphs, as for any code block.
- Moving a document rebases the relative references in its text
  (`src/relink.ts`), as for a link.
- The clipboard's HTML marks it `pre[data-raw]`, so it pastes back raw.
  `[data-source-block]`, the form older builds wrote, is read as raw too.

**Inline HTML is the inline counterpart**: raw inline code, a `code` mark with
`raw: true` (`code[data-raw]` in the DOM). An opening tag runs to its own
closing tag, counting nested tags of the same name, so `<a href="…">link</a>`
is one editable run; a tag that closes nothing (`<br>`, a comment) is a run of
its own. It is written back exactly as written, with no backticks.

Which of the two a tag becomes is CommonMark's rule, not the tag's: a line that
is only a complete tag (`<img src="…"/>`, `<a href="…">`) starts an HTML block,
unless it would interrupt a paragraph; a tag with text after it on its line
(`<a href="…">link</a>`) is inline. Edi's own types are not HTML and are not
affected; the one comment Edi reads, a table's `<!-- edi-fml … -->` formula
carrier, is taken with its table before raw HTML is looked at.

## Two renderers, one node

`RunnableBlockNodeView` (`src/node/execblock.ts`) draws every Visual code block
in one of two ways:

| The block resolves to | Renderer | Its text is |
| --- | --- | --- |
| a grammar, from its language tag or else its shebang | an embedded CodeMirror (`createCodeEditor`) | CodeMirror's, mirrored into the node by `commitEditorText` |
| nothing | a `<pre><code>` that is ProseMirror's own `contentDOM` | ProseMirror's, edited natively |

`codeLanguageLabel` (`src/codeLanguages.ts`) is the one answer to "which
grammar". It builds nothing, so the node view can ask it on every keystroke;
`codeLanguageFor` builds the grammar from its label, and `isCodeEditorBlock`
(`src/selectionExpand.ts`) asks the same function, so the selection rules and
the renderer cannot disagree about which blocks are CodeMirror. It looks names
up as **own keys only**: a shebang naming `constructor` must not find
`Object.prototype`'s.

**The renderer follows the text.** `update` returns false, rebuilding the view,
whenever the resolved grammar changes, not only when the `language` attr does.
Finishing `#!/usr/bin/env python3` turns a plain block into a Python one;
deleting the interpreter turns it back. The **badge** (`syncBadge`) is
different: it follows the shebang's interpreter in place, so typing `pyt…`
renames it on every key without rebuilding anything.

**A rebuild hands the caret over.** The view being replaced is the one taking
the typing, so:

- plain → CodeMirror: the typing was in ProseMirror's `contentDOM`, so focus is
  on ProseMirror's root with a selection inside a block that no longer has a DOM
  caret. `handCaretToCodeEditor`, a plugin-view `update`, focuses the new
  CodeMirror at the same offset. It only acts after a document change and only
  when ProseMirror's own root has focus, so it cannot take focus from a grid, a
  dialog or another CodeMirror.
- CodeMirror → plain, or another grammar: `commitEditorText` sees that its edit
  changes the grammar, puts ProseMirror's selection where CodeMirror's caret
  was, and focuses whatever replaced it. It is deferred to a microtask because it
  runs inside CodeMirror's own update, which must not have its view destroyed
  underneath it.

A rebuilt CodeMirror starts with an empty undo history. The document-level
undo still has the edits.

## Typing a fence

A line that is only ```` ``` ````, optionally with an info string, becomes a
code block on space (the `fenceRule` input rule) or on Enter
(`blockStartKeymap`), both in `src/blockstart.ts`. A fence followed by text on
the same line is prose and declines.

- **The caret goes to the end of the new block's text.** For a language fence
  the block is empty, so that is its only position.
- **A shebang keeps the key that closed it.** ```` ```#!/usr/bin/env ```` +
  space is half of `#!/usr/bin/env python3`, so the space stays in the line;
  Enter puts the caret on line two. A language tag's space is only the trigger
  and is dropped.
- A CodeMirror-drawn block has no DOM caret for ProseMirror's selection, so
  the transaction carries `FENCE_OPENED_META` and `focusOpenedFence` hands
  focus to that CodeMirror, at the end of its text, once it is drawn.

`mermaid` is the exception: it inserts a diagram atom and opens it in Source.

## Pasting into a code block

The paste routes build blocks: one paragraph per line (`insertPastedText`),
parsed markdown (`pasteAsMarkdown`) or parsed HTML, spliced in open at depth 1.
Inside a code block that splice would merge the first line into the code and
put the rest after the block, so code blocks are answered before it.

`pasteIntoCode` (`src/paste.ts`) answers first on every route (Edit → Paste
in `editController.ts`, Paste as Markdown, and the URL-linking `handlePaste`):
when the selection is wholly inside one code block, the clipboard's characters
go in as text, line endings normalised to `\n`, nothing linked or parsed. Edit →
Paste prefers the `text/plain` leg there, because an Edi copy's markdown leg
would bring its fences with it.

## Code block keys

**Notion's block-editor model**, chosen because its semantics are already
understood. A code block is a textblock, and ProseMirror's own commands would
treat it as text (joining it into the paragraph before, or the next line into
it), so it gets two rules of its own:

1. **Backspace at the start of a block turns it into plain text.** For a code
   block that is one paragraph per line, the text kept and the caret at the
   start of the first: the same as deleting its fences in Source. A second
   Backspace is then an ordinary paragraph's.
2. **A whole block is deleted by selecting it, then deleting.** Esc inside a
   code block selects it (Notion's gesture, from a caret or a selection of its
   text); so does a press on its frame or a drag across it (see below). A delete
   key never selects the block it is pressed inside.

`codeBlockDeleteKeymap` (`src/codeBlockDelete.ts`) sits before `baseKeymap`:

| Caret | Key | Result |
| --- | --- | --- |
| start of a code block | Backspace | one paragraph per line (an empty block becomes one empty paragraph) |
| end of a code block | Delete | nothing: the next line is not the code's to take |
| anywhere in a code block | Esc | the block is selected |
| start of the line after a code block | Backspace | the block is selected; the line keeps its text |
| an empty line after a code block | Backspace | the line is removed and the block selected |
| end of the line before a code block | Delete | the block is selected |
| an empty line before a code block | Delete | the line is removed and the block selected |
| the block selected | Backspace / Delete | the block is removed (`deleteSelection`) |

The neighbour rows are the rule Edi already has beside a diagram or a table
(`baseKeymap`'s `selectNodeBackward` on an atom), kept so that all three kinds
of block read the same. They apply only when the code block is the line's own
sibling, so the first line of a list item after a code block still lifts out
of its list.

Esc defers to a block mode: with a block in Source, Esc is that mode's (it
leaves Source, `blockToggleKeymap`), and selecting a block would answer a
different question.

Inside a CodeMirror block the keys are CodeMirror's, so `createCodeEditor` takes
an `onBlockKey(key)` callback, bound before `defaultKeymap`, for Backspace at
position 0 and for Esc. The node view answers it with `codeBlockKey` and focuses
ProseMirror, so the next key reaches ProseMirror's keymap. Delete at the end
needs no binding: CodeMirror already does nothing there.

**A key the page does not take is deleted natively by the engine**, which
strips a selected block's markup and leaves its text as a paragraph. That is
why these keys are also gated with real key events in QtWebEngine (see Tests).

## The mouse

A CodeMirror block is a selection unit like a diagram (`isSelectionAtom`): a
range that covers it gets `edi-block-selected` and copies the block's markdown.
A plain block is text, and a drag through it is the browser's like any
paragraph's.

**A press on a code block's frame selects it.** The block's text has to take
a press as a caret, so the frame is what stands for the block: the border, the
padding and the language bar. `press.ts` classifies it as the `frame` press
kind, which carries `pos` (the top-level block, as for `content`) and `code`
(the code block itself, which is what is selected, so one in a list item is
selected and not its list). The context menu and Alt+click treat `frame`
exactly as `content`. These are not frame:

- the code: the plain renderer's `<code>`, which is `display: block` so it also
  covers the space beside a short line, and all of a CodeMirror, line numbers
  included;
- the buttons;
- the run output and formula diagnostics, whose text a reader selects to copy.

**A drag treats the block as one thing** (`codeBlockMousePlugin`,
`src/codeBlockMouse.ts`), in both directions:

1. *Into the block from the text.* Chromium does not carry a drag's selection
   from the outer contenteditable into CodeMirror's nested one, so on its own
   the head would stop on the line before the block. The plugin tracks the
   pointer while a drag ProseMirror started is held, and over a CodeMirror
   block it moves the head to the first text past the block in the drag's
   direction. Its `createSelectionBetween` prop does the same for any selection
   ProseMirror reads from the DOM meanwhile.
2. *Out of the block into the text.* A press in the code begins CodeMirror's
   own drag, which cannot leave the block. When the pointer leaves the block's
   box, the plugin ends that drag with a synthetic `mousemove` holding no
   buttons (CodeMirror's `MouseSelection` destroys itself on one, without
   moving its selection; public DOM, no internals). It then focuses
   ProseMirror and drives a document selection from the block's far side to
   the pointer until the button comes up.

The pointer state is per plugin instance, so a revealed encrypted block's
editor tracks its own.

## Run output

A runnable block's output area shows what a terminal would: colors, and
progress lines that rewrite themselves. Two halves make that work.

**The shell gives the run a terminal** (`run_code_block_streamed` in
`backend/exec.py`). stdout and stderr each get a pty of their own, sized 80×24,
with `TERM=xterm-256color` and `COLORTERM=truecolor`. Tools decide whether to
color, and how wide to draw a progress bar, from exactly those: given pipes, most
print plain text and line-buffered interpreters hold output until exit. Two
ptys rather than one keep stdout and stderr apart in the run's result. Each
read is sent as it arrives rather than a line at a time,
and only `\r\n` is folded to `\n`: a lone `\r` is how a progress line returns to
its start, so it must reach the page, and a line that has not ended yet must
show. Windows has no pty, so both streams are pipes there and most tools print
without color.

**The page draws a terminal screen** (`src/terminal.ts`). `TerminalScreen`
reads the text, escape sequences included, into lines of styled cells:

- SGR sets color and attributes: the 16 colors (CSS variables `--term-0` …
  `--term-15` on `.exec-output`, one palette since the output is dark in both
  themes), the 256-color table, 24-bit color, bold, dim, italic, underline,
  strikethrough and inverse;
- `\r`, `\b`, tab, erase in line and display (`K`, `J`) and the cursor moves
  (`A`–`H`, save and restore) rewrite what is already shown;
- every other escape sequence (cursor visibility, window titles, hyperlinks) is
  read to its end and dropped, so none of it shows as text.

The parser keeps its state between writes, because a chunk can end in the
middle of a sequence. The model does not wrap; the `<pre>` wraps long lines
visually.

`TerminalOutput` draws a screen as one `<span>` per line, each but the first
starting with its `\n`, so the element's `textContent` is the plain text the
Copy button copies. A write redraws from the first line it changed, so a
progress bar updating its last line many times a second redraws that line
alone.

When the run ends, what streamed stays, interleaved as it arrived, and how the
run ended ("Process exited with code 1") is appended below it. Only how it ended
marks the output as an error (`exec-error`, a red top edge): a non-zero exit, a
run that was stopped or timed out, or one that never started. Output on stderr
does not, because tools write progress bars and logs there.

The output's text is the reader's to select, with a drag or a double-click, and
the selection is the browser's own. `codeBlockMousePlugin` does not count a press
in `.exec-output` as a drag from the document's text, which would otherwise
extend into the highlighted block it sits in and select the whole block.

Copying that selection cannot go through the editor, whose selection is still
wherever it was before the drag. `runOutputSelectionText`
(`src/runOutputSelection.ts`) answers when both ends of the browser selection
are in one output, and Copy (`Ctrl+C`, Edit → Copy, the context menu), Copy as
Markdown and "is anything selected" ask it before the editor; Cut does nothing
there, and the context menu disables it.

**A right-click in the output opens the context menu without moving focus**
(`preserveFocus`, `onContextMenu` in `src/main.ts`), as one in a spreadsheet
cell's input does. The menu otherwise takes focus and hands it back when an item
is picked, and the editor getting focus back writes its own selection into the
page: the reader's selection goes, and QtWebEngine scrolls to the editor's caret,
which is usually the top of the document. Chromium does not scroll there, so the
window test covers it
(`test_copying_run_output_from_the_context_menu_keeps_the_view_and_the_selection`).

**A finished run is kept with its tab** (`src/runResults.ts`). Switching tabs
swaps the editor state, which rebuilds every node view, and the output lived only
in the view. So a run, when it ends, is recorded in plugin state: its raw output
(escape sequences included), its status lines, whether it failed, and the code it
ran. A rebuilt view replays the record into a new `TerminalOutput`. Recording is
a transaction with no steps, so it neither dirties the file nor enters undo, like
a block mode. Records are keyed by the block's position and mapped through
edits; one is dropped when its block goes or its code changes, which is also when
the view clears its output. A block view can be reused across a swap without its
`update` being called (an identical block in the same place in the other
document), so the plugin's own view asks every live block view to show the
state's record whenever the records change, and again when the plugin view is
made for a new state. A run still in progress when the tab is left is stopped,
and its output is not kept.

## Tests

| Behaviour | Unit (jsdom) | Real input (`npm run test:browser`) |
| --- | --- | --- |
| Paste into a code block | `src/paste.test.ts` | — |
| Typing a fence and a shebang | `src/blockstart.test.ts` | `tests/browser/edit-blocks.browser.test.ts` |
| Renderer switch and caret handoff | — | `tests/browser/edit-blocks.browser.test.ts` |
| Backspace / Delete / Esc | `src/codeBlockDelete.test.ts` | `tests/browser/edit-blocks.browser.test.ts` (`code block keys`) |
| Raw blocks and raw inline code: parse, serialize, paste | `src/markdown.test.ts`, `src/schema.test.ts` | `tests/browser/code-block-keys.browser.test.ts`, `tests/browser/code-block-mouse.browser.test.ts` (`raw block`) |
| Frame press and drags | — | `tests/browser/code-block-mouse.browser.test.ts` |
| Run output: colors, `\r` and cursor moves, the error mark | `src/terminal.test.ts`, `src/runnable-block.test.ts` | — (the run's terminal: `tests/test_exec.py`) |
| Selecting and copying run output | `src/runOutputSelection.test.ts` | `tests/browser/run-output.browser.test.ts`; the scroll in QtWebEngine: `tests/window/test_window.py` |
| Run output kept across a tab switch | `src/runnable-block.test.ts` (`a finished run kept with its tab`) | — |

The focus, caret and pointer behaviour only exists with real layout and input,
which is why most of it is tested in the browser project and not in jsdom. A
CodeMirror line's text is split across highlight tokens, so those tests aim at
`.cm-line` boxes rather than `charBox`.

**The keys are also gated in QtWebEngine with real key events**:
`tests/window/test_window.py::test_code_block_keys_with_real_key_events`, for
both renderers. Real keys reach the page when they are sent to the web view's
`focusProxy()`, the widget QtWebEngine reads input from; `qtbot.keyClick` on the
window does not reach it. A synthetic `KeyboardEvent` only exercises
ProseMirror's keymap and could never show the engine deleting natively.

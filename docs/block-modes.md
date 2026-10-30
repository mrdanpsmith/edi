# Block modes

`src/block-modes.ts` owns every "this block is being viewed or edited
differently" mechanism in the app, and there is exactly one of it.

## One record, two axes

There are two orthogonal axes:

- **representation** — `visual` / `source`, for every block with a source form;
- **interaction** — `viewing` / `editing`, for `mermaid_block` only.

Both live on **one record** (`BLOCK_MODE_KEY`), holding the one block in a
non-default state.

`blockModeFor(node)` is what a block type declares about itself. The control
cluster, the context menu, the Escape ladder and the status chip are all
generated from it, so a new block type states what it supports once instead of
in a chain on wrapper class names.

## Mode is plugin state, never document content

No node carries `_source` or `_edit`. A mode flip is therefore:

- not an edit;
- not undoable;
- not dirtying the file;
- unable to desynchronise plugin state from the document on undo.

The cost is that ProseMirror has no reason to re-ask the node views. It
re-walks the tree only when the document changed or a node's **decorations**
changed, and `ViewDesc.matchesNode` compares decorations *by value*.

So the record publishes itself as a node decoration to make the walk happen.
**The class has to carry the mode**, not merely that there is one. A decoration
that said only "there is a mode" would be byte-identical across two different
modes. Flipping an axis while the record stayed held (Source pressed on a
board already in its edit mode) then changed nothing the view could see: the
record moved and the block kept drawing, which reads as a control that does
nothing.

`BLOCK_MODE_CLASS` is therefore `…-visual` / `…-source` plus `…-editing`. This
is the accent rule doing the load-bearing half as well as the legible one.
`tests/window/test_window.py::test_source_from_a_board_s_own_cluster_while_it_is_being_edited`
pins the gesture that found it.

The one exception is a table's text ⇄ sheet **form**. It is per-block, not
exclusive, and it outlives a visit, so it stays the session-only `_plain`
document attribute (`tableFormOf`/`setTableForm` in `src/node/table.ts`).

## Transitions

Every route goes through three functions:

- `enterBlockMode`;
- `exitBlockMode`;
- `toggleBlockMode`.

`releaseSourceBlock(view, pos)` reports where the block the caller is
interested in ended up. The commit is a document edit, so a caller that kept
its pre-commit position sets the mode on whatever shifted into it.

Entering the *interaction* axis costs a per-type ordering rule: finish a
pending label first, then change the mode. Each node view registers that rule
into `BLOCK_MODE_HANDLERS`; `block-modes.ts` does not import it.

## One cluster per top-level block

The cluster sits at the block's right edge and is revealed by one rule in
`src/styles/block-controls.css`.

`attachBlockControls(node, view, getPos, actions)` generates the mode buttons
and takes the block's own actions. A button reads its position from `getPos()`
**when pressed**, which is the single position authority. `data-block-pos` and
`findBlockPosForHandle` are gone. `blockPosForElement` is the DOM→position
direction the context menu and the gesture need.

A block's own controls go in the cluster too. That is how a code block's
**Copy** stopped colliding with its **Source**: the copy used to be a second
control absolutely positioned in the *same corner* as the cluster, reserving
`padding-right` on the source to keep off the code.

`src/node/execblock.ts` contributes the copy now (`copyButton`, one plain
button). It carries **no** look of its own; `.block-control` styles it. A
second border around one button was what it had before, and a second set of
metrics with it, so it stood 3px taller than its neighbour and made the row
taller than the bar the row sits on.

Only the one copy that genuinely floats keeps a look and a fade:
`.code-copy-float`, the run output, revealed by hovering the output because it
appears over text the reader is in the middle of. `copyButton` takes an
`onCopied` callback, and the floating kind is the only one that asks to fade
out of the way.

### Row geometry

**The row is level with the block's own first row of chrome, and the same
height as it.** That is `top: 2px` and a 1px pill padding, and it took both: a
button is 21px, so a 2px pill was 27px against a 25px language bar and hung
11px over the first lines of code at `top: 6px`.

A code block's language bar then grew to 29px to hold the controls it now
carries, because the row is the block's and shrinking the buttons is the one
thing the reader presses.

`tests/window/test_window.py::test_a_code_blocks_copy_lives_in_its_control_cluster`
asks:

- the computed style (`1px` on all four sides, no fill, one height across the
  row);
- `elementFromPoint` whether each button is the thing under its own centre;
- the bar's own box whether the row is inside it.

jsdom has no layout, and a screenshot of a just-mutated DOM is a stale frame.
The rule that makes the collision impossible rather than merely absent today
is: a control that is not absolutely positioned cannot be in a corner.

### Keyboard and gestures

`Ctrl+Shift+E` enters Source. No menubar shortcut claims it, which is why
`backend/window.py`'s Export label carries none (a Qt shortcut wins over the
page). `Mod-Shift-e` still toggles it on the caret's block.

**Alt+click** is the mode gesture. It is a **two-way toggle of the pair of
modes the block type has**:

- a block with an edit step toggles that step (a diagram's editing layer, a
  table's sheet) and never enters its source form;
- a block without one toggles **visual ⇄ source**;
- a block already in its source form is committed and left — that is
  `exitBlockMode`, the same rung Escape pulls.

There is no Alt+Shift+click and no cycle. The three-step `visual → edit →
source` walk it replaced put a document edit — commit the buffer, re-parse the
block, re-render the drawing — on the way out of a mode, which is not a price
a toggle should charge to get back where it started.

Only `source_block` has nothing to toggle to. A click naming no block finishes
whatever is editing. Double click is the browser's again, in every block type.

## The cluster is two boxes

A row in the margin has to be *reached* before it can be pressed.

`.block-controls` is the block's **whole right margin**:

- as tall as the block;
- as wide as the gutter;
- painting nothing;
- hit-testable *always*.

`.block-control-pill` inside it is the visible row at its top-left corner,
`opacity: 0` and `pointer-events: none` until the reveal.

Hovering the strip *is* hovering the block, because the strip is a child of it.
The reveal (`.block-controls:hover`, and the block's own `:hover`) has already
happened by the time the pointer gets to a button.

Without the split, the row was drawn in the one region of the page no `:hover`
covers: the pointer left the block on its way to the buttons, the row faded
under the hand, and the controls were unreachable. It was reported as
*sometimes impossible to click … on hover on the content instead of on the band
of the content*, and was certain on the board in `pm/edi-pm.md` (measured at
1280×900: a 1617px block whose row is a 28px box at its top, so the pointer
crosses the block's right edge hundreds of pixels below the row).

Both dimensions are load-bearing:

- the **height** lets the pointer sit in the margin beside the middle of a tall
  block;
- the **width** catches a diagonal path that crosses the block's edge away
  from the row.

The pill being inert at rest is the other half of the rule: an invisible
control must not be pressable. `src/press.ts` answers a press on the strip that
is not on a button as `space`, so a press where a button would be before it is
shown is a caret beside the block, exactly like the page past the margin.

`attachBlockControls`'s `mousedown` swallow is scoped to the buttons for the
same reason: it exists to keep the caret out of a control's own label, and
swallowing the strip would leave a press in the margin with no caret anywhere.

The gate is
`tests/window/test_window.py::test_a_blocks_controls_can_be_reached_with_the_pointer`:

- the strip starts at the block's right edge, is as wide as the gutter and as
  tall as the block;
- `elementFromPoint` at 10/50/90% of the block's height in the margin is the
  strip;
- every 4px of the path from 24px inside the block to the row is
  block-or-strip, never the page;
- at rest each button's centre is the strip;
- with the shipped reveal declarations re-installed as a class
  (`INSTALL_REVEAL`; no JS can hover, and a Qt-injected event never reaches the
  page) each button is the thing under its own centre.

## The pill stands 8px off the block

The block's own edge is where its outline is.

A block that is not being viewed as its document wears a 2px dashed accent
outline at `outline-offset: 2px`. A selected atom wears the same shape solid.
Either way, 4px of accent line is painted *outside* the block's border box, so
a row flush against the block painted its own opaque fill and border over that
segment. It was reported as *the tools overlap the editing border*.

8px is 4px of outline and 4px of air. The gutter is sized for exactly it:
8 + 80 (the widest row, three buttons) + 8 = 96px margin. It costs nothing in
reachability *because* the strip is behind the gap, which is the two-box rule.

The gate is
`tests/window/test_window.py::test_a_blocks_controls_clear_its_own_editing_outline`.
It reads the outline's **computed** width and offset rather than a number from
the stylesheet. A diagram in its edit mode is the fixture; whether the dashed
or solid outline is on screen does not change the answer.

### Blocks inside a revealed encrypted block

A revealed encrypted block's inner editor has a gutter of `0`, but its blocks'
rows still go in the **page's** gutter, in the same column as every other row.
`src/styles/encrypted.css` does this in two steps:

- `--edi-reveal-inset` (22px) is the distance from an inner block's edge to the
  encrypted block's edge: the reveal's padding and border, then the block's. The
  inner strip is that inset plus the page gutter wide, and the pill stands
  `inset + 8px` off the inner block. If either padding or border changes, this
  number changes with it.
- `.encrypted-block-reveal` is `position: relative; z-index: 4`. The inner editor
  is its own stacking context, so without this the encrypted block's own strip
  (`z-index: 3`) was painted over every inner strip in the gutter. The pointer
  there hovered the outer block rather than the inner one, and an inner row's
  buttons could not be pressed.

The row used to sit on the inner block's own edge (`left: 0`), inside the
reveal's frame and half under the outer strip. The gate is
`tests/window/test_window.py::test_a_revealed_blocks_controls_are_in_the_pages_gutter`.

## The starting caret is never a block selection

`startSelection` in `src/editor.ts` puts a fresh document's caret on its first
text. A document with no text at all, such as a file of tables or an encrypted
block holding one table, starts on a gap cursor before its first block.
ProseMirror's default, `Selection.atStart`, node-selects a leading atom, so such
a table opened selected.

A press beside a block in a document with no text (`src/press.ts`) answers with
a gap cursor on the pressed side. That press used to do nothing, which left a
selected table with no way to deselect it. A gap cursor creates no block; typing
at it does.

While a gap cursor sits before the first block, its widget is the editor's first
child, so `editor.css` gives the block after it the first-child zero margin as
well.

## The hover band

**The hover band is the row, and the row is the editor's content box — not the
block's.**

Both offsets are written in the variables the editor's padding uses:

- `--edi-gutter-left: 72px` plus every block's own 24px indent;
- `--edi-gutter-right: 96px`.

There is a fixed 96px text inset on each side, so a band that stopped at the
text column cannot happen.

What *could* not be written from the block is the right edge. A rendered table
hugs its grid, so a band that cancelled the gutter from the block's own right
edge was 96px wide beside a 63px grid, and the highlight stopped halfway across
the page. It read as the table's own outline rather than as the row it sits in.

So `right` is *the empty row to the block's right plus the gutter*, and
`100cqw` names that row. `.ProseMirror` is a query container
(`container-type: inline-size`, which changes nothing about an editor whose
width comes from the page and never from its contents). `100cqw` is its content
width, so the same declaration puts a paragraph's band on the page edge and a
table's band on the page edge beyond the table.

`100%` is the block's *padding* box. A block that draws its own border
(`.runnable-block`, `.encrypted-block`) declares `--edi-band-border` beside that
border. Two facts, one decision: a bordered block that forgets it pushes its
band two pixels past the page edge, which is a horizontal scrollbar for as long
as the pointer is on the block.

`tests/window/test_window.py::test_the_hover_band_reaches_the_page_edges` is the drift
detector. It uses one document with a paragraph, a quote, a list, a code block,
a table and a diagram, measures every row's band left and right against the
editor's own box, and reads `#editor-container.scrollWidth` while the probe's
band is a real box.

### One band per row

**One band per row, and the row is a top-level block.** The selector is
`.ProseMirror > :is(…)`, the same `>` the 24px indent uses, because *both*
offsets are written for a block whose left edge is the text column.

A nested block (a list item's paragraph, a blockquote's child) is inset past
that. So `100cqw - 100%` counted the inset as margin and the band landed
exactly that far past the page's right edge. Measured at 900px wide, a list
item's paragraph drew its band to 928 and `scrollWidth` went to 928 — a
horizontal scrollbar across the whole document for as long as the pointer was
on the item. It was reported as *random*.

Nothing is lost by excluding nested blocks: the row a nested block sits in is
its list's or its quote's row, that block has the band, and it is also the one
carrying the cluster, so the band and the controls answer about the same box.

The probe asks the rule's **own selector** which elements it paints for
(`el.matches` with `:hover` and `::before` taken off) rather than iterating
`[…pm.children]`. Measuring the children was how a nested band went
unmeasured while it scrolled the page.

### A rule's band

**A rule's band is the row its strip already covers.**

The generic band leans 4px past its block's box — a merge with the neighbours'
rows for a block that has one. An `<hr>` is 1px tall, so that was a ~9px
rectangle centred on the line, a sliver in the middle of ~48px of margin. It
was reported as *the hover band on an hr is like 2px high*.

The strip had already been told the rule's row is the whitespace (the
`.block-visual-rule` strip rule), and the band was the one control left
answering "where is this rule's row?" with the line itself.

So the override beside the generic band rule covers the same margins with the
same `-1.5em`, carries the generic band's `:not(…)` guards at its own
specificity, and sits directly after it. That tie is how the override wins the
cascade. The hr margin rule (`margin: 1.5em 0`) is the fact both controls
restate; if it moves, both move.

`tests/window/test_window.py::test_a_rules_hover_band_covers_the_row_the_strip_covers`
re-injects the override's own declarations with `:hover` swapped for a class
(plus `position`/`content` from the band it overrides, which the override does
not carry). It asserts the band's computed top/bottom reach the margins and
equal the strip's own box, so the page has one answer to the question, not two.

## Escape

Escape is a ladder in `exitBlockMode`, which `editor.ts`'s keymap calls
verbatim:

1. a field owns Escape before this sees it;
2. Source commits;
3. `editing` goes to Done;
4. it returns false, so every other handler is unaffected.

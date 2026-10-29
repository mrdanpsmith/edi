# Mermaid visual editing

`src/mermaid-edit.ts` is the visual-editing layer:

- `renderDiagram()`, a thin wrapper over mermaid plus `responsifySvg`,
  `adaptDiagramColors`, `pinSvgTextColors` and `bakeDiagram` from
  `src/mermaid.ts`;
- the label model and source patchers;
- the field a label is edited in;
- the kanban drag (see [mermaid-kanban.md](mermaid-kanban.md));
- the notice that keeps the last good diagram on screen when a patched source
  stops parsing.

`src/mermaid-dom.ts` is the one place that reads mermaid's rendered SVG:
its class names and the shape of its `g.node`/`g.section`/`foreignObject`
output are implementation details an upgrade may change, so every selector
that targets them lives there, with one rule per diagram family. It exposes
label discovery and roles, board structure (columns, cards, headers), native
text/shape helpers and `MERMAID_LABEL_WRAP_CSS`; the other Mermaid modules
call those helpers instead of querying the drawing themselves. Selectors for
Edi's own host elements (`.mermaid`, `.mermaid-preview`, the board chrome)
stay with the modules that own them.

`src/node/mermaid.ts` keeps the node view and the interaction-axis plumbing:
`enterDiagramEditMode()`, `exitDiagramEditMode()` and
`toggleDiagramEditMode()`. They are registered into `BLOCK_MODE_HANDLERS`, so
they are wired to the cluster's Edit/Done button, Alt+click, and the Edit/Done
context-menu items in `src/contextMenuController.ts`.

**A diagram has no zoom of its own.** It is drawn at its natural width
(`responsifySvg`) and the document's one zoom (`src/zoom.ts`,
`Ctrl`+`+`/`-`/`0`) scales it. `MermaidDiagramOptions` carries no control sink,
and the block's cluster holds only its mode buttons.

## `DiagramSession`

**One `DiagramSession` per block (`src/mermaid-session.ts`) owns everything
stateful.** A block has exactly one, it lives as long as the block, and nothing
about a diagram's editing is held anywhere else:

- not in a module-level variable;
- not in a per-render closure;
- not in a DOM class;
- not in a source snapshot taken when an affordance was built.

`sessionFor(block, commit)` gets the session, creating it on the first render.
`stopEditing(block, accept)` takes the block out of edit mode.
`endSession(block, accept)` forgets it when a preview is rebuilt or a node view
is destroyed. Everything else is reached through the session.

Each of the six properties below was a class of bug first.

### One source, read at patch time

`session.source` is the *drawn* source of the render on screen. Every edit goes
through `session.patch((drawn) => …)`, which updates it the moment the patch is
made.

A patch is therefore a function of the board as it stands when the patch is
made, never of a snapshot taken when a button was built. That is what made a
delete confirmed twenty seconds after its prompt write back the board as it was
*before* the prompt was opened.

Both delete flows — a card dropped on the bin, a column chosen from its menu —
go through `confirmThen(session, subject, consequence, run)`: asked first,
patched after.

`patch` refuses outright once the block is back to its rendering, so nothing
reaches a document the user has said they are done with.

A render mermaid *refuses* calls `session.noteSource(code)` instead. The
drawing on screen is the last good one, but the document has moved on to this.
The next patch has to be made against the document. Made against the drawing,
it would carry on as if the refused edit had never happened and commit a board
without it.

### One interaction at a time

`PREEMPTS` says which phase finishes which:

- a field and a drag both take the pointer, so either one finishes the other;
- a menu is a popover, not a mode, so pressing a column's `⋯` mid-rename does
  not throw the rename away.

`session.start(phase, finish)` claims the phase and returns the release.
`session.finish(accept)` resolves whatever holds it.

The failure this replaces was an open field whose phase was never given back,
so `hasField` stayed true and **no card drag could arm again**. That is why
`hasField` is `this.field !== null` rather than a phase, and why `close()`
releases.

### One render wins

`beginRender()` hands out a ticket and `isCurrent(ticket)` throws the losers
away. It is checked after the `await` on mermaid and again after the edit-scope
teardown.

Rendering is awaited in two places and requested from three, so two renders of
one block really are in flight together. Without this, the older one could land
last and leave the block showing a board the document had already moved past,
*with an editing layer built from that older source behind it*. The next edit
would then patch a board that was no longer there.

### Render-scoped is not session-scoped

A listener, the `.mermaid-editables` classes, the board's controls, the drop
line and the bin's dressing are registered with `session.onRender()` and taken
down by `session.reset()` before the next layer is built.

That is what makes "no listener left behind" true rather than intended. The
chrome's menu `pointerdown` used to be an anonymous handler that no disposer
could remove, once per render.

An **open field is the exception**: it is the session's, not the drawing's, and
it outlives the render.

### A field is anchored to a way of finding its subject

`EditSubject.locate(render)` is asked again after every render.

- A label is found by its *identity*: its text and which copy of a repeated
  text it is. A position is not an address, because a render that drops a label
  before this one would slide the index onto the wrong label.
- A card is found by where it sits in the render's card list. That is how a
  card slot is addressable at all, since a slot is not a label.

If the subject is still there, the field is re-homed, re-anchored, re-placed
and given the caret back, with what was typed. If it is not, the field is
**finished rather than abandoned**.

A field is the one thing about a diagram that survives something the user did
not do to it. A re-render nobody asked for — a theme change, a magnification, a
re-layout — must not eat half a title.

### One placement, one coordinate space

A `⋯`, an open menu and a field are all *overlays*
(`session.overlay(el, box)`): one placement function, one settle loop, one
teardown, all against the preview (the scroller).

`schedule()` re-places on everything that can have moved an overlay and keeps
asking while a placement moves something.

`watch()` observes the drawing, the preview and the editor's scroller, plus
their scroll events:

- the preview as well as the drawing, because a window resize narrows the
  preview while the drawing keeps the size mermaid drew it at;
- the editor scroller, because a composer hanging below a short board scrolls
  the editor.

A control and a field drifting apart is not a bug to fix each time; it is what
one placement function is for.

**That one space is document pixels, and a box read from the DOM is not in
it.** The overlays are children of the preview inside
`#editor-container .ProseMirror { zoom: var(--doc-zoom) }`.

`getBoundingClientRect()` answers in *viewport* pixels, already multiplied by
the zoom. A `left`/`top`/`width` written on an absolutely positioned child is in
*document* pixels, which the browser multiplies again on the way out.

`place()` therefore divides every viewport measurement by
`effectiveZoom(this.preview)` (`src/zoom.ts` returns the product of the computed
`zoom` of every ancestor, since `zoom` is not inherited and a descendant
reports `1`). `scrollLeft` is left alone because it is already in document
pixels.

A caller that builds a box from a viewport rect plus one of its own constants
has to put that constant in the same space:

- `menuBox()` and the menu's `MENU_WIDTH` (`src/mermaid-chrome.ts`) widen
  theirs by the zoom before handing the box over;
- `bandBox()`'s `COMPOSER_HEIGHT` (`src/mermaid-composer.ts`) does the same.

The field's own `state.size`, and `fit()`'s room for `FIELD_MARGIN`, are
document pixels for the same reason: they are layout numbers. Mixing them with
viewport measurements leaves every control drifting and every field short by
the zoom factor at each level but 100%.

`tests/window/test_window.py::test_kanban_editors_sit_on_their_slots_when_the_document_is_magnified`
is the real-engine gate. The jsdom placement cases in
`src/mermaid-edit.test.ts` are the cheap one.

## Rules the rest of the app depends on

### The fenced source is the document

A visual edit is one `setNodeMarkup` transaction (`commitSource`), so undo
takes a whole edit back.

`commitSource` must **not** pre-set `this.currentCode`. `update()` uses it to
spot a changed value; pre-setting it makes the view skip the re-render, leaving
the old diagram on screen. There is a real-engine test pinning this.

`commitSource` checks `nodeAt(pos).type.name === MERMAID_TYPE` before writing. A
block can have gone to its source mode while a dialog was up, and a commit
landing then would be an edit in the document that neither the rendered diagram
nor the CodeMirror buffer ever showed.

### View mode may bake, edit mode must not

A diagram with light native text (sequence diagrams) is baked to a bitmap in
view mode, which removes every clickable label. Entering edit mode re-renders
the vector and marks the labels with `.mermaid-editables`.

**The bake follows the document's zoom, because a diagram has no zoom of its
own to re-rasterize on.** `bakeDensity` (`src/mermaid.ts`) rasterizes at
`2 × --doc-zoom` device pixels per CSS pixel, capped at 4x.

`applyZoom` announces the clamped level as `DOC_ZOOM_EVENT`. One page-level
listener answers by re-baking every `[data-edi-bake]` holder it finds, found by
their own marker rather than kept in a set, so a torn-down block leaves nothing
behind.

Without that, magnifying a sequence diagram would magnify its bitmap, which is
the exact softness the bake exists to avoid.
`tests/window/test_window.py::test_magnifying_the_document_redraws_a_baked_diagram`
pins it by reading the raster's own `naturalWidth`.

### Leaving edit mode resolves the layer before the mode changes

A render without a commit handler *is* the block having stopped being
editable. So `renderDiagram` calls `session.setEditing(false, true)` itself,
and `exitDiagramEditMode()`, `enterDiagramEditMode()` (for the diagram it
drops) and `insertKanbanSource()` also call
`finishMermaidLabelEditing(nodeDOM, true)` first.

Accepting **first** is load-bearing and is the opposite of the old order.
`renderDiagram` is `async`, so calling it runs its body **synchronously as far
as the first `await`** — far enough to rebind the session to "this is not
editable any more". A field accepted after that commits to a block that is no
longer editable, and the half-typed label is dropped on the floor.

So a mode change is:

1. accept (a commit, and so a render, in edit mode);
2. dispatch the mode change (a second render);
3. the ticket leaves the mode on screen.

For the same reason those three callers read `currentEditPos` and build their
transaction *after* the accept. A transaction built before a dispatch lands on
a document that has moved on, and ProseMirror raises `Applying a mismatched
transaction`.

### Alt+click anywhere ends edit mode

`blockModePlugin`'s click handler in `src/block-modes.ts` toggles the block
under the pointer between the two modes that block type has:

- a diagram's interaction axis;
- a table's rendered form;
- for every other block, its representation.

So a diagram under the pointer goes out of Edit, and a block under it that is
merely being viewed goes into Source. A click naming no block finishes whatever
is editing. So does a press on `source_block`, which has one state.

It replaced the double click this used to be, so the gesture that turns the
mode off need not land back on the diagram. A bare double click is the
browser's again, and a diagram's label word selection is part of what that
gives back.

The click is never swallowed. Only ones Chrome owns are left alone:
`a[href]`, `button`, `input`, `textarea`, `select`, `.cm-editor`, and a
diagram's own chrome and control cluster.

The listener is on the editor's **scroll container**
(`view.dom.parentElement`, i.e. `#editor-container`), never `view.dom`. The
editor's own box is only as tall as its content, so a document that is one
short diagram (a lone board) leaves the white space under it on the scroller,
where a `view.dom` listener sees nothing. The mode stayed on and Chrome
answered the click itself by selecting the nearest text on the page — the
document name in the status bar.

It is the scroller and not `document`, so a click in a dialog sitting on top of
the editor cannot reach through it.

`tests/window/test_window.py::test_alt_click_below_a_lone_board_ends_its_edit_session`
pins it with the real gesture at real coordinates, asserting the point is
outside `.ProseMirror` first.

### A label has to be allowed to break

The rule belongs in `themeCSS`.

Mermaid measures a label *before* it draws it, with the wrapping rules it
ships: `white-space: break-spaces`, which breaks at whitespace and nowhere
else.

A run with no whitespace in it — a long identifier, a URL, an acronym somebody
pasted — is measured as one line several times wider than the card it is in. A
board's card width is fixed by `kanban.sectionWidth`, so nothing downstream can
absorb that: the card is drawn at the width it was told to be, and the title
paints *outside* it, over the columns next door.

`MERMAID_LABEL_WRAP_CSS` (in `src/mermaid-dom.ts`, passed as `themeCSS`) sets
`overflow-wrap: anywhere` on the label classes. It goes through `themeCSS`
rather than our own stylesheet because `themeCSS` is embedded in the stylesheet
mermaid *measures with*, so the label is already wrapped when the card, the
band and the board are sized from what the reader will see.

Applied after the render, it puts the text inside the card but leaves the card
the height of the *un*-wrapped text, so the last line sticks out of the bottom
instead.

`overflow-wrap` is additive by construction: it only permits a break where
there was no break opportunity. A label that fits, or that already breaks at a
space, is laid out exactly as before.

`tests/window/test_window.py::test_unbreakable_kanban_titles_stay_inside_their_cards`
pins it with a 68-character run in both a card and a column name.

### Only mappable labels are offered

`labelTargets()` marks a label `.mermaid-editables` only when
`resolveLabelSpans()` maps it to a source range *right now*.

That single filter keeps the promise the UI makes. A label you cannot click is
either:

- Mermaid-computed — a treemap total, an xy-chart tick, a packet bit range, a
  kanban assignee, a Wardley stage or a `<<stereotype>>`;
- repeated in the source with no way to tell the copies apart.

Adding a family means adding a mapper, not touching the DOM walk.

A `LabelRole` of `entity` marks a label the diagram refers to elsewhere (ER
entity, state, class, git branch, requirement, sankey node, wardley node, venn
set, journey actor). Its rename rewrites every reference via `all: true`.
`text` is prose that sits in the source once.

`sourceLines`/`wholeWordSpans` are the shared source-scanning primitives. Match
whole words, not substrings, or `date` matches inside `order_date` and the label
goes ambiguous.

A label mermaid wrapped across `tspan`s reads back from `textContent` with its
spaces dropped (`Lack ofTraining`). A whitespace-squeezed match therefore
records the source's own spelling in `sourceText`, and the editor edits that,
not the rendering's.

The same holds wherever mermaid drew the source's text inside something else:

- a sankey node shares its element with its computed total;
- a requirement row is drawn under mermaid's own idea of the key
  (`verifymethod: test` shows as `Verification: Test`).

So `sourceText` is the source's spelling of whatever the mapper's span covers,
and the input holds exactly what a commit replaces.

A repeated label is told apart by *which copy it is*: `pickCopy` pairs the k-th
drawn copy with the k-th span in the source. That only works if the targets are
listed in source order, so kanban targets are sorted by source line: drawn, a
board lists every header before every card, and a column and a card sharing a
name would each rename the other.

What a rename writes has to parse:

- **Flowchart** labels are written by `graphLabel`. A label with shape or edge
  syntax is quoted (`A["Fix (bug)"]`), a `"` inside quotes is `#quot;`, a label
  the source already quotes keeps its quotes, and an empty label is refused
  (`graphLabelRefusal`).
- **Kanban** titles go through `kanbanInnerLabel`/`kanbanQuotedLabel`, and a
  styled title (`[**Bold**]`) is edited inside its markers but written back
  whole, so quoting wraps the markers too: `["**Fix (bug)**"]`.

Other families write the typed text as it is.

That is also why the editor resolves from `target.text` and not from the edited
text: a row is *found* by the row mermaid drew, and only its value is
rewritten. A typed value alone would leave the mapper nothing to find.

### Two gates, two costs

`tests/window/test_window.py::test_every_offered_label_rename_resolves` is the cheap
gate. It does one rename per diagram, one case per distinct patch strategy
(text, tspan-wrapped, entity-all-refs, value-only row, sankey first line,
implicit git branch, withheld total), about 3 seconds for the whole set, inside
the session window.

It asserts the one thing that is never acceptable — the editor closed and the
source never changed — and that either mermaid drew the value or the notice
said it would not.

`tests/test_mermaid_templates.py::test_every_offered_label_renames` is the
exhaustive one, one case per template. It walks *every* offered label through
the real gesture path in the template sweep's own window and fails on any
silent no-op or render failure, listing each label that failed. A rename
mermaid re-reads under its own grammar is a warning, not a failure. It runs in
the normal suite (under two minutes); `-k "label_renames and Kanban"` narrows
it while working on mappers, mappers' regexes or the `GENERATED_BY_FAMILY`
lists. It is the only thing that can see mermaid's real DOM shape; it found the
`diagramFamily` case bug and the ER substring bug, which no jsdom test could.

`mermaid` is pinned exactly in `package.json`, so an upgrade is a deliberate
commit, and the normal CI run walks every label against it (see
[ci.md](ci.md)).

### Read mermaid's SVG defensively

Mermaid's own SVG is the DOM to patch.

A label may be a `text` with a `tspan` child (sequence participants are
`text.actor > tspan`), which is why the wrapper check upper-cases
`child.tagName`.

Chromium also makes `.items > .node` natively draggable, and its drag swallows
the pointer stream the kanban drag listens on. Cancel `dragstart`
(`-webkit-user-drag: none` in CSS covers the rest).

Do **not** `preventDefault()` on `pointerdown` to fix that: it would suppress
label-editor clicks.

### Copied HTML is shaped for Confluence

Copy replaces each diagram with `mermaidFigure` (`src/mermaid-export.ts`): a
`div[data-mermaid-block][data-mermaid-source]` holding a PNG `data:` image, then
the source in
`div[data-node-type="expand"][data-title] > details > pre[data-language] > code`.
These shapes come from paste tests against Confluence Cloud:

- The outer wrapper is a `div`, not a `<figure>`: Confluence flattens an expand
  nested in a figure. Keeping the expand inside the wrapper means a paste back
  into Edi parses one atom `mermaid_block` from `data-mermaid-source`, instead of
  a diagram followed by a stray code block.
- The expand `div` is Confluence's own marker and pastes as a real Expand. A bare
  `<details>` is flattened to text, so the `div` wraps it rather than replacing it.
- The `<details>` has no `<summary>`. Confluence pastes a `<summary>` as a stray
  line inside the Expand; without one, other targets still fold the source under
  the browser's default label.
- Confluence reads a code block's language only from `pre[data-language]`, never
  from `code.language-*`, so the schema's `code_block` `toDOM` writes both. It has
  no `mermaid` language, so the source pastes as plain code.
- Confluence drops `data:` images, and a clipboard that also carries a separate
  `image/png` pastes as that image alone. The PNG stays in the HTML for other
  targets; in Confluence, paste each diagram with its own image copy.

## One walk, one field

`buildScope(svg, source)` parses the source once and walks the drawing once,
returning a `RenderScope`:

- the drawn `source`;
- the offered labels, as elements, plus the family's own `LabelTarget` records
  at the same indices;
- the cards;
- the columns;
- the drawn slots and the line model.

An index is all an anchor needs, and the mapper's idea of the label is what a
patch needs.

Every feature used to answer "what is on this board" for itself, so there were
three answers that agreed only because they happened to agree.

`editLabel()` is the same edit for a flow node, an edge, a participant, a card
title, a column's name and the name of a column the board is drawn with but
does not have yet.

- Naming the drawn column rewrites the placeholder it is drawn with, and
  `kanbanRealSource` turns *that* into a header.
- The only things a caller varies are the box it stands in (`boxOf`) and
  whether the value is being added rather than replaced (`tone`).

The mapper is resolved when the value is **accepted**, from the label the field
is standing in *then*, so a render in between cannot make a rename land on the
wrong thing.

A card's title is `editCardTitle()`, which differs in two ways:

- the box is the whole card rather than its text, and the card grows with the
  title being written. `cardSubject`'s `grow` remembers the drawn height when
  the field takes the card over and puts it back when it gives it up;
- the commit is `addKanbanCard` rather than `patchLabel`, with the slot found
  again by its **reserved id** in the source as it is at commit time, rather
  than by an index read off a drawing that may be a render behind the document.

The same rule holds for deleting and moving cards and columns. The press is read
off the drawing, but the edit lands after a confirmation or behind a drop whose
render has not arrived, so the item is captured as a `KanbanItemKey` (its source
line, and which copy of that line) and found again with `findKanbanItem` in the
source the patch is handed. An item that is gone by then makes the patch a
no-op.

A field that **refuses** its value (an empty kanban title) stays open and keeps
the session's phase. Leaving edit mode or ending the session offers it its
commit, and discards it if it refuses again. `enterSourceMode` on a block in its
own editing layer calls the block's `exit` handler first, so a field the Source
control did not blur is resolved before the mode moves. A render that lands
mid-drag cancels the drag, because the elements it holds are gone.

## Real-engine tests

The real-engine tests live in `tests/window/test_window.py`. The shared
WebEngine helpers are in `tests/mermaid_render.py`, which is not named
`test_*.py` so pytest does not collect it.

They render in that module's already-open session window on purpose. A
`MainWindow` is a WebEngine page, and the dark probe plus template sweep
already take two, so a module of its own or a fourth window turns the suite red
for no reason.

`QTest` mouse injection never reaches the page, so these tests dispatch
JavaScript-synthesised `PointerEvent`s.

# Kanban boards

A kanban board is authored from the board, not from its source. The diagram is
drawn with places to add, its chrome is quiet until the pointer asks, and every
commit is still one `setNodeMarkup` on the fenced source.

See [mermaid.md](mermaid.md) for `DiagramSession`, label editing and the shared
source/commit rules.

## Drag and drop

A kanban drag moves the real card — or the whole column — and the indicator is
drawn *under* it.

`armDragGroup` in `src/mermaid-edit.ts` (via `armCardDrag` / `armColumnDrag`)
registers itself with `session.start('drag', …)`. The session is what ends it.
A render between the press and the first movement takes the drawing the drag is
measured against *and* the window listeners that move it. A drag that outlived
a render would go on moving elements the render threw away and commit a move
from a board that is gone.

### Lifting

The drag lifts the elements the press landed on. The transform is *appended* to
the one mermaid gave each:

```text
base + translate(dx, dy) scale(1.04)
```

Restoring the drag is therefore putting strings back, not recomputing
positions. `stop()` always does it.

- A card drag lifts the one `g.node`.
- A **column** drag lifts the band's `g` from `.sections` *and* every card
  whose centre falls in that band, so the column moves with the cards still in
  it and one undo takes the whole move back.

A card is detected by `cardAt(pointer, cards)`: a direct
`closest('.items > .node')` target, falling back to a coordinate hit-test
through the shared `drawnElementAt`. Only a press that hit *no* card can arm a
column, so a card is never mistaken for the column it stands in.

The column's own frame excludes its header label, so the `⋯` and the column
name stay clickable.

### Coordinate mapping

The offset is divided by the mapping `svgMapping(svg)` reports: viewBox origin,
rendered rect and a scale per axis.

A drag is measured in screen pixels while the card is moved in a viewBox
mermaid has scaled to fit. The mapping is read on **every move**, not once at
the press, because a block that grew around a composer, a magnification and a
window resize all move the drawing. A mapping frozen at the press is a card
that lags or runs off.

Without it, the card runs off twice as far on any board that is not drawn at
1:1. Reading one scale for both axes would drift on a container that
letterboxes the drawing.

### Clipping, paint order and the drop line

Three things have to hold together. Each was a bug before it was a rule:

1. **The svg clips and the preview scrolls.** The svg has `overflow: hidden`
   and `.mermaid-preview` scrolls, so the preview gets `.kanban-dragging`.
   That switches both to `visible`; otherwise a card travelling off the board
   is cut off under the pointer.
2. **SVG paints in document order, so the card is re-appended** to the end of
   `.items` (all cards are one sibling list) to be on top. `stop()` puts it
   back before its own place. The model→element mapping is the *captured*
   `cards` array, which re-appending does not disturb; a fresh
   `cardElements()` walk would.
3. **The drop line is an svg `<line>` inserted before `.items`.** It is over
   the column's own opaque background but under every card, the dragged one
   included. For a column's line it is inserted before `.sections`, so it is
   under the frames it stands between.

The line cannot be a positioned overlay. A child of the preview paints above
the whole drawing (`z-index: 4` did exactly that, and the line drew across the
card it was previewing), and the `.mermaid` host puts it *under* the board
instead.

Being svg-native also means `vector-effect: non-scaling-stroke` holds it at 3px
on a magnified board, and its endpoints are written in the drawing's own user
units, so no scroll or zoom correction is needed. A line outside the board
would have to be positioned from
`container.getBoundingClientRect() + container.scrollLeft`, like the `⋯`.

`dropLineAt` draws the line in the gap the release acts on. It spans the column
and overhangs it by `DROP_LINE_OVERHANG`; mermaid's cards are about 15px
narrower than their column, so an inset line is completely hidden by the card
that is about to fill the gap. The vertical offset is `DROP_LINE_GAP`.

### A drawn slot ends the column

**A drawn slot ends the column; it is not a card in it.**

`dropColumn` decides that: the slot's rect comes back as the column's *end*
rather than as one more sibling. Both the index and the line are computed from
what it returns, so a pointer over the foot of a column is the pointer over the
last real gap.

Counting the slot instead put the line in a gap *below* the last card that no
release acts on. The card lands above the slot (the authoring source is rebuilt
with the slot appended last, whatever the patch did with it), so the line was
promising a place that does not exist.

It matters because the foot of a column *looks* like the slot: that is where
`+ Add a card` is drawn. This is the gesture every drag to the bottom of a
column makes.

The bug survived the earlier gates because `_pointer_drag(aim="last")` aims
just below the middle of the last *real* card, still above the slot.
`tests/window/test_window.py::test_kanban_drop_line_stays_above_the_drawn_slot` aims
at the slot's lower half, past the point where a slot-as-a-card would have
counted.

### A drawn column ends the board

A **column** drag is the same machinery with the slot question answered
differently. `dropSections` is the counterpart of `dropColumn` on the card
side:

- the real columns go into `rest` with the dragged one lifted out;
- the drawn `+ Add a column` comes back as the board's *end*, not as one more
  column.

`columnSlotAt` counts which gap line the pointer is over: gaps strictly before
the pointer, counted against `rest`, so a pointer over the dragged column's own
band does not shift the count. `columnGapAt` is that gap taken from the two
columns on either side of it, full height.

**The drawn column ends the board; it is not a column in it.** The last gap is
the one *before* it. A pointer over its right half is the pointer over the last
real gap, and a column dropped at the end of the board lands there, leaving the
slot the last thing drawn.

Counting it instead drew the rule at the slot's own right edge, out past the
board, offering a place after it that no release acts on. This is the mirror of
the card bug and the gesture every drag to the right of the board makes.

It survived the earlier gates because `_pointer_drag_column(slot=1)` aims past
the last *real* column's right edge by 24px, which lands 24px into the 200px
drawn column, comfortably before its middle and so also the gap in front of it.
`tests/window/test_window.py::test_kanban_column_line_stays_left_of_the_drawn_column_slot`
aims at 75% of the drawn column's width instead, past the point where a
slot-as-a-column would have counted.

A column boundary is a single unambiguous line, so unlike a card it needs no
`DROP_LINE_GAP`/`DROP_LINE_OVERHANG` nudging; `createDropLine` takes them as 0.
It is the only part of a drag that answers "which slot", since a card over a
three-card column can go first, second or third and the column outline cannot
say.

It is placed on *every* move, not only when the column changes, and it hides
itself off the board (a release there does nothing).

A column with neither cards nor a slot has no gap, so its line is centred in
the band. A drawn slot makes even an empty column card-tall, where the last gap
is above the slot like any other.

The card is never dimmed: it is lifted, not ghosted, and the hole it leaves is
the record of where it came from.

### Card scale versus column scale

**A card is scaled, a column is not.** That is why `liftElements` takes the
scale as an argument and `armColumnDrag` passes `1`.

A card is one `g`, and `scale(DRAG_LIFT_SCALE)` about its own local origin says
"this is in the air".

A column is a *frame with padding and cards inside it*, and an svg transform
scales about the *element's* origin. A scaled frame grows its border and
padding, pushes its cards out through the bottom, and the ones near the edge
fall out of the section entirely. That reads as a column of the wrong shape
travelling somewhere other than where it was dropped.

A `scale` on a column's transform is a bug.

### A column is not one element

**A column is not held where a card is, because it is not one element.**

The board is two sibling lists: the frames in `.sections` and the cards in
`.items`, frames *first*. Every card on the board is painted over every frame.

A lift that re-appends each element to *its own parent* — right for a card, one
`g` in one list — can lift a frame over the other frames and nothing else. A
column in flight was drawn with its neighbours' cards lying across it, and a
column *passing over* a neighbour's cards looked like it had picked them up.
That is how an empty `Done` at the end of a board came to look like it was
carrying `Specified`'s card.

So a column's lift is a group of its own: `kanbanDragLayer`, an svg
`<g class="kanban-drag-layer">` appended as the **last** child of the svg. It
holds the frame first and then the cards it carries, which is the order the
board itself is drawn in.

`liftElements` takes that group as its `into`, putting the whole set in one
parent. Its per-element restore is unchanged, because every element's own place
was captured before it moved.

Nothing about how either element is *painted* changes. Mermaid's kanban styles
key on the element's own classes (`.section-N rect`, `.node rect`,
`.kanban-label`), never on the list it is in. That is worth knowing before
moving anything else between those two lists.

The line stays *under* the held column, the way a card's does, and `stop()`
removes the group whether the drag started or not.

### Restore backwards

The restore runs **backwards** for the same reason.

Each element goes back before the `follower` it was captured with. With the set
in a group, that follower is often another lifted element still standing in the
group. Restoring in capture order throws `NotFoundError` on the first card,
which aborts the rest of the restore *and* `hooks.drop`. The drop is silently
lost and the rest of the column stays in the group.

A held card is also `pointer-events: none`, so the drop is read off the pointer,
not off whatever it passes over. That makes the group invisible to a hit test:
`elementFromPoint` cannot answer "what is painted over the held column" without
the helper lifting that for the sample (`fronted`), which is why that probe
restores it rather than leaving it.

### Cursors

The cursor says the same thing without a drag:

- an open hand over a card or a column;
- a closed one while it is in the air (`DRAG_CONTAINER_CLASS` goes on the
  *preview*, so the dragging rule is
  `.mermaid-preview.kanban-dragging …`);
- a text caret over a slot.

The grab rules exclude the two slot classes rather than out-specifying the
caret, because a slot is nowhere and so is not held by anything.

The `⋯` *is* a positioned sibling of the svg, so it does paint over the line
where the two meet. The real-engine probe therefore samples the line along its
run (`overLine`) rather than trusting one point, and `elementFromPoint` is the
check throughout, since a screenshot of a just-mutated DOM under the offscreen
platform is a stale frame and will lie.

## Chrome

**A board is authored from the board, and its chrome is quiet until the pointer
asks.**

`attachKanbanChrome` in `src/mermaid-edit.ts` builds the whole layer in one
pass: per real column, a `mermaid-kanban-menu` `⋯` (`<column> column actions`).

All of them share `KANBAN_BUTTON_CLASS` (`mermaid-kanban-btn`). The open menu
list and every composer are inside `KANBAN_CHROME_CLASS`. Those are the classes
`src/node/mermaid.ts` `stopEvent` and `blockModePlugin`'s gesture handler
recognise as chrome, so a press or an Alt+click on any of them is the control's
own and never reaches the diagram under it.

**There is no per-card control at all.** A card is deleted by dropping it on
the drawn column slot (see below), so the layer has one mark per column and
nothing over a card.

**Adding is not in this list at all.** The board is *drawn* with somewhere to
add, so the places to add are part of the diagram rather than controls laid
over it. `attachKanbanChrome` has nothing to say about them, which is also why
the layer's `place()` is the only thing that can move a control and never a
slot.

### A column's `⋯`

**A column's `⋯` is on the same line as the column's name.**

`menuBox()` measures the name's own box (`headerTarget(band)`, the same target
a click on the header renames) and centres the mark in it. The name is what the
eye puts the mark against, and the band's own top edge is not where the name
is. The band is padded and the name is drawn inside that padding, so the old
`band.top + KANBAN_BUTTON_EDGE` put the `⋯` several pixels *below* the text it
is the menu of.

That is not a claim a hit test can make: nothing overlapped anything, the
control was in the right column and clear of the name (`_menu_in_its_band`
passed all of it), and the only way to see it was to look.

A band is the fallback for a name with no box of its own: one that is not
offered (a repeated name has no single target) or one not laid out yet, which
measures as no height.

**One control is always on screen.** The `⋯` belongs to the whole board, so it
is quiet (a flat mark) but permanent. A board that hid its only way to delete a
column behind a hover would be a board you could not get out of.

`columnAt` refuses a press on a column's own name, because that is a rename.
Nothing is concealed any more — a card is not a control surface — so the layer
has no reveal to make and no `is-shown` to read.

### The menu is a popover

**The menu is a popover over a board, not a dialog on it.**

One at a time (`closeMenu`). The `⋯` that owns it is remembered
(`openMenuFor`), so pressing *that* one is the toggle and pressing any other is
a move. Without that, a second `⋯` could only ever close the first menu.

The list hangs off its own `⋯`: right-aligned to it and `MENU_GAP` under it,
pushed through `place()` immediately rather than on the next resize. The list
is built long after the layer's own `place()` ran and would otherwise sit over
the first column.

A real column that is not the last one gets exactly `Rename column` / `Delete
column`. The last one gets no delete, and the drawn column at the end gets no
`⋯` at all because it is not a column yet.

The rename is wired to *the very mapper a click on the header uses*, found by
position:

```ts
targets.find((entry) => section.contains(entry.el))
```

Two columns may share a name, so finding by name is wrong.

**No item names the column.** An item belongs to the `⋯` it hangs off, and that
`⋯` already says which column it is. A name in the item would be a name
repeated in a place that a translation would have to keep in step with the
prompt's. `promptForKanbanDelete` is the one place that names what goes.

The corollary is that the menu is `MENU_WIDTH` wide and the *text* is bounded
by it (`white-space: normal`, `overflow-wrap: anywhere`). A label wider than
the menu wraps inside the popover instead of widening it off the board, which
stops a column with a 60-character name pushing a control past the edge of its
own column.

Escape and a pointer off the menu or the board take it away. **The menu is its
list *and* the `⋯` it hangs off**: `isOnMenu(target)` whitelists both, using
the `openMenuFor` that already answers "which `⋯` is this".

Hovering the owning mark is not leaving the menu. The walk from an item back up
to the button that opened it is the other half of the same gesture; it used to
close the list every single time, which reads as the menu being unable to
survive a second look.

A *different* column's `⋯` is a move rather than a return, so it does take the
menu away. Only the one that owns it is the menu's own.

A press anywhere that is not the list also takes it away. The `⋯` and the items
stop the press from reaching the board, so the `⋯`'s own click is the toggle.

**There is no gap between the `⋯` and its list, because a gap is a hole in the
popover.** The list is placed at the button's own bottom edge (`menuBox()`'s
height, not that plus anything), right-aligned to it, so the menu hangs off the
`⋯` that owns it and the two touch.

The old placement was 6px lower. That left a strip of *board* between a button
and the menu it had just opened. The pointer crossed it every time, so it was
bridged with a `::before` over the gap, using a shared
`--mermaid-kanban-menu-gap` number so the stylesheet and the placement could
not drift.

**A bridge with no background closes a hole for a hit test and not for the
eye.** `elementFromPoint` over it reported the list and every real-engine gate
passed, but what the user saw was the board. The gap, the variable, the
read-back and the pseudo-element are all gone; with the boxes touching there is
no hole to bridge.

What still stands is not geometry: `menuList` stops `mousedown`, so a `click`
can never be born out of a press the board ate. The walk down from the button is
answered by the two boxes themselves.
`tests/window/test_window.py::test_kanban_menu_and_drawn_add_and_delete_columns`
samples every pixel from inside the `⋯` down into the list's first row and
asserts the whole run of answers is `['its button', 'the menu']` with
`elementFromPoint`. Anything else painted between them — a gap, a stray
sibling — fails it.

## Drawn slots

**The board is drawn with somewhere to add, and the document never sees it.**

A board's shape is obvious while you are looking at it and not at all once it
is a paragraph of source. So the places to add are *drawn*.

`kanbanAuthoringSource` in `src/mermaid-edit.ts`:

- appends a `__edi_slot_c<n>` card to every column;
- appends a `__edi_slot_n` column to the end;
- **and a card slot inside that column too**.

The card slot in the drawn column means the board ends in a column with
somewhere to put the card you are about to add, rather than in a bare header.
It is also where a card can be deleted: that slot is the bin.

Each carries `KANBAN_CARD_SLOT` / `KANBAN_COLUMN_SLOT` as its label. The node
view renders this authoring source while the diagram is editable, never the
document's own source.

A drawn slot is laid out by mermaid itself. That is the whole reason it beat
the controls it replaced. An empty column's band is sized to its header alone,
and a 24px bar laid over that name covered the rename target. A card-shaped
thing drawn *in* the band:

- makes the band a card tall;
- gives every column a place to add without a single absolutely-positioned
  sibling;
- cannot collide with the toolbar or a horizontal scroller, because it is not
  one.

### Reserved ids and real source

The reserved ids make this safe: `/^slot[cn]\d*$/` is an id nothing else on a
board would carry. A card the user has genuinely titled `+ Add a card` is a
real card. `isKanbanCardSlot` / `isKanbanColumnSlot` are the only readers.

Every commit runs the source back through `kanbanRealSource`, which:

- strips an untouched slot;
- keeps a *named* one as clean content (`[Fresh]`, `col1[Archive]`) with a
  fresh id from `freshKanbanId`, which steps over the ids already on the board,
  cards included.

The document is never asked to hold a slot.

Everything that used to walk the board as chrome has to know the difference:

- `kanbanColumnCount`/`realKanbanColumns` answer "how many columns"; the menu
  offers no delete when it is one;
- `cardsIn`/`kanbanColumnCardCount` answer "how many cards"; a delete prompt
  must not claim it is taking slot cards;
- `slotAt` is where a *new* card goes — the drawn slot's own place, so the slot
  stays the place the next card would go.

### Pressing a slot

A press on a drawn slot is a request for a title, not a drag. The pointer
handler returns before `armCardDrag`/`armColumnDrag`, and the drawn column is
not a column to drag either.

`onSlotClick` finds the slot with `drawnElementAt` (the event's own target
first, then the coordinate hit test) and then *defers to the label editor*. A
click on a label is that label's business, so the column slot hands
`headerTarget(band)` to `openLabelEditor`, and a new column is named by the
very editor its own header is renamed by.

A card slot opens the composer at the slot's own `box()` (`slotComposerBox`) —
**except the card slot in the drawn column**. That one is the bin when a card
is in the air and is *still* a column to name at rest, so a press there is
routed on by the column's own band rather than answering a question about a
card that was never offered.

That is why an in-place assertion reads the field and the slot in *one*
snapshot. The page settles between two reads, so two boxes read at two moments
are two moments of the layout, not two boxes.

### A drawn slot's label is a placeholder

A card slot is not a label target at all: the card filter in
`attachMermaidEditing` drops it, and its composer opens from the slot.

A column's *is* one; its name is a label like any other, which is the whole
reason the slot can be named by the editor that renames it. So the *same* press
on a slot's text and on the band around it must not open two different fields.

Both therefore pass one `FreshField` into `openLabelEditor`:

```ts
columnField(band)
```

It has an empty value, `placeholder: 'Column name'`, `tone: 'new'`, and the
band's width at `COMPOSER_HEIGHT`.

The generic click handler works it out from the *same* slot walk: `slotBand` is
`sectionElements(svg)[slots.column]`, not a CSS class, so a class that outlived
its render cannot make a real header open empty.

What is being filled is a column, so the field stands in the band and not over
the text on it, and `RENAME_FIELD_WIDTH`'s floor is dropped: a band is already
wider than a name.

An empty commit is refused by the `usableKanbanLabel` guard every label already
had, with the same reason a card gives: a `kanban` header with nothing in it is
not a column.

### Positioning the layer

The layer is positioned the way the drag indicator is *not*: these are
absolutely-positioned HTML siblings of the svg, from `container`-relative rects
through one `place()`.

What `place` reads is re-read on every event that can have moved it:

- a `ResizeObserver` on the svg, on the preview **and** on the editor scroller;
- their `scroll` events.

The svg alone is not enough: a window resize narrows the preview while the svg
keeps the size mermaid drew it at, so the observer never fires. The preview
alone is not enough: a composer hanging below a short board scrolls the
*editor*.

No observer covers the rest. The board is *centred* in the preview, so the svg
slides inside it when the block around it grows, moving every control without
changing the size of anything measured.

So an event asks `schedule()` rather than placing directly, and a `place()` that
moved something asks for another. That is a self-limiting settle loop that ends
as soon as a place moves nothing, which makes re-placement a convergence rather
than a per-frame cost.

Every re-render *rebuilds* the layer, so the controls exist only in edit mode
and are gone after Done.

It is offered only where the walk is trustworthy: `cardElements(svg)` must
match the parsed model's card count, and the columns must match the sections'.
Otherwise the layer is skipped rather than offering to delete something it
cannot name.

The drawn slots are none of this: they are drawn by mermaid, laid out by
mermaid and repositioned by mermaid.

## Deleting: the bin

**A card is deleted by dropping it on the column the board is drawn with,
because a card's corner is its own title.**

Mermaid lays a card's label into the *whole* inner width, so a title long
enough to fill its card runs right up to the card's edge (measured: a 185px
card, a label box 364.5→539.5 against a card 354.5–539.5). The top-right corner
is drawn over the first line of exactly the cards a user most wants to read.
There is no padding to move a ✕ into and no second corner that is not the same
problem.

Moving a mark *out* of the card is worse: the band's corners are rounded, so a
mark hanging past one is over the page rather than over the card.

So the ✕ went. For the length of a card's drag, the drawn column slot at the
end of the board — a place to add a column, and the one thing on the board a
card has no business in — **is** the bin, and it says so.

That column is drawn *with a card slot in it*
(`kanbanAuthoringSource` appends `__edi_slot_c${doc.columns.length}` under `__edi_slot_n`),
and that card slot is the bin.

**At rest it paints nothing.** A card captioned `+ Add a card` standing in a
column captioned `+ Add a column` is the one place on the board offering a card
to a place, and the press it invites is answered with a *column*. The caption
would be a caption over the wrong answer.

The space is still drawn — mermaid sized the band around it, and **a drag may
not re-render the drawing**, so the space cannot be added on demand. It is
emptied by class instead:

- `attachKanbanChrome` puts `mermaid-kanban-bin-slot` on that one slot on every
  render;
- the stylesheet takes its frame and label off with `display: none`;
- `kanbanTrash`'s `show()` takes the class off in the same turn that writes the
  bin's words on it; `hide()` puts it back.

`display: none` rather than `visibility: hidden` is what makes a press in the
empty space a press on the band, the one that names the column.

### The bin is of the drawing

`kanbanTrash` is armed by `DragHooks.begin`/`end`, so it appears when a *press
becomes a drag* and not on the press, since a press on a card is a rename.

It does not lay a control over the bin. It mutates the drawing, dressing *two*
parts of it:

- the band;
- the card slot in it.

Both get `--danger` on their own `<rect>`s and `trashIcon()` in their own
names. `hide()` puts both back from what it saved.

**Both halves say it, because the card in the air covers the one you would
rather read.** The held card is 192px wide and the bin card slot is 185px, so
the pointer is over the slot and the slot is under the card. The band above it
is the half that stays on screen. Dressing only the card produced a bin that
was only ever legible when nothing was on top of it.

**The bin is of the drawing, not laid over it.** That is not a style
preference; it is what makes it legible:

- a card is a `g` in `.items`;
- a column is a `g` in `.sections`;
- `.sections` comes *first*, so every card is already painted over every
  frame, and a lift re-appends the held card to the end of its own list.

An HTML panel is a child of the preview and paints over the whole drawing,
including the very card on its way to the bin. It would hide the one thing you
could read while deciding.

It cannot be re-rendered into either: a re-render mid-drag takes the held card
with it, which is the same reason the drag never re-renders.

The bin **replaces** the words on both halves rather than adding a caption over
them, so the column reads as one thing for as long as the drag lasts. It is
gone before any *press* could reach it, which keeps the two gestures on one
column from colliding.

A press anywhere in that column, *including its card slot*, still names a new
column: `onSlotClick` routes a press in a real column's card slot to the card
composer, and anything past the drawn column's card slot through to the
column's own editor.

While the pointer is on it, both halves are lit:

- fill-opacity `0.14` → `0.28`;
- stroke `2px` → `2.5px`;
- deliberately **not** the `kanban-drop-target` class a drop target is marked
  with, which would be a second border round a bin.

The drop line stays hidden, so the two answers are complementary: nothing is
promised where a card cannot land, and a lit bin is what is offered instead.

The delete is still the same `promptForKanbanDelete` the ✕ used.
`armColumnDrag` is untouched: a *column's* end is a gap, not a bin, and
`dropSections` already reads it that way.

The label is read the way mermaid drew it: `.cluster-label .nodeLabel`, with a
`.cluster-label p` fallback for a renderer that uses one.

### Two halves, two lengths

**The two halves say different amounts of the same sentence, and that is
measured, not chosen.**

Mermaid sizes each label box to the words it drew: the band's for
`+ Add a column`, the card's for `+ Add a card`. A `foreignObject` clips in
*both* axes, so a bin that said one fixed string in the card's box was showing
`Delete` and cutting `card` off.

Both strings are fixed, so both boxes are the same size on every board:

- the band says `Delete card` (116px in a 128px box);
- the card says `Delete` (76px in a 105px box).

The mark is drawn as an **inline** svg for the same reason, and needs a
`display` of its own to stay one. The drawing's own
`.ProseMirror .mermaid svg { display: block }` rule made it a block, and a block
mark pushes the words after it onto a second line that the one-line box then
cuts.

Its colour is **inline on each path** for a third reason. Mermaid styles `path`
inside a board with its own palette, and such a rule beats both an inherited
value and a presentation attribute. The mark came out stroked *and filled* in
the diagram's colours while the words beside it were the danger colour: an
element reading `--danger` and a mark that is not. Nothing short of an inline
style wins that. `var(--danger, currentColor)` is the fallback so it can never
end up with no colour.

All three were found by measuring in the real engine rather than by looking.
`KANBAN_TRASH`'s `fits` asserts both axes, and its `markStroke`/`markFill` are
read off a **path**, not off the mark. A screenshot of a just-mutated DOM is a
stale frame that would have been believed instead.

`tests/window/test_window.py::test_a_card_dropped_on_the_board_s_slot_column_is_deleted`
walks the whole gesture in the real engine and pins the paint order
*structurally*:

- the frames before the cards;
- the held card last in its own list;
- the card's box over the pointer;
- the band's box under it.

A held card is `pointer-events: none`, so a hit test cannot see it at all; the
probe asserts the boxes rather than asking `elementFromPoint`. It also asserts
both label boxes hold their own words whole.

Five jsdom cases cover the tint's own values on both halves, the different
words on the two, the Cancel path and the two ways it must *not* appear.

## Composers

**A composer is taller than the slot it fills, so the block grows for it.**

A field is absolutely positioned, so it contributes nothing to the block's
height. An empty column's band is only a header and a card tall, so a field
asking for a long card title hangs below the band. At the end of a document,
the part that hangs is not something the editor can scroll to: the dialog is
simply cut off.

`openInlineInput`:

- measures the difference and sets the block's `padding-bottom` to it
  (`FIELD_MARGIN`);
- scrolls the field into view only when it really grew;
- puts the padding back on close.

It takes the rect as a *function* when the caller has one
(`spec.rect: DOMRect | (() => DOMRect)`, reported through `onPlaced`) and is
repositioned from the chrome's `place()` like every other control. A composer
stands where the control it replaced stood, and the board moves under it. The
chrome drops the entry as soon as the field is gone, which is the only signal
that it closed.

A column's name is one line and is edited by the label editor, not by a
composer. `COMPOSER_HEIGHT` therefore only ever sizes the *card* composer,
which is the one that grows with the title and the one that can be taller than
the band it fills.

### A composer grows with its title

`InlineInputSpec.multiline` makes `openInlineInput` build a `textarea` and size
it to its own content on every `input` (`scrollHeight`, from `auto` up), capped
at `COMPOSER_MAX_HEIGHT` and scrolling past it.

A card title is longer than the card-shaped slot it was opened from more often
than not. A fixed box either scrolls the rest of the title out of sight or
covers the columns behind it with a field nothing is being typed into.

It is sized **on construction as well as on every `input`**, and that second
half is not a nicety. `input.value` is assigned before the sizing runs, so a
field built around a title that is *already* in it — a rename
(`editCardTitle` seeds it with the title it is replacing), and every field
re-homed after a render — came back at the height of the slot it was standing
in. The card had already been stretched to the title, so that is a 5-line card
with a 2-line composer on it and the rest of the title scrolled out of sight,
one keypress away from being committed as the whole of it.

An empty composer is left alone, so opening one still does not resize the card
it replaces.

**Enter is the commit key and Shift+Enter is refused, not committed.**
Shift+Enter is how a textarea normally starts a new line, and a mermaid card
title cannot hold one. Committing would drop the break *and* leave the rest of
what was typed behind in a field that has gone, so the field stays open with
the value the user has.

## Delete asks first

**A delete asks first, and says what it is taking.**

Deleting a card or a column runs `promptForKanbanDelete(subject, consequence)`
in `src/urlDialog.ts`:

- `Cancel`/`Delete`, with Delete in `toolbar-danger`;
- a note naming what goes and, for a column with cards, how many go with it;
- Escape and a backdrop click as cancel.

It is a dialog rather than a `window.confirm` because a board is the user's
document and a delete is undoable; the note says so.

`removeKanbanCard` / `removeKanbanColumn` in `src/mermaid-edit.ts` are the pure
patchers that answer it:

- the first removes one card line;
- the second removes the column header and every card indented under it.

The second **refuses on a board of one**, because emptying the last column
leaves a `kanban` with no columns, which is not a board.

Nothing is patched until the answer is `true`, and each is one
`setNodeMarkup`, so one undo takes the whole deletion back.

The walk that builds a column's header controls is positional (`doc.columns`,
`cardElements(svg)` filtered by which band a card's centre is in), the same
mapping the drag already used. A card that lands in no band is left alone
rather than guessed at; there is no per-card control left to build.

## A field that adds is not a field that overwrites

`openInlineInput` builds a `div.mermaid-edit-field` around the input rather than
the bare input it used to be, because the bare one had no way to carry a shape.

- A rename gets no `tone` and a `minWidth` of `RENAME_FIELD_WIDTH`.
- An add gets `tone: 'new'`, which is what the dashed accent edges in CSS are
  for, plus a `minWidth` wide enough for a real card title
  (`NEW_FIELD_WIDTH`).

It needs **no words**. It used to print a caption above the field (`New card in
<column>`, `New column after <column>`), and that was one thing too many. The
place the field was opened from is *drawn in the board*, so the board is the
sentence the caption finished. `tone: 'new'` says "this creates" without a
label to keep in step with the source, truncate or translate.

The wrapper owns the geometry, and the input is its only child. The field is
therefore one box to place, size and clip to nothing. An absolutely positioned
child of a horizontal scroller is placed from the scrolled content, not from
the visible box, so the preview's own scroll has to be added back.
`field.remove()` on commit/cancel takes the whole thing with it.

The `onAccept` contract is unchanged and is still the only place a title can be
refused: `true`, `false`, or a *reason* (`usableKanbanLabel`). A name mermaid
cannot read is refused before it is committed, by the same rule the label
editor has always used.

## A new board

**A new board is `insertKanban` end to end.**

`buildKanbanSource(columns)` (pure, in `src/mermaid-edit.ts`) turns names into a
runnable diagram:

```text
['Todo','Doing'] -> kanban
  col1[Todo]
  col2[Doing]
```

Unwritable names are dropped, repeats are suffixed ` (2)`, and it returns `''`
when nothing survives.

`promptForKanbanColumns()` in `src/urlDialog.ts` asks for the names, one per
line. It is a textarea, so plain Enter is a *newline* and Ctrl/Cmd+Enter (or
Add) confirms.

`insertKanbanSource()` in `src/node/mermaid.ts` does the insert as **one**
transaction with the mode already set (`openDiagramEditIn()`, shared with
`enterDiagramEditMode`), so one undo takes the whole board away.

`insertKanbanBoard()` wraps the dialog, the builder and the "none of those
names can be used" error. It is what the Insert-menu QAction (`insertKanban` in
`MenuCommands`, and the toolbar's Kanban button) calls.

## Titles and quoting

**A kanban title is free text, quoted on the way in.**

Mermaid's kanban grammar reuses the flowchart *shape* delimiters inside a
`[…]`, and a *quoted* label can hold them. Mermaid draws a quoted label as the
text inside the quotes and nothing else.

`kanbanInnerLabel()` is the single writer used by all three paths: a new card,
a new column and a rename. It quotes anything in `KANBAN_QUOTE_CHARS`
(`[ ] ( ) { } @ > " &`):

```text
Fix (the bug)  ->  ["Fix (the bug)"]
```

The quotes are never anything the user typed or saw.

That set is the whole shape syntax, deliberately a **superset** of what real
mermaid rejects bare. A 40-diagram sweep says only `]`, `(`, `)` and `}` are
rejected; `[`, `{`, `<` and `>` all render. The two extras are ours:

- an unquoted label holding `@{ … }` is silently eaten as metadata;
- one holding `>` renders, but `kanbanLabelSpan` refuses it as a shape with no
  closer — a title the user typed that is not the title the board shows.

Do not narrow the set.

The reader mirrors the writer. `kanbanLabelSpan()` recognises the quoted form
*first*, before the shape search, or a bare `"Fix (bug)"` finds its own `(` and
maps to `bug`. It returns the **whole quoted run, quotes included**.
`parseKanban` unquotes *and unescapes* it into `label`.

So a rename replaces the run, and a label already written with quotes keeps
them (`kanbanQuotedLabel`; `replaceSpans` writes one spelling over every span,
so a mixed board takes the conservative one).

### A quote is carried as an entity

**A `"` is carried as an entity, not refused.**

Quoting is what makes a raw quote fatal. A quoted label is drawn as the text
inside its quotes, so a `"` written raw closes the run it sits in and the rest
of the title is read as source:

```text
["He said "hi" (loud)"]   # real parse error
```

Mermaid has no backslash escape for it. But the quoted run *does* take an HTML
entity:

- `&quot;` is not a quote to the grammar;
- it survives the run;
- mermaid draws it as `"`.

So:

```text
["He said &quot;hi&quot; (loud)"]
```

renders `He said "hi" (loud)`, and `[&quot;]` is a card whose whole title is one
quote.

`escapeKanbanEntities` escapes `&` *first* (so a title holding the literal text
`&quot;` comes back as that text rather than as a quote) and `"` second.
`unescapeKanbanEntities` inverts it in the same order. Both `"` and `&` are in
`KANBAN_QUOTE_CHARS`, so any title holding either is always written quoted.

This was a refusal first, on the belief that a quote was unrepresentable. The
belief was never tested, and it was wrong. Do not re-derive it from the grammar
docs.

`src/mermaid-kanban-escaping.test.ts` renders every case through **real**
mermaid; every other test here mocks `mermaid.render`, which is how the wrong
belief survived. `scripts/mermaid-label-probe.py --type kanban` walks the
escaped spellings through the real gesture, and its `spelled_out` check decodes
`&quot;`/`&amp;` first because a successful rename legitimately leaves entities
in the source.

### What quoting cannot carry is refused

`UNUSABLE_KANBAN_LABEL` is a line break. It is checked by `usableKanbanLabel()`
at the *UI* boundary:

- the card slot composer;
- the menu's `onAccept`;
- `openLabelEditor`.

It returns `kanbanLabelRefusal()`. `openInlineInput`'s `onAccept` returns
`true`, `false`, or a *reason*; a reason flashes the input red and shows a
notice.

A committed title mermaid cannot read would leave the board on its last good
render with the card the user just typed visible nowhere. That is the whole
failure this quoting exists to prevent.

The one shape the mapper must still refuse blind is an *unterminated* quote
(`["Half open`): nothing says where the label ends, so `label` is `null` and
the label is not offered.

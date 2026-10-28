# Inline marks

`src/markExit.ts` owns one rule:

> A mark ends at its closing delimiter or when you walk out of it with an
> arrow key. Both are about the *next* character, never about the text already
> written.

`**bold** and more` is a sentence with two bold words in it, not a bold block.
Neither the delimiter path nor the arrow path touches the document:

- `stopMarking` (wrapped onto every inline input rule in `src/editor.ts`)
  writes `storedMarks`;
- `markExitPlugin` does the same for `ArrowRight`/`ArrowLeft`.

This started as a code-span rule and was generalized. The tests are in
`src/markExit.test.ts`.

## Why `storedMarks`

The whole mechanism is `storedMarks`, and three properties are load-bearing:

- It wins over the document for exactly as long as it stays set. That is why
  one write is what a closing delimiter means.
- Any step clears it.
- `Transaction.setSelection` clears it too. Anything that moves the selection
  *and* wants to keep a mark must call `setSelection` first and
  `setStoredMarks` second. The reverse order loses it, silently.

"What the next character inherits" is:

```ts
state.storedMarks ?? $from.marks()
```

At the *end* of a run, `$from.marks()` reports that run's marks, because the
position is still its boundary. That is exactly why a finished span used to
drag the rest of the sentence into itself.

## When the arrow fires

The arrow handler only fires where the browser cannot do it itself:

- the caret is at the end (or start) of its textblock's text; **and**
- there is no node beyond it at any nesting level (`noNodeBeyond` — no
  following paragraph, no next list item).

Everywhere else the browser's own arrow already moves the caret, and the
position it lands on is outside the run. Those presses work and must keep
working. Handling them would make `→` a key that sometimes does not move the
caret.

Two traps in that check:

- `ResolvedPos.index(depth)` is the index *into* that level, so the node at
  `depth` is `index(depth - 1)`.
- The siblings are `node(depth - 1).childCount`; a textblock's own
  `childCount` is 0 because its text is inline.

Only the **innermost** mark is left. A mark set is rank-ordered and `code` is
innermost per `orderedMarks`, so `→` out of a code span inside bold leaves the
bold.

## Whole-run delimiter guards

Every delimiter's opening run has to be a whole run on **both** sides of it:

- a lookbehind, so the pattern cannot start inside a longer run;
- a lookahead, so it cannot start one.

Without both, a shorter sibling pattern steals the pair mid-typing. Typing
`~~strike~~` reaches `~~strike~` first, and the subscript rule's `~…~$` matches
`~strike~` inside it (its inner group is `(.*?)`, so it may swallow a `~` of
its own), which made strikethrough a subscript.

`createPairedDelimiterMark` carries both guards for `==`/`~`/`^`.
`inlineMarkRules` carries the lookbehind for `**`/`*`/`` ` ``/`~~`, whose inner
groups already exclude their own character.

## Shortcuts

`Ctrl+Alt+C` (`Alt-Mod-c` in `formattingKeymap`) is the only keyboard shortcut
for inline code. `formattingKeymap` also has `Mod-b`/`Mod-i`.

`Mod-Shift-C` is **copy selection as Markdown** in `src/editController.ts`,
not a formatting toggle. Copy file path is `Ctrl+Alt+Shift+C`. Do not reach for
either when adding an inline-mark shortcut.

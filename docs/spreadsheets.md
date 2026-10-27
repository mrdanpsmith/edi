# Spreadsheet formulas

## The function registry

`src/formulas.ts` is the single source of truth for the function registry and
the value/coercion helpers. `src/spreadsheet.ts` is the parser/evaluator and
evaluates through a `FormulaEnv`:

```ts
{ functions: ReadonlyMap<string, FormulaFunction> }
```

Functions are looked up case-insensitively.

`solve`, `computeSpreadsheet`, `resolveTableValue`, `proseToMarkdown` and
`serializeDocToHtml` all take an optional env that defaults to `BUILTIN_ENV`.
Any path that re-serializes a resolved table must thread the document's env
through: the editor's `getMarkdown`, export and the table node view all do.

`src/series.ts` derives `FORMULA_FUNCTIONS` from `BUILTIN_FUNCTION_NAMES`, and
`src/formulaReference.ts` generates the Help → Formula Reference document from
`BUILTIN_FORMULAS`. A new builtin therefore cannot drift between the evaluator,
reference-shifting and the documentation.

## Document-local functions

Document-local functions come from `code_block` nodes with
`language === 'edi-formula'`, one `NAME(params) = expression` per line. `#`
starts a comment.

`src/formulaDsl.ts` parses and compiles them. It rejects:

- builtin-name collisions;
- duplicate names;
- cycles.

`src/formulaDefs.ts` is an editor plugin that compiles every such block
(document-wide) into a `FormulaEnv` in plugin state. It decorates rejected
blocks with `.edi-formula-invalid` and exposes the environment through
`formulaEnvFor(state)` and `documentFunctionsFor(state)`.

Builtins are never overridable. A rejected definition makes cells that call it
resolve the usual `#NAME?` error.

Function-name autocomplete lives in `src/formulaAutocomplete.ts` and is fed by
the table node view's `formulaFunctions()` — builtins plus document
definitions.

## Two parsers, one scanner

There are two recursive-descent parsers:

- `FormulaParser` in `spreadsheet.ts`, which reads a cell expression such as
  `=B2*2`;
- `BodyParser` in `formulaDsl.ts`, which reads the right-hand side of a
  definition.

They are separate because a body has to mean in a body exactly what it means in
a cell. What they share is the **lexing**, in `src/formulaScanner.ts`:

- `pos`;
- `match`/`peek`/`skipWs`;
- `readNumber`;
- `readString` (a doubled `""` is an escaped quote);
- `matchComparisonOp` (two-character forms first, so `<=` is not read as `<`
  then a stray `=`).

What they do **not** share is what a token means. The cell parser resolves `B2`
against a grid; the body parser resolves a name against its parameter scope and
can run in validate-only mode. `atom`/`comparison` therefore stay in each
subclass.

The A1 conversions (`lettersToCol`/`colToLetters`) are shared in
`src/cellRef.ts`, not exported from `spreadsheet.ts`. That lets `series.ts`'s
reference shifter use them without importing the grid and the DOM table
rendering.

Duplicating either the scanner or the A1 conversions is how the evaluator and
the definition language silently diverge. Both modules' own tests are the
backstop.

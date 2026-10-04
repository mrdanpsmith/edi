# Formula & Function Reference

A cell whose text starts with `=` is a formula. Type one directly in a cell,
or select a cell and use the `fx` bar above the grid.

## Operators and references

- Arithmetic: `+`, `-`, `*`, `/`, `^` (and unary `-`)
- Comparisons: `=`, `<>`, `<`, `<=`, `>`, `>=` — result in `TRUE`/`FALSE`
- String literals: `"quoted text"`; double a quote to embed one (`"say ""hi"""`)
- The constants `TRUE` and `FALSE`
- Dates: an Excel-style serial number (days from 1899-12-30) — see `dateToSerial`, `serialToDate`, `formatDate`
- Cell references: `B2`; add `$` to freeze an axis when a formula is filled
  or copied (`$B$2`, `B$2`, `$B2`)
- Ranges: `B2:C4`, usable wherever a function expects a list of values —
  numbers for the aggregate functions, text for `CONCAT`/`TEXTJOIN`/`EXACT`
- A cell starting `==` is a markdown highlight, not a formula

## Built-in functions

{{BUILTINS}}

## Errors

- `#NAME?` — unknown function or reference name
- `#REF!` — a reference points outside the table
- `#VALUE!` — a function or operator expected a number
- `#DIV/0!` — division by zero
- `#NUM!` — an argument is outside a function's domain (e.g. `LN` of a
  non-positive number, `LARGE` with a rank larger than the range, or
  opposite signs in `CEILING`/`FLOOR`)
- `#N/A!` — `IFS`/`SWITCH` found no matching result
- `#CYCLE!` — a formula depends on itself, directly or indirectly
- `#ERROR!` — the formula could not be parsed

{{DOCUMENT_FUNCTIONS_SECTION}}

## Defining your own functions

A fenced code block tagged `edi-formula` defines functions for every table
in the document:

````
```edi-formula
MYAVG(a, b) = (a + b) / 2
TAX(amount) = ROUND(amount * 0.2, 2)
```
````

Use them like any built-in, e.g. `=MYAVG(B2, C2)`. Parameters may receive
numbers, cells, or ranges; a range arrives as the list of its numeric values,
so it can be passed straight to `SUM`, `AVERAGE`, and friends. Definitions
may call built-ins and other document functions. A name that collides with a
built-in, repeats another definition, or forms a loop is rejected.

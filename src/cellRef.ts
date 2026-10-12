/**
 * A1-style cell addresses. Both ends of the spreadsheet need these: the
 * evaluator (`spreadsheet.ts`) turns `B2` into a row/column pair, and the fill
 * handle's reference shifter (`series.ts`) rewrites those same addresses inside
 * a copied formula. It is one address space, so the conversion is written once.
 *
 * `series.ts` needs this without dragging in `spreadsheet.ts` (which owns the
 * grid and the DOM table rendering), which is why these live here rather than
 * being exported from the parser's module.
 */

/** The letters of an A1 column to its 1-based number: `B` → 2, `AA` → 27.
 * Callers keep the token grammar to letters; anything else is not an address. */
export function lettersToCol(letters: string): number {
  let col = 0
  for (const char of letters.toUpperCase()) {
    col = col * 26 + (char.charCodeAt(0) - 64)
  }
  return col
}

/** The 1-based number of an A1 column to its letters: 2 → `B`, 27 → `AA`. */
export function colToLetters(col: number): string {
  let n = col
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

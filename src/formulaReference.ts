/**
 * Generates the "Formula & Function Reference" document. Built from the
 * function registry (`formulas.ts`) so the reference can never drift from what
 * the evaluator actually supports; the prose around it lives in
 * `src/docs/formula-reference.md` so it can be edited as markdown.
 */
import { BUILTIN_FORMULAS, type FormulaFunction } from './formulas'
import template from './docs/formula-reference.md?raw'

const CATEGORY_LABELS: Record<FormulaFunction['category'], string> = {
  aggregate: 'Aggregate',
  math: 'Math',
  logical: 'Logical',
  text: 'Text',
  lookup: 'Lookup',
  date: 'Date',
  utility: 'Utility',
  custom: 'Custom',
}

const CATEGORY_ORDER: FormulaFunction['category'][] = [
  'aggregate',
  'math',
  'logical',
  'text',
  'lookup',
  'date',
  'utility',
]

function functionEntry(fn: FormulaFunction): string {
  const lines = [`- **\`${fn.signature}\`** — ${fn.summary}`]
  if (fn.example) {
    lines.push(`  Example: \`${fn.example}\``)
  }
  return lines.join('\n')
}

/**
 * Build the reference as markdown. `defs` are the functions defined in the
 * current document, listed in their own section when present.
 */
export function buildFunctionReferenceMarkdown(defs: readonly FormulaFunction[] = []): string {
  const builtinSections: string[] = []
  for (const category of CATEGORY_ORDER) {
    const fns = BUILTIN_FORMULAS.filter((fn) => fn.category === category)
    if (fns.length === 0) continue
    builtinSections.push(`### ${CATEGORY_LABELS[category]}`, '')
    for (const fn of fns) {
      builtinSections.push(functionEntry(fn), '')
    }
  }

  const documentSection =
    defs.length > 0
      ? ['## Functions in this document', '', ...defs.flatMap((fn) => [functionEntry(fn), ''])].join('\n')
      : ''

  return template
    .replace('{{BUILTINS}}', builtinSections.join('\n').trimEnd())
    .replace('{{DOCUMENT_FUNCTIONS_SECTION}}', documentSection)
}

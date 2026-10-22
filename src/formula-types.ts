/** Shared types for the formula subsystem. Split out of `src/formulas.ts`
 * so value/coercion helpers and the registry can depend on them without a
 * circular import. */

export type CellValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: number }
  | { kind: 'blank' }
  | {
      kind: 'set'
      items: CellValue[]
      rows: number
      cols: number
      row1?: number
      col1?: number
    }
  | { kind: 'error'; message: string; hint?: string }

export type ErrorCell = Extract<CellValue, { kind: 'error' }>

export type CellValueThunk = () => CellValue

export type FormulaCategory = 'aggregate' | 'math' | 'logical' | 'text' | 'date' | 'lookup' | 'utility' | 'custom'

export interface FormulaEnv {
  readonly functions: ReadonlyMap<string, FormulaFunction>
  readonly now?: () => Date
}

export interface EvalContext {
  readonly env: FormulaEnv
}

export interface FormulaFunction {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly category: FormulaCategory
  readonly signature: string
  readonly summary: string
  readonly example?: string
  readonly minArgs: number
  readonly maxArgs: number
  readonly lazy?: boolean
  call(args: readonly (CellValue | CellValueThunk)[], ctx: EvalContext): CellValue
}

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>='

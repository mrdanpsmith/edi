/**
 * Formula function registry — the single source of truth for what the
 * spreadsheet parser can call.
 *
 * `spreadsheet.ts` evaluates through a `FormulaEnv` (built from this registry,
 * plus any document-local definitions), and `series.ts` derives its "this token
 * is a function name, not a cell reference" set from `BUILTIN_FUNCTION_NAMES`,
 * so adding or renaming a builtin cannot drift between the evaluator, the
 * reference-shifting code, and the generated documentation.
 */

import type { CellValue, CellValueThunk, FormulaEnv, EvalContext, FormulaFunction } from './formula-types'
export * from './formula-types'
import { err } from './formula-values'
export * from './formula-values'

// --- Builtin call bodies --------------------------------------------------
import { BUILTIN_FORMULAS, isBuiltinName } from './formula-builtins'
export * from './formula-builtins'

/**
 * Build the callable lookup: builtins first, then `defs`. A definition whose
 * name or alias is a builtin is ignored, so builtins can never be overridden;
 * document definitions (which are validated before they reach here) take
 * precedence over one another in iteration order.
 */
export function buildFunctionMap(
  defs: Iterable<FormulaFunction> = [],
): Map<string, FormulaFunction> {
  const map = new Map<string, FormulaFunction>()
  for (const fn of BUILTIN_FORMULAS) {
    map.set(fn.name.toUpperCase(), fn)
    for (const alias of fn.aliases ?? []) {
      map.set(alias.toUpperCase(), fn)
    }
  }
  for (const fn of defs) {
    const keys = [fn.name, ...(fn.aliases ?? [])]
    if (keys.some((key) => isBuiltinName(key))) continue
    for (const key of keys) {
      map.set(key.toUpperCase(), fn)
    }
  }
  return map
}

/** The builtins-only environment; the default for every `solve` call. */
export const BUILTIN_ENV: FormulaEnv = { functions: buildFunctionMap() }

function arityMessage(fn: FormulaFunction): string {
  const plural = (n: number): string => `${n} argument${n === 1 ? '' : 's'}`
  if (fn.minArgs === fn.maxArgs) return `${fn.name} takes ${plural(fn.minArgs)}`
  if (fn.maxArgs === Infinity) return `${fn.name} takes at least ${plural(fn.minArgs)}`
  return `${fn.name} takes ${fn.minArgs} to ${plural(fn.maxArgs)}`
}

/** Resolve and invoke a function by name, case-insensitively. Eager functions
 * receive the values of their forced argument thunks; lazy ones receive the
 * thunks unchanged so they can choose not to evaluate branches at all. */
export function invokeFunction(
  name: string,
  argThunks: readonly CellValueThunk[],
  env: FormulaEnv,
): CellValue {
  const fn = env.functions.get(name.toUpperCase())
  if (!fn) {
    return err('#NAME?', `Unknown function "${name}"`)
  }
  // Every function declares its arity; a call outside it is a mistake in the
  // formula, not a call to answer: `ABS(1,2,3)` would otherwise quietly use
  // the 1, and a document function `G(a, b)` called as `G(1)` would read `b`
  // as blank.
  if (argThunks.length < fn.minArgs || argThunks.length > fn.maxArgs) {
    return err('#ERROR!', arityMessage(fn))
  }
  const ctx: EvalContext = { env }
  if (fn.lazy) {
    return fn.call(argThunks, ctx)
  }
  const args = argThunks.map((thunk) => thunk())
  return fn.call(args, ctx)
}

/** Eager wrapper over {@link invokeFunction}: forces every argument before
 * dispatch, so callers that already hold values (tests, the `applyFunction`
 * in the DSL) can invoke any function including the lazy conditionals. */
export function applyFunction(
  name: string,
  args: readonly CellValue[],
  env: FormulaEnv,
): CellValue {
  return invokeFunction(
    name,
    args.map((arg) => () => arg),
    env,
  )
}

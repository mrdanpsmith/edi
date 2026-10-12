/**
 * The Welcome document, opened in a tab on first run. The prose lives in
 * `src/docs/welcome.md` so it can be edited as markdown, and the builtin
 * function list is generated from the registry (`formulas.ts`) so it can never
 * drift from what the evaluator actually supports.
 */
import { BUILTIN_FORMULAS } from './formulas'
import welcomeMarkdown from './docs/welcome.md?raw'

/** Every builtin name as inline code, for the template's `{{BUILTIN_FUNCTIONS}}`. */
export const WELCOME_FUNCTIONS = BUILTIN_FORMULAS.map((fn) => `\`${fn.name}\``).join(', ')

export function buildWelcomeMarkdown(): string {
  return welcomeMarkdown.replace('{{BUILTIN_FUNCTIONS}}', WELCOME_FUNCTIONS)
}

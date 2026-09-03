export interface CodeResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when the run was stopped by the user mid-flight. */
  stopped?: boolean
}

/**
 * Reconstruct the full shebang line from remark-parse's `lang`/`meta` split.
 * For a fenced code block whose info string starts with `#!`, remark-parse
 * splits on the first space: `#!cmd` goes in `lang` and the rest in `meta`.
 * The whole first line is the shebang (e.g. `#!/usr/bin/env python3 -m x`), so
 * rejoin them with a single space. Returns null when `lang` is not a shebang.
 */
export function shebangFromFenceInfo(lang: string, meta: string): string | null {
  const trimmed = String(lang ?? '').trim()
  if (!trimmed.startsWith('#!')) return null
  const rest = String(meta ?? '').trim()
  return rest ? `${trimmed} ${rest}` : trimmed
}

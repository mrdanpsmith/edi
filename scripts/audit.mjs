/**
 * `npm run audit`: npm's audit at `high`, with one narrow escape hatch.
 *
 * - **Shipped dependencies have no exceptions.** Any high or critical advisory reachable
 *   from `dependencies` (the audit with `--omit=dev`) fails, allowlisted or not.
 * - **A dev-only advisory may be allowlisted** in `scripts/audit-allowlist.json`, by its
 *   GHSA id with a reason, when it has no patched release to move to. Everything else
 *   that is high or critical fails as `npm audit --audit-level=high` would.
 * - **An entry cannot go stale.**
 *   - When the package's latest release is outside the vulnerable range, a fix exists:
 *     the audit fails until the dependency is updated to it.
 *   - When its advisory is no longer reported (the fix is installed), the entry is
 *     **removed automatically**: a local run rewrites the allowlist and says so. CI does
 *     not write files it would throw away, so there the leftover entry fails the run.
 *   - Every entry carries a `reviewBy` date (`REVIEW_DAYS` after it was added or last
 *     reviewed). Past it the audit fails until someone re-evaluates the entry and moves
 *     the date, so an unpatched advisory is looked at again even if nothing changes.
 *
 * Needs network, like `npm audit` itself.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GATED = new Set(['high', 'critical'])
const ALLOWLIST_PATH = fileURLToPath(new URL('./audit-allowlist.json', import.meta.url))
/** How long an allowlist entry stands before it must be re-evaluated. */
export const REVIEW_DAYS = 90
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Problems with an entry's `reviewBy`, as of `today` (`YYYY-MM-DD`): missing, malformed,
 * further out than `REVIEW_DAYS`, or already past.
 */
export function reviewProblem(id, entry, today) {
  const by = entry?.reviewBy
  if (typeof by !== 'string' || !DATE.test(by)) {
    return `${id} needs a "reviewBy": "YYYY-MM-DD" at most ${REVIEW_DAYS} days out`
  }
  const days = (Date.parse(by) - Date.parse(today)) / 86_400_000
  if (days < 0) return `${id} was due for review on ${by}: re-evaluate it, then move "reviewBy" (at most ${REVIEW_DAYS} days out)`
  if (days > REVIEW_DAYS) return `${id} "reviewBy" ${by} is more than ${REVIEW_DAYS} days out`
  return null
}

function npm(args) {
  // npm is `npm.cmd` on Windows, which Node only spawns through a shell.
  const run = spawnSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32' })
  if (run.error) throw run.error
  return run
}

/** npm's audit report as JSON. `npm audit` exits non-zero whenever it finds anything. */
function audit(extra) {
  const run = npm(['audit', '--json', ...extra])
  let report
  try {
    report = JSON.parse(run.stdout)
  } catch {
    throw new Error(`npm audit ${extra.join(' ')} gave no report:\n${run.stderr || run.stdout}`)
  }
  if (report.error) throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`)
  return report
}

/** The gated advisories in a report, keyed by GHSA id: the root causes, not their dependents. */
function gatedAdvisories(report) {
  const found = new Map()
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      // A string names another vulnerable package; its own entry carries the advisory.
      if (typeof via !== 'object' || !GATED.has(via.severity)) continue
      const id = via.url?.match(/GHSA-[\w-]+/)?.[0] ?? `npm-${via.source}`
      found.set(id, { id, package: via.name, title: via.title, range: via.range, url: via.url })
    }
  }
  return found
}

/** `x.y.z` as numbers, or null for anything this does not compare (a prerelease, a tag). */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return m ? m.slice(1, 4).map(Number) : null
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Is `version` inside an advisory's vulnerable `range`? Advisory ranges are comparator
 * sets (`<=4.0.7`, `>=1.0.0 <1.2.3`, joined by `||`). Returns null when the range or
 * the version is not one of those, so the caller can fail closed rather than guess.
 */
export function inRange(version, range) {
  const v = parseVersion(version)
  if (v === null) return null
  if (range.trim() === '*') return true
  let any = false
  for (const set of range.split('||')) {
    let all = true
    for (const part of set.trim().split(/\s+/)) {
      const m = /^(<=|>=|<|>|=)?(.+)$/.exec(part)
      const bound = m ? parseVersion(m[2]) : null
      if (bound === null) return null
      const c = compare(v, bound)
      const op = m[1] ?? '='
      const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0
      all &&= ok
    }
    any ||= all
  }
  return any
}

function latestVersion(pkg) {
  const run = npm(['view', pkg, 'version'])
  if (run.status !== 0) throw new Error(`npm view ${pkg} version failed:\n${run.stderr}`)
  return run.stdout.trim()
}

function main() {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  const all = gatedAdvisories(audit([]))
  const shipped = gatedAdvisories(audit(['--omit=dev']))
  const failures = []
  const allowed = []

  for (const adv of shipped.values()) {
    failures.push(`${adv.id} (${adv.package} ${adv.range}) reaches a shipped dependency; no exceptions: ${adv.title}`)
  }

  const today = new Date().toISOString().slice(0, 10)
  for (const adv of all.values()) {
    if (shipped.has(adv.id)) continue
    const entry = allowlist[adv.id]
    if (!entry) {
      failures.push(`${adv.id} (${adv.package} ${adv.range}): ${adv.title} ${adv.url ?? ''}`)
      continue
    }
    const review = reviewProblem(adv.id, entry, today)
    if (review !== null) failures.push(review)
    const latest = latestVersion(adv.package)
    const vulnerable = inRange(latest, adv.range)
    if (vulnerable === null) {
      failures.push(`${adv.id}: cannot tell whether ${adv.package}@${latest} is inside "${adv.range}"; check by hand`)
    } else if (!vulnerable) {
      failures.push(`${adv.id}: ${adv.package}@${latest} is patched; update to it and remove the allowlist entry`)
    } else {
      allowed.push(`${adv.id} (${adv.package} ${adv.range}, latest ${latest}): ${entry.reason}`)
    }
  }

  const resolved = Object.keys(allowlist).filter((id) => !all.has(id))
  for (const id of Object.keys(allowlist)) {
    if (shipped.has(id)) failures.push(`${id} is allowlisted but reaches a shipped dependency`)
  }
  if (resolved.length > 0) {
    if (process.env.CI) {
      for (const id of resolved) {
        failures.push(`${id} is allowlisted but no longer reported; run \`npm run audit\` locally to remove it`)
      }
    } else {
      for (const id of resolved) delete allowlist[id]
      writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`)
      for (const id of resolved) console.log(`removed from the allowlist (no longer reported): ${id}`)
    }
  }

  for (const line of allowed) console.log(`allowed (dev-only, unpatched): ${line}`)
  if (failures.length > 0) {
    for (const line of failures) console.error(`FAIL ${line}`)
    process.exit(1)
  }
  console.log(`npm audit: no high or critical advisories outside the dev-only allowlist (${allowed.length} allowed).`)
}

// Run as a script; importing it (to check `inRange`) runs nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

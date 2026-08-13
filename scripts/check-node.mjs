/**
 * Fails fast with a clear message when the installed Node is too old for the
 * toolchain (vite 8 / rolldown require `^20.19.0 || >=22.12.0`).
 *
 * Without this check, older Node versions die with a confusing
 * `node:util does not provide an export named 'styleText'` syntax error.
 */

const REQUIRED = '^20.19.0 || >=22.12.0'

const [major, minor] = process.versions.node.split('.').map(Number)
const ok =
  (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22

if (!ok) {
  console.error(
    `Edi requires Node ${REQUIRED} (vite 8 / rolldown). You are running Node ${process.version}.`
  )
  console.error('Upgrade Node, then rerun the build.')
  process.exit(1)
}

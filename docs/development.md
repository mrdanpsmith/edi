# Development

## Setup

Requirements: Python 3.10+ with `venv`, Node.js 20.19+ (or 22.12+), and a
desktop session for running the real app. Tests can run headlessly.

```sh
./scripts/install-deps.sh
```

This creates `.venv/` from `requirements-dev.txt` and `requirements-build.txt`
(PySide6, the test/static-analysis tools and PyInstaller), installs the npm
dependencies, generates the app icon and installs the versioned git hooks.

Build the frontend and start the Python shell:

```sh
npm run build
.venv/bin/python run_edi.py
```

`npm run dev` starts only the Vite server. It is useful for frontend work, but
it is not the app.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Typecheck, ESLint, frontend unit tests and the duplicate-code scan. The local full frontend gate. |
| `npm run build` | Node version check, `tsc --noEmit`, Vite build into `dist/`. |
| `npm run coverage` | Frontend tests with the Cobertura and HTML coverage reports. |
| `npm run dupcheck` | `jscpd .` at the 5% threshold in `.jscpd.json`. It scans Python and scripts too, not just `src/`. |
| `npm run audit` | `npm audit --audit-level=high` (needs network). Clean; the Vitest toolchain is pinned to patched 4.1.11, so do not drift below it. |
| `.venv/bin/pytest tests/` | Python tests (needs `dist/`; see below). |
| `./scripts/version.sh check` | Version agreement plus the Python-pin guard (pins only in `requirements*.txt`). |

### Static analysis

Both checks run in the CI `test` job and locally:

```sh
.venv/bin/bandit -c pyproject.toml -r backend \
  scripts/color-scheme-probe.py scripts/dark-mode-forensics.py \
  run_edi.py -q

.venv/bin/pip-audit -r requirements.txt
```

Bandit gates on **every** finding at any severity. `[tool.bandit] skips =
["B404"]` suppresses only the generic "consider importing subprocess" advisory.
The real call sites stay gated by B603/B607. The deliberate uses are
allow-listed code-block execution (`exec.py`), `gsettings get` and `xdg-open`
(both resolved via `shutil.which` to absolute paths). They are marked with a
bare `# nosec B603` on the call line and a rationale comment just above. Do not
append words after the test ID; bandit warns on every token.

`pip-audit` audits the app's declared dependencies, not the venv's own `pip`
(the venv's stale pip 25.x has CVEs that would otherwise be false alarms).

## Tests

`npm run check` is the frontend gate. `pytest tests/` is the backend gate and
also reports coverage from `pyproject.toml`'s `addopts`:

- terminal summary;
- `coverage-py/cobertura-coverage.xml`;
- browsable HTML at `coverage-py/html/index.html`.

`tests/window/test_window.py` is the real-WebEngine suite. It needs `dist/` and fails
fast with a clear message if the frontend has not been built. The shared
WebEngine helpers live in `tests/mermaid_render.py`, which is not named
`test_*.py` so pytest does not collect it. `QTest` mouse injection never
reaches the page; those tests dispatch JavaScript-synthesised `PointerEvent`s.

## Local CI and the pre-push hook

`./scripts/simulate-ci-test.sh [--pytest-only] [--rebuild-image]` reproduces
the CI `test` job inside the `edi-builder:jammy` image (built from
`Dockerfile.ci` on demand). It runs the Python 3.10 `compileall` check, `npm
ci`, lint, typecheck, dupcheck, frontend coverage, `npm run build`, bandit,
`/opt/edi/venv/bin/pytest tests/` and the network audits.

Use it before pushing. It catches two classes of failure that a host Python
3.14 venv can hide: Python 3.10 syntax gates and tests that depend on
`gsettings`/dconf/GNOME state the container does not have. It runs as your uid,
calls the baked venv directly (do not symlink it over `.venv`), and points
`XDG_CONFIG_HOME`/`NPM_CONFIG_CACHE` at gitignored directories.

A stale local image — built before a tool such as bandit or pip-audit was baked
into `/opt/edi/venv` — otherwise fails mid-run with a cryptic "No such file or
directory". The script preflights the baked venv for exactly the tools its
steps reference and rebuilds on demand; the Docker layer cache keeps that a
no-op when `Dockerfile.ci` is current.

`scripts/install-hooks.sh` points `core.hooksPath` at the versioned
`.githooks/` directory; git hooks in `.git/hooks` are not shared between
clones. `install-deps.sh` runs it.

The `pre-push` hook runs the full simulation, including for tag pushes, which
is when the release pipeline runs. Skip it once with `git push --no-verify` or
`SKIP_CI_SIM=1`; without Docker it warns and lets the push through, and CI
still runs the gate.

## Testing quirks

### Headless Qt

Qt must run offscreen:

```sh
QT_QPA_PLATFORM=offscreen
QTWEBENGINE_DISABLE_SANDBOX=1
QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu"
```

`tests/conftest.py` sets all three with `os.environ.setdefault` *before*
importing PySide6. Never import PySide6 before those variables are set. A
local run without `--disable-gpu` (macOS especially) keeps losing its GPU
context and segfaults partway through the real-WebEngine tests.

QtWebEngine also segfaults at interpreter exit in headless/container pytest
runs: the tests pass, then the job fails with exit 139. `tests/conftest.py`'s
`pytest_sessionfinish` registers an `atexit` handler that calls `os._exit` with
pytest's real status and skips Qt teardown. Keep it registered only at session
end, not at import, so a real crash mid-run still propagates as a signal.

Run pytest from the repository root. `pyproject.toml` sets `pythonpath=["."]`,
so running it elsewhere breaks `import backend`.

### QtWebEngine does not await promises

`runJavaScript` does not await Promises. The packaged-binary smoke test
(`EDI_SELFTEST=1`, offscreen) therefore probes a synchronous
`window.__selftest` snapshot, prints one `SELFTEST {...}` line after the page
loads and exits 0. The probe is fired from `loadFinished`, never a fixed
timer: a `runJavaScript` issued while the page is still navigating runs in the
outgoing document, and its snapshot is discarded when the real page commits.
A slow first load (a large bundle on a cold QtWebEngine) made the old
fixed-delay probe flaky.

The app boots a home screen (`#app[data-view='home']`) rather than a welcome
tab. The smoke loads the page with `?selftest=1` (the backend adds the query
when `EDI_SELFTEST=1`), and `init` in `src/main.ts` opens the Welcome document
so `__selftest.title` still reads `Untitled — Edi`.

A 45-second watchdog prints `SELFTEST_TIMEOUT` and exits 1. The smoke uses
`os._exit` to skip Qt teardown (a wedged renderer can otherwise hang the
process and swallow output) and must not depend on async values or the bridge
being ready.

When `EDI_SELFTEST_OUT` names a file, the verdict is always written there
before any stdout is attempted. The windowed Windows build needs it because
`console=False` makes Python's `sys.stdout` `None`; the macOS build uses it
because a windowed `.app` launched by CI is not a reliable stdout gate. The
Windows script polls that file instead of using a fixed wait (three-minute
budget, `EDI_SMOKE_BUDGET_MIN` overrides). The macOS script bounds the run,
prints the captured app log and the verdict on failure, and treats a missing
`SELFTEST` verdict as an error. The Windows build details are in
[distribution.md](distribution.md).

### No temp extraction

Every build is a onedir bundle, so nothing is unpacked at launch and the smoke
tests need no `TMPDIR` redirection (see
[distribution.md](distribution.md#onedir-on-every-platform)). The old
onefile failures — `decompression resulted in return code -1` (temp space ran
out) and `Could not create temporary directory!` — cannot occur any more; if
one appears, a build has gone back to onefile.

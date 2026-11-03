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
| `npm run build` | Node version check, `tsc --noEmit`, Vite build of the app into `dist/`. This is what ships. |
| `npm run build:harness` | Adds the window-test harness, `dist/harness.js` (`tests/harness/index.ts`), to an existing `dist/`. Test-only. |
| `npm run build:test` | `build` then `build:harness`: everything `pytest tests/` needs. |
| `npm run coverage` | Frontend unit tests with the Cobertura and HTML coverage reports. |
| `npm run test:browser` | Browser-mode tests in headless Chromium (see [Browser tests](#browser-tests)). Not part of `npm run check`. |
| `npm run dupcheck` | `jscpd .` at the 5% threshold in `.jscpd.json`. It scans Python and scripts too, not just `src/`. |
| `npm run audit` | `npm audit --audit-level=high` (needs network). Clean; the Vitest toolchain is pinned to patched 4.1.11, so do not drift below it. `package.json` `overrides` forces `minimatch ^11.0.3` (GHSA-g3hv-75wg-m249) under ESLint, whose releases still ask for `^10`; drop it once they don't. |
| `.venv/bin/pytest tests/` | Python tests (needs `npm run build:test`; see below). |
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

`tests/window/test_window.py` is the real-WebEngine suite. It needs `dist/` and
the harness the tests inject into the page, `dist/harness.js`; `npm run
build:test` builds both, and the suite fails fast with a clear message if
either is missing. `npm run build` alone does not build the harness: it is
test code, so it stays out of the `edi-web` artifact the releases are packaged
from and out of the Docker images. CI builds it inside the `test` jobs. The shared
WebEngine helpers live in `tests/mermaid_render.py`, which is not named
`test_*.py` so pytest does not collect it. `QTest` mouse injection never
reaches the page; those tests dispatch JavaScript-synthesised `PointerEvent`s.

## Browser tests

There are three tiers of tests, from cheapest to most faithful:

| Tier | Where | Runs in | Use it for |
| --- | --- | --- | --- |
| Unit | `src/**/*.test.ts` | Vitest + jsdom (`unit` project) | Logic, document transforms, anything without layout. |
| Browser | `tests/browser/*.browser.test.ts` | Vitest browser mode, headless Chromium via Playwright (`browser` project) | Frontend behaviour that needs real layout or input: hit tests (`posAtCoords`), geometry, Mermaid/kanban drawing, real mouse buttons and keys. |
| Window | `tests/window/` | pytest + real QtWebEngine | Anything that needs the Python shell: the bridge, menus, dialogs, file IO, preferences, QtWebEngine-specific behaviour. |

Prefer the cheapest tier that can observe the behaviour. jsdom has no layout,
which is why `src/test-setup.ts` stubs `elementFromPoint`, `scrollIntoView`
and `ResizeObserver`; a test that needs those to be real belongs in the browser
tier, not in `test_window.py`.

`install-deps.sh` downloads the browser. After a Playwright upgrade, or on a
checkout set up before this existed, fetch it again:

```sh
npx playwright install --only-shell chromium   # once per Playwright version
npm run test:browser
```

`tests/browser/app.ts` boots the real page: the `index.html` shell markup,
the shipped stylesheets and `init` from `src/main.ts`. Only Python is
replaced. It sets `window.bridge` to a fake before `init` runs, so
`src/bridge.ts` uses it instead of opening a QWebChannel. Use it like this:

```ts
let app: BootedApp
beforeEach(async () => {
  app = bootApp()
  await app.setDocument('See [the site](https://example.com/) now')
})
afterEach(() => app.dispose())

it('opens a link on click', async () => {
  await userEvent.click(app.editor.querySelector('a')!)   // trusted input
  await waitFor(() => app.bridge.callsTo('openUrl').length > 0)
})
```

- `app.bridge.calls` / `callsTo(method)` record every bridge call.
  `answer(method, handler)` changes a reply (`confirm` answers `true`, and the
  list-returning methods `[]`, by default). `notify(event)` pushes a shell
  event.
- `app.markdown()` serialises the live ProseMirror document (`app.doc()`),
  `app.menu(command, argument)` runs a menu command the way the shell's menu
  bar does, and `bootApp({ preferences })` injects the preference snapshot the
  shell would (for example `{ hoverBand: false }` or `{ zoomFactor: 1.5 }`).
- `userEvent` and `page` come from `vitest/browser`. They drive Playwright, so
  the events are trusted, unlike the JavaScript-synthesised ones the window
  tests have to use.
- `pointer` is for input that is about *where*: `press(at, { button,
  modifiers: ['Alt'] })`, `move`, `wheel`, and a drag that can be inspected
  before it lands (`startDrag`, `dragTo`, `release`). Read coordinates with
  `getBoundingClientRect` or `center(element)`. It is backed by the `input`
  command in `tests/browser/commands.ts`, which runs Playwright's
  `page.mouse`/`page.keyboard` on the Node side and translates the test
  iframe's coordinates into page coordinates.
- `settle()` waits two frames and a short timer after input, like the window
  suite's `_settle`; `waitFor(condition)` polls a condition every frame.
  Never use fixed sleeps.
- Each test file runs in its own iframe, so files are isolated; `bootApp`
  resets app state and the bridge record for each test.
- Test configuration lives in `vitest.config.ts`, which merges in
  `vite.config.ts`. Keep test code and test-only imports out of
  `vite.config.ts`: `vite build` loads it, and the Docker frontend stages copy
  only the build's inputs, so a test import there breaks the image build.
- The viewport is 1280×900 (`vitest.config.ts`), not Vitest's phone-sized
  default. A failure saves a screenshot in a `__screenshots__`
  folder beside the test file (gitignored; it only exists after a failure).
- `npm run coverage` covers only the unit tier.

Playwright's Chromium is newer than QtWebEngine's. Keep a test in the window
suite when it depends on engine-specific behaviour, not just on layout.

## Local CI and the pre-push hook

`./scripts/simulate-ci-test.sh [--pytest-only] [--rebuild-image]` reproduces
the CI `test` job inside the `edi-builder:jammy` image (built from
`Dockerfile.ci` on demand). It runs the Python 3.10 `compileall` check, `npm
ci`, lint, typecheck, dupcheck, frontend coverage, the browser tests (against
the image's baked Chromium), `npm run build:test`, bandit,
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

### Tests never touch your real settings

`tests/conftest.py` points every `QSettings()` the tests create at INI files in
a throwaway directory (`QSettings.setDefaultFormat(IniFormat)` plus
`QSettings.setPath`), removed at the end of the run.
`QStandardPaths.setTestModeEnabled(True)` alone is not enough: it redirects the
INI files Linux uses, but not the macOS plist
(`~/Library/Preferences/com.edi.Edi.plist`) or the Windows registry, which are
`QSettings`' native formats there. Without the redirect, a local run on macOS
emptied the developer's recent documents and left the fixtures' `/docs/a.md`
in their place. Keep both, and keep them ahead of any PySide6 import.

### QtWebEngine does not await promises

`runJavaScript` does not await Promises. The packaged-binary smoke test
(`EDI_SELFTEST=1`, offscreen) therefore probes a synchronous
`window.__selftest` snapshot, prints one `SELFTEST {...}` line after the page
loads and exits 0. The probe is fired from `loadFinished`, never a fixed
timer: a `runJavaScript` issued while the page is still navigating runs in the
outgoing document, and its snapshot is discarded when the real page commits.
A slow first load (a large bundle on a cold QtWebEngine) made the old
fixed-delay probe flaky.

### Waiting in the real-WebEngine tests

Never `time.sleep` in a WebEngine test. Qt delivers nothing while Python sleeps,
so a `runJavaScript` answer sits queued, and the renderer (a separate process)
keeps running on its own clock, so a fixed sleep is not the wait it looks like.
The helpers in `tests/mermaid_render.py`:

- `_wait` / `_pump_until`: wait for a condition. Use them whenever a condition
  exists. They block on the Qt event loop, so a page answer ends the wait at once.
- `_settle(win)`: wait until the page has run what the last input queued behind
  it (two animation frames, then a 50ms page timer). Use it after a press, a
  selection change or `ediSetContent`, when the next step is a read.
- `_pump_for(seconds)`: keep the event loop running for a fixed time. Use it
  only when the claim is that something must *not* happen, or before a
  `grab()` screenshot.

The window tests share one window, so page state carries over between tests.
One leak is handled by an autouse fixture in `tests/window/conftest.py`:
ProseMirror counts clicks itself, so a mousedown within 500ms and 10px of the
previous one is a double click and skips `handleClick` (the gap cursor among
others). The fixture moves the page's `Date.now()` forward a second before
each test, so the previous test's last press can never become half of a
double click.

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

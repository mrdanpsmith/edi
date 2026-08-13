# AGENTS.md

Edi is a markdown editor. Frontend: CodeMirror 6 + Mermaid + spreadsheet formulas (TypeScript/Vite) compiled to a static `dist/`. Backend: Python 3 + PySide6/QtWebEngine. A native `QWebEngineView` hosts `dist/index.html`; the page talks to Python via `QWebChannel` (`backend/bridge.py`). This is NOT a plain web app — `npm run dev` runs only the Vite server; the real app is Python.

## Key commands

- `npm run check` — typecheck + eslint + frontend unit tests (Vitest). Run this before backend work.
- `npm run build` — node version check + `tsc --noEmit` + Vite build into `dist/`.
- `.venv/bin/pytest tests/` — backend tests. **Requires `dist/` to exist first** (run `npm run build`); `tests/test_window.py` fails fast with a clear message otherwise.
- `./scripts/install-deps.sh` — one-time setup: `.venv/` (PySide6) + `npm install` + generates `scripts/assets/app-icon.png` via `node scripts/generate-icon.mjs`.
- `./scripts/build-pyzip.sh` — builds `dist-app/edi` (single-file binary) inside an Ubuntu 22.04 Docker container, smoke-tested offscreen.

## Testing quirks

- Qt must run offscreen headlessly: `QT_QPA_PLATFORM=offscreen` + `QTWEBENGINE_DISABLE_SANDBOX=1`. `tests/conftest.py` sets these via `os.environ.setdefault` *before* importing PySide6 — never import PySide6 before the env is set.
- QtWebEngine `runJavaScript` does **not** await Promises. The packaged-binary smoke test (`EDI_SELFTEST=1`, offscreen) probes sync JS snapshots (`window.__selftest`) and, once the page finishes loading, prints one `SELFTEST {...}` line and exits 0. A 25s watchdog prints `SELFTEST_TIMEOUT` and exits 1. It uses `os._exit` to skip Qt teardown (a wedged renderer can otherwise hang the process and swallow output) and must not depend on async values or the bridge being ready.
- `pyproject.toml` sets `pythonpath=["."]`, so run pytest from the repo root; running it elsewhere breaks `import backend`.
- QtWebEngine segfaults at interpreter exit in headless/container pytest runs (tests pass, job fails with exit 139). `tests/conftest.py` `pytest_sessionfinish` registers an `atexit` `os._exit` that passes pytest's real exit status and skips Qt teardown. Keep the handler registered only at session end, not at import, so real crashes mid-run still propagate as signals.

## Distribution (hard-won constraints — do not break)

- The shipped binary MUST be built on **Ubuntu 22.04 (glibc 2.35)** so it runs on older desktop Linux. `scripts/build-pyzip.sh` pins everything inside Docker for this; host-built binaries are not portable and must not be shipped.
- **`libstdc++.so.6` must never be bundled** (`edi.spec` filters it out). Bundling the 22.04 copy crashes on newer host Mesa/LLVM drivers with `GLIBCXX_3.4.32 not found`.
- The app icon (`scripts/assets/app-icon.png`) is generated from `scripts/generate-icon.mjs` and bundled via `edi.spec` `datas`. `backend/window.py` `load_app_icon()` guards `sys._MEIPASS` (built binary vs. source run) — keep that guard. The about-dialog logo (`assets/edi-logo.png`) is bundled the same way (`_find_logo()` falls back to the app icon).
- `PySide6==6.11.1` and other pins live in `requirements.txt`; keep PySide6 pinned (Qt releases break the WebEngine hooks).

## CI (`.gitlab-ci.yml`)

- Coverage report must be **cobertura** (`coverage_format: cobertura`); GitLab rejects lcov.
- QtWebEngine hangs in containers with small `/dev/shm` / no GPU: set `QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu"` (and `QTWEBENGINE_DISABLE_SANDBOX=1`) for any headless Qt run.
- The `test` job must run `npm run build` before `pytest` (backend tests load `dist/index.html`).
- `before_script` installs ~30 Qt runtime libs + Node 22 static tarball (needs `curl xz-utils ca-certificates`) into a fresh ubuntu:22.04 image; CI deps live only there, not on the host.
- `release` job publishes via `glab` on `v*` tags, authenticated by CI auto-login with the built-in `CI_JOB_TOKEN` (JOB-TOKEN header). Do NOT set `GITLAB_TOKEN=$CI_JOB_TOKEN`: glab sends it as PRIVATE-TOKEN, which the Releases API rejects with 404. Requires the project setting "Allow CI job token to create releases" enabled.
- Linux dock/taskbar icon comes from a `.desktop` file (not the window icon), so the bare binary shows a generic gear without one. `scripts/install-desktop.sh` installs `~/.local/share/icons/hicolor/512x512/apps/edi.png` + `~/.local/share/applications/edi.desktop` (template `scripts/assets/edi.desktop`, `Exec` substituted); `app.setDesktopFileName("edi")` in `backend/main.py` hints the WM to match it.

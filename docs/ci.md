# CI

The workflows live in `.github/workflows/`:

- **`ci.yml` (name `CI`)** is the normal commit pipeline. It runs on every
  `pull_request` and on every push to `main` or `release/**` branches, and runs
  only the testing phases (`frontend` + `test`), never binaries or releases.
- **`release.yml` (name `Release`)** is the full tag-gated DAG. It runs on `v*`
  tags or manual `workflow_dispatch` (`VER` defaults to `0.0.0`) and adds the
  platform builds, packaging and publishing.
- **`images.yml`** builds the builder images.
- **`mermaid-probe.yml`** runs `scripts/mermaid-label-probe.py` when Mermaid,
  its editing layer or the lockfile changes (see below).

The `frontend`/`test` job bodies are **deliberately mirrored** across `ci.yml`
and `release.yml`, so each pipeline stays self-contained. That is why
`.jscpd.json` ignores `**/.github/workflows/**`.

`concurrency: ci-${{ github.ref }}` covers both events on purpose. A PR's
`github.ref` is `refs/pull/N/merge`, so a new push cancels the superseded run
without colliding with the `refs/heads/main` group, and a merge still runs the
push job.

## Quality gate

The gate is split over two jobs in both pipelines:

- **`frontend`** runs lint, typecheck, dupcheck and the production build. It
  produces `dist/` plus the `.ico`/`.icns` icons.
- **`test`** runs Vitest coverage, bandit, pytest and the coverage uploads,
  then the network audits (`npm run audit`, `.venv/bin/pip-audit -r
  requirements.txt`) last, so a transient network failure does not burn the
  deterministic gate.

Keep `npm run check` as the local full frontend gate.

`test` also runs `./scripts/version.sh check`, which verifies that the version
declarations agree and that PySide6/PyInstaller pins appear only in
`requirements*.txt`.

`test` needs `dist/` because the backend tests load `dist/index.html`. The
`frontend` job builds it and `test` downloads the artifact.

QtWebEngine hangs in containers with a small `/dev/shm` or no GPU. The
workflows set:

```sh
QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu"
QTWEBENGINE_DISABLE_SANDBOX=1
```

for every headless Qt run.

## Mermaid label probe

`mermaid-probe.yml` is path-filtered to `package.json`, `package-lock.json`,
`src/mermaid-*.ts`, `src/node/mermaid.ts`, the probe script, its fixtures and
`tests/mermaid_render.py`. It builds `dist/` and runs the full
`scripts/mermaid-label-probe.py` in the builder image, so a Mermaid upgrade
that changes SVG markup or grammar fails before merge instead of in a manual
regression hunt.

`mermaid` is pinned exactly in `package.json`; upgrades arrive as a deliberate
commit that changes the lockfile and therefore triggers this job.

## Coverage reports

Coverage stays **Cobertura**, and the paths are load-bearing:

- `npm run coverage` → `coverage/cobertura-coverage.xml` (Vitest v8);
- pytest → `coverage-py/cobertura-coverage.xml` (pytest-cov 7 has no
  `cobertura` reporter; `xml:...` output is Cobertura).

Each side also writes an HTML report to a sibling `index.html`: `coverage/`
and `coverage-py/html`. pytest-cov's `html:...` is pinned under `coverage-py/`
so the whole thing is one gitignored tree. The `test` job uploads `coverage/`
and `coverage-py/` wholesale as the `coverage-report` artifact
(`retention-days: 30`, `if-no-files-found: error`, default branch only).

The artifact ships the directories rather than the two XML paths because the
badges job reads both Cobertura files out of the same download. One upload
serves both consumers, and the HTML report needs the directories anyway.

The frontend denominator is **every `src/**` file**. Vitest 4 removed
`coverage.all`; the v8 provider globs `coverage.include` after a full run and
reports files it never loaded at 0%. Do not "fix" that with `all: true`; the
key is gone and the setting is inert.

Two consequences of the same path:

- a single-file re-run skips the report (`cleanOnRerun`), so `npm run
  coverage` is the report that counts;
- `src/test-setup.ts` is missing by accident rather than by rule (the runner
  loads it uninstrumented, so it is in neither bucket). Keep
  `coverage.exclude` unset; replacing the default list would pull all the
  `*.test.ts` files into the report.

## GitHub's coverage dashboard

GitHub's built-in coverage dashboard is **not available to this repository**,
and its upload steps are deliberately absent. `actions/upload-code-coverage@v1`
worked as documented but returned:

```text
Coverage upload failed (HTTP 404)
```

GitHub Code Quality is a paid product (GitHub Team and Enterprise Cloud). A
Free/Pro personal repository is not eligible, so there is no Settings →
Security → Code quality page, the API endpoint does not exist for this repo,
and every upload is a permanent 404. Do not re-add the two steps, the
`permissions: code-quality: write`, or their `if:` condition: the only fix is
moving the repository into an organisation on a paid plan, and 404 is the
expected result of not having done that.

What replaced them is plan-independent: the `Publish coverage summary` job
summary and the README badges.

If the repository ever moves to a paid plan, the shape is two steps (one per
language, with `file`/`language`/`label`) plus the job-level permission. The
`pull_request` trigger that `ci.yml` already has puts a PR's numbers on its
head SHA rather than the merge commit.

## Coverage badges

The README row is fed from a dedicated **`badges` branch**. The `badges` job in
`ci.yml`:

1. reads both `line-rate`s;
2. writes `coverage-ts.json` / `coverage-py.json` with
   `{schemaVersion, label, message, color}`;
3. force-pushes them.

The `color` field is what turns a badge red on its own below 90/80/70%. The
README points shields.io at the raw files with `/endpoint`.

Use **`/endpoint`**, not `/badge/dynamic/json`. Both take a `url` and the job
writes the same document, but `dynamic/json` requires a second `query`
(JSONPath selector) and returns only the message; its label and colour come
only from the badge URL's query string. Omitting `query` renders shields'
`invalid query parameter: query`; supplying it stops the coverage badges from
changing colour on their own. `/endpoint` takes `url` alone and reads label
and colour from the document, which is why the `color` field is worth writing.

Four decisions are load-bearing:

- the branch is **one force-pushed commit with no history** — it is data, not
  history, so a re-run cannot conflict with itself;
- publishing is **its own job**, so `contents: write` never sits in `test`,
  which runs the test suite. The reports cross the boundary as the
  `coverage-report` artifact, which is also why the job needs neither the
  builder image nor Node;
- the job's `if:` is **default branch only**, the same condition as the
  artifact step that feeds it. A badge should read main, and a fork PR's token
  is read-only anyway;
- the job exists in **`ci.yml` only**. That is the one deliberate divergence
  from the mirrored `test` bodies: a tag or `workflow_dispatch` run has no
  branch to publish a baseline for, so `release.yml` carries a pointer comment
  instead.

`raw.githubusercontent.com` and shields both cache, so a badge can trail the
newest run by a few minutes.

The license badge is static (`GPL--3.0--or--later`) rather than the
auto-detected `github/license` badge. The auto badge reads the plain GPLv3
`LICENSE` text, which is byte-identical for `-only` and `-or-later`, and would
contradict the README's "GPLv3 (or later)".

## Builder image

Most jobs run inside a prebuilt builder image,
`ghcr.io/<owner>/edi-builder:jammy`, built from `Dockerfile.ci` by
`images.yml`. It is rebuilt on `main` when `Dockerfile.ci`, a
`requirements*.txt` file or `.github/workflows/images.yml` changes, never on
tags, and manually via `workflow_dispatch`. Run it once manually after a fresh
import so ghcr has the images.

The image bakes the Qt runtime libraries, Node 22 and a venv at
`/opt/edi/venv` built from `requirements-dev.txt` and
`requirements-build.txt`. Jobs use it as a `container:` and link the venv with
`ln -s /opt/edi/venv .venv` (`package-linux.sh` hardcodes `$ROOT/.venv`), and
run `npm ci` where needed.

The `build-windows` job uses none of this: it runs on a GitHub-hosted
`windows-2025` runner and installs its own venv, so it needs neither image.

**Never pip-install into the baked venvs at job time.** They are read-only
image layers; bake changes into the images.

`images.yml` must use a `docker-container` buildx driver: the default `docker`
driver errors with "Cache export is not supported for the docker driver" on
`--cache-to type=registry`. It must also pass `-f Dockerfile.ci` explicitly.
The repository root has a plain `Dockerfile` (the app container image: Node
frontend stage plus `ubuntu:26.04` runtime), which buildx would otherwise
build by default, producing a node-less image with the venv at `/app/.venv`
instead of `/opt/edi/venv`.

Jobs pull the ghcr images as **public packages**, so no auth is needed and
fork runs do not fail on registry access.

## npm caching

`actions/setup-node` uses `cache: npm` in the frontend job only. Never cache
`node_modules/` or `.venv/`: they exceed GitHub's cache cap and caused misses,
and `npm ci` deletes `node_modules` anyway.

No binary job needs Node. All three consume the `edi-web` artifact, including
macOS.

## Binary jobs and release DAG

Binary jobs are gated to `v*` tags or manual `workflow_dispatch`. `VER` falls
back to `0.0.0` for validation runs.

- `build-linux` runs in the jammy container (the glibc 2.35 pin).
- `build-windows` runs natively on a GitHub-hosted `windows-2025` runner
  (45-minute timeout, `needs: frontend`). The runners are pre-warmed (measured
  at about 4 seconds to provision), so VM spin-up is not a concern; the job
  consumes the `edi-web` artifact and needs no Node.
- `build-macos` runs on a free arm64 `macos-15` runner.

A PyInstaller or macOS regression therefore surfaces only on a tag or a manual
run.

The release DAG:

1. `frontend` → `test` (dist artifact).
2. `frontend` → `build-linux`, `build-windows`, `build-macos` in parallel. All
   three consume the one `edi-web` artifact and none recompiles the frontend.
   The `.deb`/`.rpm`/`.AppImage`/`.exe`/`.app` all ship the same `dist/` that
   `test` validated.
3. `package-linux` (`needs: build-linux`) wraps the onefile and never
   recompiles.
4. `release` (`needs: [test, package-linux, build-windows, build-macos]`).
   `test` is in that list because a gate nothing waits on is not a gate; it
   used to run beside the builds with its result discarded, so a red pytest
   still published binaries.

Artifact downloads are scoped by name to exactly what each job consumes. Each
build job pulls only the small `edi-web` artifact, never the onefile. `release`
pulls only the packaged files, the `.exe`, the `.dmg` and the arm64
`.zip`/`.sha256`, and stages `install.sh` from the checkout.

`release` publishes with `gh release create <tag> file...` on `v*` tags,
authenticated by the runner's `GITHUB_TOKEN` (job permission
`contents: write`). It refuses to run if `$GITHUB_REF_NAME != v$(version.sh
current)`. See [releasing.md](releasing.md) for versioning and changelog rules.

**Do not glob `dist-app/...` in the release job.** `upload-artifact` v4
flattens wildcard uploads (paths are preserved only "after the first
wildcard"; multi-path wildcard uploads root at their LCA), so artifacts unzip
flat at the artifact root, and the Windows/macOS files lose their `Edi-`
prefix. The job downloads all three artifacts into `artifacts/` and uses
`find` to enumerate them, failing loudly if none landed.

The Windows job uploads `dist-app/Edi-*.exe` as `edi-win`. The selftest console
twin is deleted before the upload, so the glob ships exactly the versioned
onefile and the installer.

# Releasing

## Versioning

The version is tracked in three places:

- `package.json`;
- `package-lock.json`;
- `backend/__init__.py`.

`scripts/version.sh` keeps them in step:

```sh
./scripts/version.sh current      # print the current version
./scripts/version.sh set 0.2.0    # set an explicit version
./scripts/version.sh set 1.3.0-rc.1  # start a release candidate
./scripts/version.sh bump patch   # or minor / major
./scripts/version.sh bump rc      # the next candidate: 1.3.0-rc.1 -> 1.3.0-rc.2
./scripts/version.sh check        # verify all declarations agree
./scripts/version.sh tag          # create annotated tag v<current-version>
./scripts/version.sh tag --move   # move that tag to HEAD, if not pushed yet
```

`tag --move` is for a fix that lands after tagging but before the tag is
pushed. It asks every configured remote first, and refuses if any of them has
the tag or cannot be reached: a pushed tag has started a release, so the fix
needs a new version instead.

`set` and `bump` update all three files, stage them and commit with:

```text
Bump version to <version> [skip changelog]
```

Pass `--no-commit` to leave the changes uncommitted; the script prints the
`git add`/`git commit` commands.

Pushing the `vX.Y.Z` tag starts the release. The `release` job refuses to run
if the tag does not match the declared version.

## Release process

1. Make sure `main` is green and the working tree is clean.
2. Bump the version and push the commit.
3. Push the tag.
4. `release.yml` runs the full quality gate, builds every platform, packages
   Linux, and publishes the artifacts.

The release artifacts are:

- Linux: `.deb`, `.rpm`, `.tar.gz`, `.AppImage`;
- Windows: NSIS setup `.exe` and the portable `.zip`;
- macOS: `.dmg`, arm64 `.zip` and `.sha256`;
- `install.sh`, the macOS curl installer.

The `release` job stages `install.sh` from the checkout with
`cp install.sh artifacts/install.sh`, which is what puts it at
`releases/latest/download/install.sh`. An installer change is not live until a
release is published.

See [ci.md](ci.md) for the job DAG and artifact handling.

## Release candidates

A release candidate is `X.Y.Z-rc.N`, N from 1, and nothing else:
`version.sh`, the platform build scripts and `install.sh` all refuse any other
suffix. It goes through the same steps as a release:

1. `./scripts/version.sh set 1.3.0-rc.1`, then `tag` and push the tag.
2. For each fix, `./scripts/version.sh bump rc` (to `rc.2`, …) and tag again.
3. `./scripts/version.sh set 1.3.0` for the release itself. `bump patch`,
   `minor` and `major` refuse a candidate, because npm would read them
   differently for each; `bump rc` refuses a release, because npm's prerelease
   bump would make 1.3.0 into 1.3.1-rc.0.

**Nobody on a release is offered a candidate.** The `release` job publishes an
`-rc.` tag with `--prerelease --latest=false`, and both Edi's update check
(`backend/updates.py`) and the curl installer only ever read GitHub's latest
release, which is never a prerelease. A tester installs a candidate on purpose:
the release notes say how, with the installer from that release pinned to it
(`curl -fsSL …/releases/download/v1.3.0-rc.1/install.sh | EDI_VERSION=1.3.0-rc.1 bash`).
The latest release's installer may predate candidates and refuse the version.

**A tester is told about the next candidate and the release.** Running a
candidate, the update check reads GitHub's recent releases instead of the
latest one, and offers the newest release or candidate past the running one
(drafts and other tags are passed over). The update check sorts every
candidate before its release, so `1.3.0-rc.2` is told about `rc.3`, then about
`1.3.0`; once on `1.3.0` it asks only for the latest release again. On macOS
the upgrade line it shows for a candidate is the pinned one above.

**Where the version has to be numbers only**, a candidate gives its release's:

| Where | A candidate's version |
| --- | --- |
| File names of every artifact | `1.3.0-rc.1` |
| `.deb` and `.rpm` metadata (`package-linux.sh`) | `1.3.0~rc.1`: dpkg and rpm sort `~` first, so the release upgrades it, and rpm refuses `-` in Version |
| Windows version resource (`edi.spec`, `VIProductVersion` in `edi.nsi`) | `1.3.0`; the installer's display version and `DisplayVersion` say `1.3.0-rc.1` |
| macOS `CFBundleShortVersionString` / `CFBundleVersion` (`edi.spec`) | `1.3.0` |
| Edi's About box and the update check | `1.3.0-rc.1` |

The release notes leave candidates out of their range (see Changelog), so a
release's notes run from the previous release and include everything its
candidates shipped.

## Changelog

Release notes' commit list comes from `scripts/changelog.sh <range>`, where the
range is the last published non-prerelease release through the new tag.

Commits whose messages contain `[skip changelog]` or `[no changelog]`
(case-insensitive) are omitted. Chores, refactors and CI-only changes stay out
of the user-facing changelog while remaining in `git log`. Version-bump commits
(subjects matching `bump…version` or `update…version`) are also omitted
automatically. A range containing only such commits prints:

```text
- Internal changes only.
```

Both behaviours are pinned by `tests/test_changelog.py`.

## What 1.x keeps

From 1.0 the version says what an upgrade can do to a reader:

- **patch** (1.2.3 → 1.2.4): fixes only;
- **minor** (1.2 → 1.3): additions, within the rules below;
- **major** (1.x → 2.0): anything that breaks one of the promises below.

A reader can install any 1.x over any earlier 1.x and keep their documents,
their settings and the way they start Edi. Installing an older 1.x over a newer
one is not promised: nothing enforces version order, and a newer release may
have written state the older one does not know.

### Documents

What Edi reads and writes is specified in [format.md](format.md), and a 1.x
release may only add to it, in a form an earlier 1.x keeps intact ("Changing the
format" there). A commit that changes the format says so in its subject, never
carries `[skip changelog]`, and names any new built-in function, because a
document that defines the same name gets `#NAME?` errors where it had results.

### Stored state

Everything Edi keeps between runs stays readable by every later 1.x:

- the `QSettings` keys and the shape of their values: the preferences in
  `shared/edi-contract.json`, `recentFiles`, `session/paths` and
  `session/active`, `allowedImageHosts`, `approvedCode`, `updates/automatic`
  and `updates/lastCheck` ([preferences.md](preferences.md));
- the version-history store under the app-data `history/` folder
  ([history.md](history.md)).

A key or layout that has to change is migrated: the new release reads the old
form for the rest of 1.x and writes the new one. A preference's **default** may
change in a minor release, since it only applies to a reader who never set it,
and the changelog says so. A setting the reader gave up (a site allowed, code
approved) is never quietly reset by an upgrade.

### Starting and installing Edi

- `edi <file>…` opens each file in a tab; nothing else on the command line is
  promised.
- The curl installer stays at `releases/latest/download/install.sh` and keeps
  `EDI_VERSION`, `EDI_FORCE` and `EDI_SET_DEFAULT`
  ([macos-installer.md](macos-installer.md)).
- Release asset names stay as they are: the README's "Installing a release"
  lists them, and `install.sh` downloads `Edi-X.Y.Z-arm64.zip` and its
  `.sha256`. `EDI_VERSION` pins an older release, which the current installer
  fetches by name.
- Edi stays registered for `.md`, `.markdown`, `.mmd` and `.mermaid`, and an
  upgrade never changes which app the reader chose as their default.
- The platforms stay: Linux x86_64, Windows x64 and macOS on Apple Silicon.
  Dropping one is a 2.0 change. The oldest Linux a build runs on follows the
  Ubuntu LTS it is built on (glibc 2.35 on 22.04 today,
  [distribution.md](distribution.md)) and may rise in a minor release, with a
  changelog line naming the new floor.

### Not promised

These are free to change in any release, with a changelog line where a reader
would notice:

- the bridge contract, `shared/edi-contract.json`'s menu commands, bridge
  methods and error codes: the page and the shell ship together, so they only
  have to agree with each other;
- menus, toolbars, dialogs, keyboard shortcuts and the look of the page;
- the Python and TypeScript modules, and anything under `tests/` or `scripts/`.

## Release guards

- `release` refuses to run unless `$GITHUB_REF_NAME` equals
  `v$(version.sh current)`.
- `test` must be green before `release` runs.
- All platform builds must finish before `release` runs.
- `release` uses the runner's built-in `GITHUB_TOKEN` with
  `permissions: contents: write`.
- Do not replace the artifact download/enumeration with a `dist-app/...` glob;
  see the artifact-flattening note in [ci.md](ci.md).

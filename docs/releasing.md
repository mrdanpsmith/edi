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
./scripts/version.sh bump patch   # or minor / major
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

## Release guards

- `release` refuses to run unless `$GITHUB_REF_NAME` equals
  `v$(version.sh current)`.
- `test` must be green before `release` runs.
- All platform builds must finish before `release` runs.
- `release` uses the runner's built-in `GITHUB_TOKEN` with
  `permissions: contents: write`.
- Do not replace the artifact download/enumeration with a `dist-app/...` glob;
  see the artifact-flattening note in [ci.md](ci.md).
